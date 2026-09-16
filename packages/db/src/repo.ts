import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  LOCAL_USER_ID,
  Preferences,
  canTransition,
  type ApplicationStatus,
  type ProfileData,
  type ProfileFact,
  type TaskType,
} from "@jh/shared";
import type { Db } from "./client";
import * as s from "./schema";

const nowIso = () => new Date().toISOString();

/* ============================ Settings ============================ */

export function getSetting<T>(db: Db, key: string, fallback: T, userId = LOCAL_USER_ID): T {
  const row = db.select().from(s.settings).where(and(eq(s.settings.userId, userId), eq(s.settings.key, key))).get();
  return row ? (row.value as T) : fallback;
}

export function setSetting(db: Db, key: string, value: unknown, userId = LOCAL_USER_ID): void {
  db.insert(s.settings)
    .values({ userId, key, value })
    .onConflictDoUpdate({ target: [s.settings.userId, s.settings.key], set: { value, updatedAt: nowIso() } })
    .run();
}

/* =========================== Preferences ========================== */

export function getPreferences(db: Db, userId = LOCAL_USER_ID): Preferences {
  const row = db.select().from(s.preferences).where(eq(s.preferences.userId, userId)).get();
  return Preferences.parse(row?.data ?? {});
}

export function savePreferences(db: Db, prefs: Partial<Preferences>, userId = LOCAL_USER_ID): Preferences {
  const merged = Preferences.parse({ ...getPreferences(db, userId), ...prefs });
  db.insert(s.preferences)
    .values({ userId, data: merged })
    .onConflictDoUpdate({ target: s.preferences.userId, set: { data: merged, updatedAt: nowIso() } })
    .run();
  return merged;
}

/* ============================= Profiles =========================== */

export function getActiveProfile(db: Db, userId = LOCAL_USER_ID): s.Profile | undefined {
  return db
    .select()
    .from(s.profiles)
    .where(and(eq(s.profiles.userId, userId), eq(s.profiles.isActive, true)))
    .get();
}

export function listProfiles(db: Db, userId = LOCAL_USER_ID): s.Profile[] {
  return db.select().from(s.profiles).where(eq(s.profiles.userId, userId)).orderBy(desc(s.profiles.version)).all();
}

/**
 * Saves a new immutable profile version, makes it active, and replaces its fact ledger.
 * Old versions are kept so earlier tailored resumes remain traceable to the facts they cited.
 */
export function saveProfileVersion(
  db: Db,
  input: { data: ProfileData; facts: ProfileFact[]; sourceText?: string; sourceFileName?: string },
  userId = LOCAL_USER_ID,
): s.Profile {
  return db.transaction((tx) => {
    const last = tx
      .select({ v: sql<number>`coalesce(max(${s.profiles.version}), 0)` })
      .from(s.profiles)
      .where(eq(s.profiles.userId, userId))
      .get();
    const prev = getActiveProfile(tx as unknown as Db, userId);
    tx.update(s.profiles).set({ isActive: false }).where(eq(s.profiles.userId, userId)).run();
    const row = tx
      .insert(s.profiles)
      .values({
        userId,
        version: (last?.v ?? 0) + 1,
        isActive: true,
        data: input.data,
        sourceText: input.sourceText ?? prev?.sourceText ?? "",
        sourceFileName: input.sourceFileName ?? prev?.sourceFileName ?? "",
      })
      .returning()
      .get();
    if (input.facts.length) {
      tx.insert(s.profileFacts)
        .values(input.facts.map((f) => ({ id: f.id, userId, profileId: row.id, kind: f.kind, text: f.text, refId: f.refId })))
        .run();
    }
    return row;
  });
}

export function getProfileFacts(db: Db, profileId: string): ProfileFact[] {
  return db
    .select()
    .from(s.profileFacts)
    .where(eq(s.profileFacts.profileId, profileId))
    .all()
    .map((f) => ({ id: f.id, kind: f.kind, text: f.text, refId: f.refId }));
}

/* ============================== Queue ============================= */

export interface EnqueueOptions {
  priority?: number;
  runAfter?: Date;
  dedupKey?: string;
  maxAttempts?: number;
  userId?: string;
}

/** Enqueue a task. With a dedupKey, a pending/running task with the same key suppresses the new one. */
export function enqueue(db: Db, type: TaskType, payload: Record<string, unknown>, opts: EnqueueOptions = {}): string | null {
  if (opts.dedupKey) {
    const existing = db
      .select({ id: s.queueTasks.id })
      .from(s.queueTasks)
      .where(and(eq(s.queueTasks.dedupKey, opts.dedupKey), inArray(s.queueTasks.status, ["pending", "running"])))
      .get();
    if (existing) return null;
  }
  const row = db
    .insert(s.queueTasks)
    .values({
      userId: opts.userId ?? LOCAL_USER_ID,
      type,
      payload,
      priority: opts.priority ?? 100,
      runAfter: (opts.runAfter ?? new Date()).toISOString(),
      dedupKey: opts.dedupKey ?? null,
      maxAttempts: opts.maxAttempts ?? 3,
    })
    .returning({ id: s.queueTasks.id })
    .get();
  return row.id;
}

/**
 * Atomically claim the next runnable task. SQLite serializes writers, so an UPDATE ... WHERE id = (SELECT ...)
 * inside an immediate transaction cannot double-claim.
 */
export function claimTask(db: Db, workerId: string, types?: string[]): s.QueueTask | undefined {
  const raw = db.$client;
  const typeFilter = types?.length ? `AND type IN (${types.map(() => "?").join(",")})` : "";
  const stmt = raw.prepare(
    `UPDATE queue_tasks SET status='running', locked_by=?, locked_at=?, attempts=attempts+1, updated_at=?
     WHERE id = (SELECT id FROM queue_tasks WHERE status='pending' AND run_after <= ? ${typeFilter}
                 ORDER BY priority ASC, run_after ASC LIMIT 1)
     RETURNING id`,
  );
  const ts = nowIso();
  const claimed = raw.transaction(() => stmt.get(workerId, ts, ts, ts, ...(types ?? [])) as { id: string } | undefined).immediate();
  if (!claimed) return undefined;
  return db.select().from(s.queueTasks).where(eq(s.queueTasks.id, claimed.id)).get();
}

export function completeTask(db: Db, taskId: string): void {
  db.update(s.queueTasks).set({ status: "done", lockedBy: null, lastError: null }).where(eq(s.queueTasks.id, taskId)).run();
}

export function failTask(db: Db, task: s.QueueTask, error: string, opts: { retry?: boolean } = {}): void {
  const retry = (opts.retry ?? true) && task.attempts < task.maxAttempts;
  const backoffMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, task.attempts - 1));
  db.update(s.queueTasks)
    .set({
      status: retry ? "pending" : "failed",
      lockedBy: null,
      lastError: error.slice(0, 4000),
      runAfter: retry ? new Date(Date.now() + backoffMs).toISOString() : task.runAfter,
    })
    .where(eq(s.queueTasks.id, task.id))
    .run();
}

/** Tasks left "running" by a crashed worker go back to pending. */
export function recoverStaleTasks(db: Db, olderThanMs = 15 * 60_000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const res = db
    .update(s.queueTasks)
    .set({ status: "pending", lockedBy: null })
    .where(and(eq(s.queueTasks.status, "running"), lte(s.queueTasks.lockedAt, cutoff)))
    .run();
  return res.changes;
}

export function queueStats(db: Db): Record<string, number> {
  const rows = db
    .select({ status: s.queueTasks.status, type: s.queueTasks.type, n: sql<number>`count(*)` })
    .from(s.queueTasks)
    .groupBy(s.queueTasks.status, s.queueTasks.type)
    .all();
  const out: Record<string, number> = {};
  for (const r of rows) out[`${r.type}:${r.status}`] = r.n;
  return out;
}

/* =========================== Applications ========================= */

export class InvalidTransitionError extends Error {}

export function logApplicationEvent(
  db: Db,
  applicationId: string,
  type: string,
  message = "",
  extra: { payload?: Record<string, unknown>; screenshotPath?: string } = {},
): void {
  const app = db.select({ userId: s.applications.userId }).from(s.applications).where(eq(s.applications.id, applicationId)).get();
  db.insert(s.applicationEvents)
    .values({
      applicationId,
      userId: app?.userId ?? LOCAL_USER_ID,
      type,
      message,
      payload: extra.payload ?? null,
      screenshotPath: extra.screenshotPath ?? null,
    })
    .run();
}

/** Move an application to a new status, enforcing the state machine and logging an event. */
export function transitionApplication(
  db: Db,
  applicationId: string,
  to: ApplicationStatus,
  message = "",
  patch: Partial<typeof s.applications.$inferInsert> = {},
): s.Application {
  const app = db.select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
  if (!app) throw new Error(`Application ${applicationId} not found`);
  if (!canTransition(app.status, to)) {
    throw new InvalidTransitionError(`Cannot move application from ${app.status} to ${to}`);
  }
  const updated = db
    .update(s.applications)
    .set({ ...patch, status: to })
    .where(eq(s.applications.id, applicationId))
    .returning()
    .get();
  logApplicationEvent(db, applicationId, `status:${to}`, message || `${app.status} → ${to}`, { payload: { from: app.status, to } });
  return updated;
}

export function ensureApplication(db: Db, jobId: string, userId = LOCAL_USER_ID): s.Application {
  const existing = db
    .select()
    .from(s.applications)
    .where(and(eq(s.applications.userId, userId), eq(s.applications.jobId, jobId)))
    .get();
  if (existing) return existing;
  const job = db.select().from(s.jobs).where(eq(s.jobs.id, jobId)).get();
  if (!job) throw new Error(`Job ${jobId} not found`);
  const app = db
    .insert(s.applications)
    .values({ userId, jobId, atsType: job.atsType, applyUrl: job.applyUrl, status: "matched" })
    .returning()
    .get();
  logApplicationEvent(db, app.id, "created", `Matched ${job.title} at ${job.company}`);
  return app;
}

/** Count applications actually submitted (not dry runs) since local midnight. */
export function submittedToday(db: Db, userId = LOCAL_USER_ID): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(s.applications)
    .where(
      and(
        eq(s.applications.userId, userId),
        eq(s.applications.status, "submitted"),
        eq(s.applications.dryRun, false),
        sql`${s.applications.submittedAt} >= ${start.toISOString()}`,
      ),
    )
    .get();
  return row?.n ?? 0;
}

/* ========================== AI connections ======================== */

export const ACTIVE_CONNECTION_KEY = "llm.activeConnectionId";

export function emptySelections(): s.ConnectionSelections {
  return { main: null, fast: null, effortByModel: {} };
}

export function listConnections(db: Db, userId = LOCAL_USER_ID): s.LlmConnection[] {
  return db.select().from(s.llmConnections).where(eq(s.llmConnections.userId, userId)).orderBy(asc(s.llmConnections.createdAt)).all();
}

export function getConnection(db: Db, id: string): s.LlmConnection | undefined {
  return db.select().from(s.llmConnections).where(eq(s.llmConnections.id, id)).get();
}

export function createConnection(db: Db, values: Omit<typeof s.llmConnections.$inferInsert, "selections"> & { selections?: s.ConnectionSelections }): s.LlmConnection {
  return db
    .insert(s.llmConnections)
    .values({ ...values, selections: values.selections ?? emptySelections() })
    .returning()
    .get();
}

export function updateConnection(db: Db, id: string, patch: Partial<typeof s.llmConnections.$inferInsert>): s.LlmConnection {
  const row = db.update(s.llmConnections).set(patch).where(eq(s.llmConnections.id, id)).returning().get();
  if (!row) throw new Error(`Connection ${id} not found`);
  return row;
}

export function deleteConnectionRow(db: Db, id: string, userId = LOCAL_USER_ID): void {
  db.delete(s.llmConnections).where(eq(s.llmConnections.id, id)).run();
  if (getSetting<string | null>(db, ACTIVE_CONNECTION_KEY, null, userId) === id) {
    const next = listConnections(db, userId)[0];
    setSetting(db, ACTIVE_CONNECTION_KEY, next?.id ?? null, userId);
  }
}

export function getActiveConnection(db: Db, userId = LOCAL_USER_ID): s.LlmConnection | undefined {
  const id = getSetting<string | null>(db, ACTIVE_CONNECTION_KEY, null, userId);
  return (id ? getConnection(db, id) : undefined) ?? listConnections(db, userId)[0];
}

export function setActiveConnection(db: Db, id: string, userId = LOCAL_USER_ID): void {
  if (!getConnection(db, id)) throw new Error("Connection not found");
  setSetting(db, ACTIVE_CONNECTION_KEY, id, userId);
}

/**
 * Save the model and effort for one slot. The effort is also remembered per model, so picking
 * the same model again later (on this connection) restores it.
 */
export function saveSelection(db: Db, id: string, slot: "main" | "fast", model: string, effort: string | null): s.ConnectionSelections {
  const conn = getConnection(db, id);
  if (!conn) throw new Error("Connection not found");
  const current = { ...emptySelections(), ...conn.selections };
  const next: s.ConnectionSelections = {
    ...current,
    [slot]: { model, effort },
    effortByModel: { ...current.effortByModel, ...(effort ? { [model]: effort } : {}) },
  };
  updateConnection(db, id, { selections: next });
  return next;
}

/**
 * Cross-process lock for OAuth token refresh. Refresh tokens can be single-use, so the web app
 * and the worker must never refresh the same connection at the same moment.
 */
export function tryLockRefresh(db: Db, id: string, ms = 30_000): boolean {
  const now = new Date().toISOString();
  const until = new Date(Date.now() + ms).toISOString();
  const res = db
    .update(s.llmConnections)
    .set({ refreshLockUntil: until })
    .where(and(eq(s.llmConnections.id, id), sql`(${s.llmConnections.refreshLockUntil} is null or ${s.llmConnections.refreshLockUntil} < ${now})`))
    .run();
  return res.changes === 1;
}

export function unlockRefresh(db: Db, id: string): void {
  db.update(s.llmConnections).set({ refreshLockUntil: null }).where(eq(s.llmConnections.id, id)).run();
}

/* ============================ AI activity ========================= */

export function startActivity(db: Db, values: Omit<typeof s.aiActivity.$inferInsert, "pid"> & { pid?: number }): string {
  const row = db
    .insert(s.aiActivity)
    .values({ ...values, pid: values.pid ?? process.pid })
    .returning({ id: s.aiActivity.id })
    .get();
  return row.id;
}

export function endActivity(db: Db, id: string): void {
  db.delete(s.aiActivity).where(eq(s.aiActivity.id, id)).run();
}

/**
 * Calls in progress. Rows left behind by a crashed or restarted process are ignored after
 * `maxAgeMs` (the AI call timeout) and removed.
 */
export function listActivity(db: Db, maxAgeMs: number, userId = LOCAL_USER_ID): s.AiActivity[] {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  db.delete(s.aiActivity).where(lte(s.aiActivity.startedAt, cutoff)).run();
  return db.select().from(s.aiActivity).where(eq(s.aiActivity.userId, userId)).orderBy(asc(s.aiActivity.startedAt)).all();
}

/** On process start, drop rows from a previous run of the same process type. */
export function clearOrphanActivity(db: Db, processKind: "web" | "worker" | "other"): void {
  db.delete(s.aiActivity)
    .where(and(eq(s.aiActivity.process, processKind), sql`${s.aiActivity.pid} != ${process.pid}`))
    .run();
}

/* ============================== Misc ============================== */

export function beat(db: Db, workerId: string, startedAt: string, currentTask: string | null): void {
  db.insert(s.workerHeartbeats)
    .values({ id: workerId, startedAt, lastBeatAt: nowIso(), currentTask })
    .onConflictDoUpdate({ target: s.workerHeartbeats.id, set: { lastBeatAt: nowIso(), currentTask } })
    .run();
}

export function latestHeartbeat(db: Db) {
  return db.select().from(s.workerHeartbeats).orderBy(desc(s.workerHeartbeats.lastBeatAt)).limit(1).get();
}

export { asc, desc, eq, ne, and, or, inArray, sql, gte, lte, gt, lt, like, isNull, isNotNull } from "drizzle-orm";
