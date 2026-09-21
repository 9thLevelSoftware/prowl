"use server";

import { revalidatePath } from "next/cache";
import { enqueue, eq, getActiveProfile, saveProfileVersion, schema as s, and, countPendingOrRunningTasks, PROCESSED_JOB_FANOUT_CAP } from "@prowl/db";
import { getLlm } from "@prowl/llm";
import { ProfileData } from "@prowl/shared";
import { buildFacts, draftBulletsFromNotes, draftSummary, extractProfile, normalizeProfile } from "@prowl/core";
import { extractResumeText, renderResumeFiles, resolveBaseline } from "@prowl/documents";
import { db, USER } from "../server";

export type ActionResult<T = undefined> = { ok: true; data?: T; message?: string } | { ok: false; error: string };

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: (err as Error).message ?? String(err) };
}

/** Parse an uploaded resume with the LLM and save it as a new (unconfirmed-skills) profile version. */
export async function uploadResume(formData: FormData): Promise<ActionResult> {
  try {
    const file = formData.get("resume");
    const pasted = String(formData.get("pasted") ?? "").trim();
    let text: string;
    let fileName = "pasted.txt";
    if (file instanceof File && file.size > 0) {
      if (file.size > 10 * 1024 * 1024) throw new Error("File is larger than 10 MB");
      text = await extractResumeText(file.name, new Uint8Array(await file.arrayBuffer()));
      fileName = file.name;
    } else if (pasted.length > 40) {
      text = pasted;
    } else {
      throw new Error("Choose a resume file or paste your resume text");
    }
    const data = await extractProfile(getLlm(db()), text);
    const existing = getActiveProfile(db(), USER);
    // Keep the user's private context when re-importing.
    if (existing) data.additionalContext = existing.data.additionalContext;
    saveProfileVersion(db(), { data, facts: buildFacts(data), sourceText: text, sourceFileName: fileName }, USER);
    revalidatePath("/", "layout");
    return { ok: true, message: `Imported ${data.work.length} roles and ${data.skills.length} skills. Review everything and confirm your skills.` };
  } catch (err) {
    return fail(err);
  }
}

/** Save an edited profile as a new version, rebuild the fact ledger, render the baseline, and re-score jobs. */
export async function saveProfile(json: string): Promise<ActionResult> {
  try {
    const data = normalizeProfile(ProfileData.parse(JSON.parse(json)));
    if (!data.contact.fullName.trim()) throw new Error("Your name is required");
    const facts = buildFacts(data);
    const row = saveProfileVersion(db(), { data, facts }, USER);
    let message = `Saved version ${row.version}.`;
    try {
      const files = await renderResumeFiles(resolveBaseline(data), { kind: "baseline", key: `v${row.version}` });
      db().update(s.profiles).set({ baselinePdfPath: files.pdfPath, baselineDocxPath: files.docxPath }).where(eq(s.profiles.id, row.id)).run();
    } catch (err) {
      message += ` Baseline PDF could not be rendered: ${(err as Error).message}`;
    }
    const activeJobs = db().select({ id: s.jobs.id }).from(s.jobs).where(and(eq(s.jobs.userId, USER), eq(s.jobs.isActive, true))).all();
    const alreadyQueued = countPendingOrRunningTasks(db(), "process_job");
    const budget = Math.max(0, PROCESSED_JOB_FANOUT_CAP - alreadyQueued);
    let enqueued = 0;
    for (const j of activeJobs) {
      if (enqueued >= budget) break;
      if (enqueue(db(), "process_job", { jobId: j.id }, { dedupKey: `process:${j.id}`, priority: 110, userId: USER })) enqueued++;
    }
    if (enqueued) message += ` Re-scoring ${enqueued} jobs against the new profile.`;
    revalidatePath("/", "layout");
    return { ok: true, message };
  } catch (err) {
    return fail(err);
  }
}

export async function draftBullets(input: { title: string; company: string; notes: string }): Promise<ActionResult<{ bullets: string[]; questions: string[] }>> {
  try {
    if (input.notes.trim().length < 20) throw new Error("Write a few sentences about what you did in this role first");
    return { ok: true, data: await draftBulletsFromNotes(getLlm(db()), input) };
  } catch (err) {
    return fail(err);
  }
}

export async function draftSummaryAction(json: string): Promise<ActionResult<{ headline: string; summary: string }>> {
  try {
    const data = normalizeProfile(ProfileData.parse(JSON.parse(json)));
    return { ok: true, data: await draftSummary(getLlm(db()), data) };
  } catch (err) {
    return fail(err);
  }
}

export async function activateProfileVersion(profileId: string): Promise<ActionResult> {
  try {
    const row = db().select().from(s.profiles).where(eq(s.profiles.id, profileId)).get();
    if (!row) throw new Error("Version not found");
    db().transaction((tx) => {
      tx.update(s.profiles).set({ isActive: false }).where(eq(s.profiles.userId, USER)).run();
      tx.update(s.profiles).set({ isActive: true }).where(eq(s.profiles.id, profileId)).run();
    });
    revalidatePath("/", "layout");
    return { ok: true, message: `Version ${row.version} is now active` };
  } catch (err) {
    return fail(err);
  }
}
