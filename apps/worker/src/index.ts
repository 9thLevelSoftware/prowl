import http from "node:http";
import os from "node:os";
import { Cron } from "croner";
import {
  beat,
  claimTask,
  completeTask,
  enqueue,
  failTask,
  getDb,
  getPreferences,
  queueStats,
  recoverStaleTasks,
  runMigrations,
  schema as s,
  eq,
  type QueueTask,
} from "@jh/db";
import { getLlm } from "@jh/llm";
import { LOCAL_USER_ID, WORKER_PORT, logger, sleep } from "@jh/shared";
import { closeContext, openForLogin } from "@jh/browser";
import { closeRenderer } from "@jh/documents";
import { emit, subscribe } from "./events";
import { RescheduleError, handleApply, handleDiscoverAll, handleDiscoverSource, handleProcessJob, handleTailor } from "./handlers";

const log = logger("worker");
const db = getDb();
runMigrations(db);
const llm = getLlm(db);

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const STARTED = new Date().toISOString();
let stopping = false;
const running = new Map<string, string>();

/*
 * Two lanes so a long browser session never blocks tailoring:
 *  - browser lane (1 at a time): applications and LinkedIn/Indeed discovery
 *  - llm lane (2 at a time): everything else
 */
const BROWSER_TYPES = ["apply"];
const LLM_TYPES = ["discover_all", "discover_source", "process_job", "tailor"];

async function execute(task: QueueTask): Promise<void> {
  switch (task.type) {
    case "discover_all":
      return handleDiscoverAll(db, task);
    case "discover_source":
      return handleDiscoverSource(db, llm, task);
    case "process_job":
      return handleProcessJob(db, llm, task);
    case "tailor":
      return handleTailor(db, llm, task);
    case "apply":
      return handleApply(db, llm, task);
    default:
      throw new Error(`Unknown task type ${task.type}`);
  }
}

async function lane(name: string, types: string[], concurrency: number): Promise<void> {
  const slots = new Set<Promise<void>>();
  while (!stopping) {
    if (slots.size >= concurrency) {
      await Promise.race(slots);
      continue;
    }
    const task = claimTask(db, `${WORKER_ID}:${name}`, types);
    if (!task) {
      await sleep(1500);
      continue;
    }
    const p = (async () => {
      running.set(task.id, `${task.type}`);
      const started = Date.now();
      try {
        // LinkedIn/Indeed discovery runs in this lane but serializes with applications on the shared browser lock.
        llm.reload();
        await execute(task);
        completeTask(db, task.id);
        log.info(`${task.type} done in ${Math.round((Date.now() - started) / 1000)}s`);
      } catch (err) {
        if (err instanceof RescheduleError) {
          db.update(s.queueTasks)
            .set({ status: "pending", lockedBy: null, attempts: Math.max(0, task.attempts - 1), runAfter: err.runAfter.toISOString(), lastError: err.message })
            .where(eq(s.queueTasks.id, task.id))
            .run();
          log.info(`${task.type} rescheduled to ${err.runAfter.toLocaleString()}: ${err.message}`);
        } else {
          const msg = (err as Error).message ?? String(err);
          log.error(`${task.type} failed (attempt ${task.attempts}/${task.maxAttempts}): ${msg}`);
          // Tailoring/apply manage their own failure state; don't burn retries on deterministic failures.
          failTask(db, task, msg, { retry: task.type === "discover_source" || task.type === "process_job" });
          emit({ type: "task:failed", taskType: task.type, error: msg });
        }
      } finally {
        running.delete(task.id);
      }
    })();
    slots.add(p);
    p.finally(() => slots.delete(p));
  }
  await Promise.allSettled(slots);
}

/* ============================== Scheduler ============================== */

let discoveryCron: Cron | undefined;
function scheduleDiscovery(): void {
  const hours = getPreferences(db).discoveryIntervalHours;
  discoveryCron?.stop();
  discoveryCron = new Cron(`0 */${Math.min(23, hours)} * * *`, () => {
    enqueue(db, "discover_all", {}, { dedupKey: "discover_all", priority: 150, userId: LOCAL_USER_ID });
  });
  log.info(`Discovery scheduled every ${hours}h (next ${discoveryCron.nextRun()?.toLocaleString()})`);
}

/* ============================ Control server =========================== */

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "http://localhost:3000" }).end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, workerId: WORKER_ID, startedAt: STARTED, running: [...running.values()], queue: queueStats(db), provider: llm.config.provider, models: { main: llm.config.smartModel, mainEffort: llm.config.smartEffort, fast: llm.config.fastModel, fastEffort: llm.config.fastEffort } });
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
      res.write(": connected\n\n");
      const unsub = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/browser/login") {
      const sites = (url.searchParams.get("sites") ?? "linkedin,indeed").split(",");
      const urls = sites.map((x) => ({ linkedin: "https://www.linkedin.com/login", indeed: "https://secure.indeed.com/auth", workday: "https://www.myworkday.com", google: "https://accounts.google.com" })[x] ?? x);
      await openForLogin(urls);
      return json(res, 200, { ok: true, opened: urls });
    }
    if (req.method === "POST" && url.pathname === "/browser/close") {
      await closeContext();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/llm/ping") {
      llm.reload();
      return json(res, 200, await llm.ping());
    }
    if (req.method === "POST" && url.pathname === "/schedule/reload") {
      scheduleDiscovery();
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

/* ================================ Start ================================ */

async function main() {
  const recovered = recoverStaleTasks(db, 0);
  if (recovered) log.warn(`Recovered ${recovered} task(s) left running by a previous worker`);
  // Applications interrupted mid-apply go back to approved so they are retried.
  db.update(s.applications).set({ status: "approved" }).where(eq(s.applications.status, "applying")).run();

  server.listen(WORKER_PORT, "127.0.0.1", () => log.info(`Worker control API on http://127.0.0.1:${WORKER_PORT}`));
  scheduleDiscovery();
  const heartbeat = setInterval(() => beat(db, WORKER_ID, STARTED, [...running.values()].join(", ") || null), 5000);
  beat(db, WORKER_ID, STARTED, null);
  log.info(`AI connection: ${llm.config.provider} (main=${llm.config.smartModel || "not chosen"}${llm.config.smartEffort ? ` ${llm.config.smartEffort}` : ""}, fast=${llm.config.fastModel || "not chosen"})`);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info("Shutting down...");
    clearInterval(heartbeat);
    discoveryCron?.stop();
    server.close();
    await Promise.race([sleep(8000), Promise.allSettled([closeContext(), closeRenderer()])]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await Promise.all([lane("browser", BROWSER_TYPES, 1), lane("llm", LLM_TYPES, 2)]);
}

main().catch((err) => {
  log.error("worker crashed", err);
  process.exit(1);
});
