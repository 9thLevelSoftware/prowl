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
  recoverInterruptedApplies,
  recoverStaleTasks,
  runMigrations,
  schema as s,
  eq,
  type QueueTask,
} from "@prowl/db";
import { getLlm } from "@prowl/llm";
import { LOCAL_USER_ID, WORKER_PORT, dataDir, logger, sleep } from "@prowl/shared";
import { closeContext, openForLogin } from "@prowl/browser";
import { closeRenderer } from "@prowl/documents";
import { checkControlPost, controlCorsOrigin, resolveLoginSites } from "./control";
import { emit, subscribe } from "./events";
import { handleBuildSources } from "./sources-task";
import { RescheduleError, handleApply, handleDiscoverAll, handleDiscoverSource, handleProcessJob, handleTailor } from "./handlers";

process.env.PROWL_PROCESS = "worker";
const log = logger("worker");
const db = getDb();
runMigrations(db);
const llm = getLlm(db);

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const STARTED = new Date().toISOString();
let stopping = false;
const running = new Map<string, string>();

/*
 * Two lanes so a long browser session never blocks tailoring (executable authority:
 * these arrays — docs must not invent membership):
 *  - browser lane (1 at a time): applications only (BROWSER_TYPES)
 *  - llm lane (2 at a time): discovery/match/tailor/sources (LLM_TYPES)
 * LinkedIn/Indeed discovery is discover_source on the LLM lane; it shares the Chrome
 * profile with apply only via withBrowserLock inside those adapters — not via BROWSER_TYPES.
 */
const BROWSER_TYPES = ["apply"];
const LLM_TYPES = ["discover_all", "discover_source", "process_job", "tailor", "build_sources"];

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
    case "build_sources":
      return handleBuildSources(db, llm, task);
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
        // discover_source (LI/Indeed) runs on the LLM lane; adapters serialize with apply via withBrowserLock.
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

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function json(res: http.ServerResponse, code: number, body: unknown, origin?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const acao = controlCorsOrigin(origin);
  if (acao) headers["access-control-allow-origin"] = acao;
  res.writeHead(code, headers).end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = headerValue(req.headers.origin);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, workerId: WORKER_ID, startedAt: STARTED, dataDir: dataDir(), running: [...running.values()], queue: queueStats(db), provider: llm.config.provider, models: { main: llm.config.smartModel, mainEffort: llm.config.smartEffort, fast: llm.config.fastModel, fastEffort: llm.config.fastEffort } }, origin);
    }
    if (req.method === "GET" && url.pathname === "/events") {
      // Tight CORS: known web origins only — never `*`.
      const acao = controlCorsOrigin(origin);
      const headers: Record<string, string> = {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      };
      if (acao) headers["access-control-allow-origin"] = acao;
      res.writeHead(200, headers);
      res.write(": connected\n\n");
      const unsub = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }
    if (req.method === "POST") {
      const gate = checkControlPost({ origin, host: req.headers.host });
      if (!gate.ok) return json(res, 403, { error: gate.error }, origin);

      if (url.pathname === "/browser/login") {
        const resolved = resolveLoginSites(url.searchParams.get("sites"));
        if (!resolved.ok) return json(res, 400, { error: resolved.error }, origin);
        // openForLogin itself takes withBrowserLock (same lock as apply/discovery).
        await openForLogin(resolved.urls);
        return json(res, 200, { ok: true, opened: resolved.keys }, origin);
      }
      if (url.pathname === "/browser/close") {
        await closeContext();
        return json(res, 200, { ok: true }, origin);
      }
      if (url.pathname === "/llm/ping") {
        llm.reload();
        return json(res, 200, await llm.ping(), origin);
      }
      if (url.pathname === "/schedule/reload") {
        scheduleDiscovery();
        return json(res, 200, { ok: true }, origin);
      }
    }
    json(res, 404, { error: "not found" }, origin);
  } catch (err) {
    json(res, 500, { error: (err as Error).message }, origin);
  }
});

/* ================================ Start ================================ */

async function main() {
  // Only one worker may run per machine: it owns the control port and the browser profile.
  await new Promise<void>((resolve) => {
    server.once("error", async (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") throw err;
      const other = (await fetch(`http://127.0.0.1:${WORKER_PORT}/health`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json())
        .catch(() => null)) as { workerId?: string; startedAt?: string; dataDir?: string } | null;
      if (other?.workerId) {
        log.error(
          `Another Prowl worker is already running (${other.workerId}, started ${other.startedAt}, data: ${other.dataDir ?? "unknown"}). ` +
            `Stop it first, or end the process: taskkill /F /T /PID ${other.workerId.split("-").pop()}`,
        );
      } else {
        log.error(`Port ${WORKER_PORT} is used by another program. Free it or set PROWL_WORKER_PORT in .env.`);
      }
      process.exit(1);
    });
    server.listen(WORKER_PORT, "127.0.0.1", () => {
      log.info(`Worker control API on http://127.0.0.1:${WORKER_PORT}`);
      resolve();
    });
  });

  // Safe only once this process is known to be the sole worker (checked by claiming the port above).
  const recoveredTasks = recoverStaleTasks(db, 0);
  if (recoveredTasks) log.warn(`Recovered ${recoveredTasks} task(s) left running by a previous worker`);
  // D-01: interrupted applies never auto-resubmit. applying → needs_input/failed via
  // transitionApplication (events logged). Recovery ignores dryRun; re-approve required.
  const recoveredApps = recoverInterruptedApplies(db);
  if (recoveredApps.recovered) {
    log.warn(`Crash recovery: ${recoveredApps.recovered} interrupted apply(ies) → needs_input/failed (re-approval required)`);
  }
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
