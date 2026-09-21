import { listActivity } from "@prowl/db";
import { CALL_TIMEOUT_MS, TASK_LABELS, WORKER_TASK_LABELS } from "@prowl/llm";
import { db, USER, workerOnline } from "@/lib/server";

export const dynamic = "force-dynamic";

export interface ActivityResponse {
  worker: { online: boolean; tasks: string[] };
  ai: { id: string; label: string; model: string; effort: string | null; connection: string; startedAt: string; where: "web" | "worker" | "other" }[];
}

/** What the system is doing right now: in-flight AI calls from any process, plus worker tasks. */
export async function GET() {
  const w = workerOnline();
  let ai: ActivityResponse["ai"] = [];
  try {
    ai = listActivity(db(), CALL_TIMEOUT_MS + 60_000, USER).map((a) => ({
      id: a.id,
      label: TASK_LABELS[a.task] ?? a.task.replace(/_/g, " "),
      model: a.model,
      effort: a.effort,
      connection: a.connectionLabel,
      startedAt: a.startedAt,
      where: a.process,
    }));
  } catch {
    /* activity table not migrated yet */
  }
  const tasks = (w.currentTask ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => WORKER_TASK_LABELS[t] ?? t.replace(/_/g, " "));
  const body: ActivityResponse = { worker: { online: w.online, tasks }, ai };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
