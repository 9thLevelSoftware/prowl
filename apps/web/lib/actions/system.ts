"use server";

import { revalidatePath } from "next/cache";
import { enqueue, eq, schema as s, wipeLocalFiles } from "@prowl/db";
import { SourceType } from "@prowl/shared";
import { resetSecretsCache } from "@prowl/llm";
import { getAdapter } from "@prowl/sources";
import { db, noteDbWiped, USER, worker } from "../server";
import type { ActionResult } from "./profile";

const fail = (err: unknown) => ({ ok: false as const, error: (err as Error).message ?? String(err) });
const done = (message?: string): ActionResult => {
  revalidatePath("/", "layout");
  return { ok: true, message };
};

/* ================================ Sources =============================== */

export async function addSourceAction(type: string, config: Record<string, string>, name: string): Promise<ActionResult> {
  try {
    const t = SourceType.parse(type);
    const adapter = getAdapter(t);
    const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => String(v).trim() !== ""));
    const validated = adapter.validate(clean) as Record<string, unknown>;
    const label = name.trim() || String(validated.companyName ?? validated.boardToken ?? validated.company ?? validated.org ?? validated.what ?? validated.keywords ?? adapter.label);
    const row = db().insert(s.jobSources).values({ userId: USER, type: t, name: label, config: validated, enabled: true }).returning().get();
    enqueue(db(), "discover_source", { sourceId: row.id }, { dedupKey: `discover:${row.id}`, priority: 60, userId: USER, maxAttempts: 2 });
    return done(`Added ${label}. First run queued.`);
  } catch (err) {
    return fail(err);
  }
}

export async function toggleSourceAction(id: string, enabled: boolean): Promise<ActionResult> {
  db().update(s.jobSources).set({ enabled }).where(eq(s.jobSources.id, id)).run();
  return done();
}

export async function deleteSourceAction(id: string): Promise<ActionResult> {
  db().delete(s.jobSources).where(eq(s.jobSources.id, id)).run();
  return done("Source removed. Jobs already found are kept.");
}

export async function runSourceAction(id: string): Promise<ActionResult> {
  const queued = enqueue(db(), "discover_source", { sourceId: id }, { dedupKey: `discover:${id}`, priority: 40, userId: USER, maxAttempts: 2 });
  return done(queued ? "Run queued" : "Already running");
}

export async function runAllSourcesAction(): Promise<ActionResult> {
  enqueue(db(), "discover_all", {}, { dedupKey: "discover_all", priority: 40, userId: USER });
  return done("Discovery queued for all enabled sources");
}

export async function openBrowserLoginAction(sites: string): Promise<ActionResult> {
  try {
    await worker(`/browser/login?sites=${encodeURIComponent(sites)}`, { method: "POST" });
    return { ok: true, message: "A browser window opened. Sign in, then close the tabs. Your session is saved in the local browser profile." };
  } catch (err) {
    return fail(new Error(`The worker must be running to open the browser. ${(err as Error).message}`));
  }
}

/* =============================== Q&A bank =============================== */

export async function saveQaAction(entries: { questionKey: string; questionText: string; answer: string }[]): Promise<ActionResult> {
  try {
    let n = 0;
    for (const e of entries) {
      if (!e.answer.trim()) continue;
      db()
        .insert(s.qaBank)
        .values({ userId: USER, questionKey: e.questionKey, questionText: e.questionText, answer: e.answer.trim(), approved: true })
        .onConflictDoUpdate({ target: [s.qaBank.userId, s.qaBank.questionKey], set: { answer: e.answer.trim(), questionText: e.questionText, approved: true } })
        .run();
      n++;
    }
    return done(`Saved ${n} answer${n === 1 ? "" : "s"}`);
  } catch (err) {
    return fail(err);
  }
}

export async function deleteQaAction(id: string): Promise<ActionResult> {
  db().delete(s.qaBank).where(eq(s.qaBank.id, id)).run();
  return done("Deleted");
}

/* ================================ Settings ============================== */

export async function deleteAllDataAction(confirmation: string): Promise<ActionResult> {
  try {
    if (confirmation !== "DELETE") throw new Error('Type DELETE to confirm');
    await worker("/browser/close", { method: "POST" }).catch(() => undefined);
    // Clear rows first: the worker process may still hold the SQLite files open on Windows.
    const d = db();
    d.transaction((tx) => {
      for (const t of [s.applicationEvents, s.applications, s.coverLetters, s.tailoredResumes, s.jobMatches, s.jobs, s.jobSources, s.profileFacts, s.profiles, s.preferences, s.qaBank, s.queueTasks, s.pipelineRuns, s.llmCalls, s.llmConnections, s.settings]) {
        tx.delete(t).run();
      }
    });
    // Close this process's DB handle, then unlink sqlite/wal/shm, secrets.key, secrets.json,
    // documents, evidence, browser-profile, and the embedding-model cache (models/).
    wipeLocalFiles();
    // Drop the in-memory master key so the next secret write creates a fresh secrets.key.
    resetSecretsCache();
    // Next db() reopens + remigrates (file may have been deleted, or still exist if locked).
    noteDbWiped();
    return done("All local data deleted");
  } catch (err) {
    return fail(err);
  }
}
