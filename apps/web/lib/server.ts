import "server-only";
import path from "node:path";
import { getDb, runMigrations, latestHeartbeat, schema as s, sql, eq, and, type Db } from "@prowl/db";
import { LOCAL_USER_ID, WORKER_URL, dataDir } from "@prowl/shared";

// Module-level (not global) so a hot reload with new migrations applies them.
let migrated = false;

/** DB handle for server components and actions. Migrations run once per process. */
export function db(): Db {
  const d = getDb();
  if (!migrated) {
    runMigrations(d);
    migrated = true;
  }
  return d;
}

export const USER = LOCAL_USER_ID;

export async function worker<T = unknown>(pathname: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = process.env.PROWL_WORKER_TOKEN?.trim();
  if (token) headers.set("x-prowl-worker-token", token);
  const res = await fetch(`${WORKER_URL}${pathname}`, { ...init, headers, cache: "no-store", signal: AbortSignal.timeout(60_000) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Worker returned ${res.status}`);
  return body;
}

export function workerOnline(): { online: boolean; lastBeatAt: string | null; currentTask: string | null } {
  const hb = latestHeartbeat(db());
  const online = !!hb && Date.now() - new Date(hb.lastBeatAt).getTime() < 20_000;
  return { online, lastBeatAt: hb?.lastBeatAt ?? null, currentTask: hb?.currentTask ?? null };
}

/** After wipeLocalFiles() unlinks the SQLite file, force the next db() call to re-migrate. */
export function noteDbWiped(): void {
  migrated = false;
}

export function navCounts() {
  const rows = db()
    .select({ status: s.applications.status, n: sql<number>`count(*)` })
    .from(s.applications)
    .where(eq(s.applications.userId, USER))
    .groupBy(s.applications.status)
    .all();
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  const newJobs = db()
    .select({ n: sql<number>`count(*)` })
    .from(s.jobMatches)
    .where(and(eq(s.jobMatches.userId, USER), eq(s.jobMatches.status, "new")))
    .get();
  const suggestions = db()
    .select({ n: sql<number>`count(*)` })
    .from(s.sourceSuggestions)
    .where(and(eq(s.sourceSuggestions.userId, USER), eq(s.sourceSuggestions.status, "verified"), sql`coalesce(${s.sourceSuggestions.jobsMatching}, 1) > 0`))
    .get();
  return { review: by.ready_for_review ?? 0, needsInput: by.needs_input ?? 0, jobs: newJobs?.n ?? 0, suggestions: suggestions?.n ?? 0 };
}

/** Resolve a stored path for download, refusing anything outside the data directory. */
export function safeDataFile(p: string): string | null {
  const root = path.resolve(dataDir());
  const abs = path.resolve(path.isAbsolute(p) ? p : path.join(root, p));
  return abs.startsWith(root + path.sep) ? abs : null;
}

export function fileUrl(p: string | null | undefined, download = false): string | null {
  if (!p) return null;
  return `/api/files?p=${encodeURIComponent(p)}${download ? "&download=1" : ""}`;
}
