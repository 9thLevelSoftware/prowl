"use server";

import { revalidatePath } from "next/cache";
import {
  and,
  enqueue,
  eq,
  getActiveProfile,
  getProfileFacts,
  logApplicationEvent,
  savePreferences,
  schema as s,
  transitionApplication,
} from "@prowl/db";
import { getLlm } from "@prowl/llm";
import { Preferences, OutcomeStatus, TailoredResumeOut, CoverLetterOut, type CoverLetter } from "@prowl/shared";
import {
  acceptAuditFlags,
  approveApplication,
  auditClaims,
  coverLetterClaims,
  measure,
  queueTailoring,
  residualValidateErrors,
  resumeClaims,
  toStoredStructuralIssues,
  validateCoverLetter,
  validateTailored,
} from "@prowl/core";
import { renderCoverLetterFiles, renderResumeFiles, resolveCoverLetter, resolveTailored } from "@prowl/documents";
import { db, USER, worker } from "../server";
import type { ActionResult } from "./profile";

const fail = (err: unknown) => ({ ok: false as const, error: (err as Error).message ?? String(err) });
const done = (message?: string): ActionResult => {
  revalidatePath("/", "layout");
  return { ok: true, message };
};

/* ============================== Preferences ============================== */

export async function savePreferencesAction(json: string): Promise<ActionResult> {
  try {
    const parsed = Preferences.parse(JSON.parse(json));
    const before = db().select().from(s.preferences).where(eq(s.preferences.userId, USER)).get()?.data;
    savePreferences(db(), parsed, USER);
    if (before?.discoveryIntervalHours !== parsed.discoveryIntervalHours) await worker("/schedule/reload", { method: "POST" }).catch(() => undefined);
    const jobs = db().select({ id: s.jobs.id }).from(s.jobs).where(and(eq(s.jobs.userId, USER), eq(s.jobs.isActive, true))).all();
    for (const j of jobs) enqueue(db(), "process_job", { jobId: j.id }, { dedupKey: `process:${j.id}`, priority: 110, userId: USER });
    return done(jobs.length ? `Saved. Re-scoring ${jobs.length} jobs.` : "Saved.");
  } catch (err) {
    return fail(err);
  }
}

/* ================================= Jobs ================================= */

export async function tailorJob(jobId: string): Promise<ActionResult> {
  try {
    if (!getActiveProfile(db(), USER)) throw new Error("Set up your profile first");
    const job = db().select().from(s.jobs).where(eq(s.jobs.id, jobId)).get();
    if (!job) throw new Error("Job not found");
    if (!job.requirements) {
      enqueue(db(), "process_job", { jobId }, { dedupKey: `process:${jobId}`, priority: 20, userId: USER });
    }
    const queued = queueTailoring(db(), jobId, USER);
    return done(queued ? "Queued for tailoring" : "This job is already past tailoring");
  } catch (err) {
    return fail(err);
  }
}

export async function setJobStatus(jobId: string, status: "new" | "interested" | "ignored"): Promise<ActionResult> {
  try {
    db().update(s.jobMatches).set({ status }).where(eq(s.jobMatches.jobId, jobId)).run();
    return done();
  } catch (err) {
    return fail(err);
  }
}

export async function rescoreJob(jobId: string): Promise<ActionResult> {
  db().update(s.jobs).set({ requirements: null, processingError: null }).where(eq(s.jobs.id, jobId)).run();
  enqueue(db(), "process_job", { jobId }, { dedupKey: `process:${jobId}`, priority: 20, userId: USER });
  return done("Re-analyzing this posting");
}

/* ================================ Review ================================ */

export async function approveAction(applicationId: string, dryRun: boolean): Promise<ActionResult> {
  try {
    approveApplication(db(), applicationId, { dryRun });
    return done(dryRun ? "Approved for a dry run" : "Approved for submission");
  } catch (err) {
    return fail(err);
  }
}

export async function approveManyAction(ids: string[], dryRun: boolean): Promise<ActionResult> {
  const errors: string[] = [];
  let okCount = 0;
  for (const id of ids) {
    try {
      approveApplication(db(), id, { dryRun });
      okCount++;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  revalidatePath("/", "layout");
  if (!okCount) return { ok: false, error: errors[0] ?? "Nothing approved" };
  return { ok: true, message: `Approved ${okCount}${errors.length ? `. ${errors.length} skipped: ${[...new Set(errors)].join("; ")}` : ""}` };
}

export async function acceptFlagsAction(applicationId: string, target: "resume" | "cover", note: string): Promise<ActionResult> {
  try {
    if (note.trim().length < 5) throw new Error("Add a short note explaining why the flagged claims are accurate");
    acceptAuditFlags(db(), applicationId, target, note.trim());
    return done("Flags accepted and recorded");
  } catch (err) {
    return fail(err);
  }
}

export async function retailorAction(applicationId: string): Promise<ActionResult> {
  try {
    const app = db().select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
    if (!app) throw new Error("Application not found");
    if (app.status === "ready_for_review" || app.status === "failed" || app.status === "rejected_by_user") {
      if (app.status !== "ready_for_review") transitionApplication(db(), app.id, "matched", "Re-tailor requested");
      enqueue(db(), "tailor", { applicationId, force: true }, { dedupKey: `tailor:${applicationId}`, priority: 30, userId: USER });
      return done("Re-tailoring queued");
    }
    throw new Error(`Cannot re-tailor while ${app.status}`);
  } catch (err) {
    return fail(err);
  }
}

export async function rejectAction(applicationId: string): Promise<ActionResult> {
  try {
    transitionApplication(db(), applicationId, "rejected_by_user", "Rejected during review");
    const app = db().select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
    if (app) db().update(s.jobMatches).set({ status: "ignored" }).where(eq(s.jobMatches.jobId, app.jobId)).run();
    return done("Rejected");
  } catch (err) {
    return fail(err);
  }
}

/** Save the user's manual edits to the tailored resume, then re-validate, re-audit, and re-render. */
export async function saveTailoredEdits(applicationId: string, json: string): Promise<ActionResult> {
  try {
    const app = db().select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
    if (!app?.tailoredResumeId) throw new Error("No tailored resume to edit");
    if (app.status !== "ready_for_review") throw new Error("Only resumes awaiting review can be edited");
    const tr = db().select().from(s.tailoredResumes).where(eq(s.tailoredResumes.id, app.tailoredResumeId)).get()!;
    const job = db().select().from(s.jobs).where(eq(s.jobs.id, app.jobId)).get()!;
    const profile = db().select().from(s.profiles).where(eq(s.profiles.id, tr.profileId)).get()!;
    const facts = getProfileFacts(db(), profile.id);
    const edited = TailoredResumeOut.parse(JSON.parse(json));
    const v = validateTailored(profile.data, facts, edited);
    const llm = getLlm(db());
    const audit = await auditClaims(llm, facts, resumeClaims(profile.data, v.resume), v.issues, { jobId: job.id, applicationId, task: "audit_resume_edit" });
    const metrics = job.requirements ? await measure(profile.data, v.resume, { ...job, requirements: job.requirements }) : null;
    const files = await renderResumeFiles(resolveTailored(profile.data, v.resume), { kind: "tailored", key: applicationId, company: job.company });
    const residual = residualValidateErrors(profile.data, facts, v.resume);
    db()
      .update(s.tailoredResumes)
      .set({
        content: v.resume,
        audit,
        auditStatus: audit.overall,
        structuralErrors: toStoredStructuralIssues(v.issues),
        pdfPath: files.pdfPath,
        docxPath: files.docxPath,
        ...(metrics ?? {}),
      })
      .where(eq(s.tailoredResumes.id, tr.id))
      .run();
    logApplicationEvent(db(), applicationId, "review:edited_resume", `Resume edited by user; audit ${audit.overall}`);
    const flags = audit.items.filter((i) => i.verdict !== "entailed").length;
    return done(
      residual.length
        ? `Saved with ${residual.length} validation error(s) that still block approval: ${residual.join("; ")}`
        : `Saved and re-checked: ${audit.overall === "pass" ? "no truthfulness flags" : `${flags} flag(s)`}`,
    );
  } catch (err) {
    return fail(err);
  }
}

export async function saveCoverLetterEdits(applicationId: string, json: string): Promise<ActionResult> {
  try {
    const app = db().select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
    if (!app?.coverLetterId) throw new Error("No cover letter to edit");
    if (app.status !== "ready_for_review") throw new Error("Only cover letters awaiting review can be edited");
    const cl = db().select().from(s.coverLetters).where(eq(s.coverLetters.id, app.coverLetterId)).get()!;
    const job = db().select().from(s.jobs).where(eq(s.jobs.id, app.jobId)).get()!;
    const profile = getActiveProfile(db(), USER)!;
    const facts = getProfileFacts(db(), profile.id);
    // Schema parse before validate/audit/render — parity with saveTailoredEdits + TailoredResumeOut.
    const letter = CoverLetterOut.parse(JSON.parse(json));
    const issues = validateCoverLetter(facts, letter);
    const audit = await auditClaims(getLlm(db()), facts, coverLetterClaims(letter), issues, { jobId: job.id, applicationId, task: "audit_cover_edit" });
    const files = await renderCoverLetterFiles(resolveCoverLetter(profile.data, letter, job), applicationId);
    db()
      .update(s.coverLetters)
      .set({ content: letter, audit, auditStatus: audit.overall, structuralErrors: toStoredStructuralIssues(issues), pdfPath: files.pdfPath })
      .where(eq(s.coverLetters.id, cl.id))
      .run();
    logApplicationEvent(db(), applicationId, "review:edited_cover", `Cover letter edited by user; audit ${audit.overall}`);
    const residual = issues.filter((i) => i.severity === "error").map((i) => `cover ${i.location}: ${i.message}`);
    return done(residual.length ? `Saved with ${residual.length} validation error(s) that still block approval: ${residual.join("; ")}` : `Saved and re-checked: ${audit.overall}`);
  } catch (err) {
    return fail(err);
  }
}

/* ============================== Needs input ============================= */

/** Save answers to the Q&A bank (approved) and send the application back to the applier. */
export async function answerQuestionsAction(applicationId: string, answers: { questionKey: string; label: string; answer: string }[]): Promise<ActionResult> {
  try {
    const missing = answers.filter((a) => !a.answer.trim());
    if (missing.length) throw new Error(`Answer every question: ${missing.map((m) => m.label).join("; ")}`);
    for (const a of answers) {
      db()
        .insert(s.qaBank)
        .values({ userId: USER, questionKey: a.questionKey, questionText: a.label, answer: a.answer.trim(), approved: true })
        .onConflictDoUpdate({ target: [s.qaBank.userId, s.qaBank.questionKey], set: { answer: a.answer.trim(), questionText: a.label, approved: true } })
        .run();
    }
    logApplicationEvent(db(), applicationId, "needs_input:answered", `User answered ${answers.length} question(s)`, { payload: { keys: answers.map((a) => a.questionKey) } });
    const app = db().select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
    db().update(s.applications).set({ pendingQuestions: null }).where(eq(s.applications.id, applicationId)).run();
    approveApplication(db(), applicationId, { dryRun: app?.dryRun ?? true });
    return done("Answers saved. The application is queued again.");
  } catch (err) {
    return fail(err);
  }
}

export async function submitForRealAction(applicationId: string): Promise<ActionResult> {
  try {
    approveApplication(db(), applicationId, { dryRun: false });
    return done("Queued for real submission");
  } catch (err) {
    return fail(err);
  }
}

export async function retryApplyAction(applicationId: string): Promise<ActionResult> {
  try {
    const app = db().select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
    approveApplication(db(), applicationId, { dryRun: app?.dryRun ?? true });
    return done("Queued again");
  } catch (err) {
    return fail(err);
  }
}

export async function markSubmittedManuallyAction(applicationId: string, note: string): Promise<ActionResult> {
  try {
    const app = db().select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
    if (!app) throw new Error("Application not found");
    // Walk the state machine to "applying" so the audit trail stays complete.
    const path: Record<string, ("approved" | "applying")[]> = {
      ready_for_review: ["approved", "applying"],
      failed: ["approved", "applying"],
      approved: ["applying"],
      needs_input: [],
      applying: [],
    };
    const steps = path[app.status];
    if (!steps) throw new Error(`Cannot mark a ${app.status} application as submitted`);
    for (const step of steps) transitionApplication(db(), applicationId, step, "Applying manually");
    const cur = db().select().from(s.applications).where(eq(s.applications.id, applicationId)).get()!;
    const tr = cur.tailoredResumeId ? db().select().from(s.tailoredResumes).where(eq(s.tailoredResumes.id, cur.tailoredResumeId)).get() : undefined;
    const cl = cur.coverLetterId ? db().select().from(s.coverLetters).where(eq(s.coverLetters.id, cur.coverLetterId)).get() : undefined;
    transitionApplication(db(), applicationId, "submitted", `Marked submitted manually${note ? `: ${note}` : ""}`, {
      submittedAt: new Date().toISOString(),
      dryRun: false,
      confirmationText: note || "Submitted manually by user",
      submittedResumePath: cur.submittedResumePath ?? tr?.pdfPath ?? null,
      submittedCoverLetterPath: cur.submittedCoverLetterPath ?? cl?.pdfPath ?? null,
      needsInputReason: null,
      pendingQuestions: null,
    });
    return done("Marked as submitted");
  } catch (err) {
    return fail(err);
  }
}

export async function skipApplicationAction(applicationId: string): Promise<ActionResult> {
  try {
    transitionApplication(db(), applicationId, "skipped", "Skipped by user");
    return done("Skipped");
  } catch (err) {
    return fail(err);
  }
}

/* ============================== Applications ============================ */

export async function updateOutcomeAction(applicationId: string, outcome: string, notes: string): Promise<ActionResult> {
  try {
    const o = OutcomeStatus.parse(outcome);
    db().update(s.applications).set({ outcome: o, outcomeNotes: notes }).where(eq(s.applications.id, applicationId)).run();
    logApplicationEvent(db(), applicationId, `outcome:${o}`, notes || `Outcome set to ${o}`);
    return done("Updated");
  } catch (err) {
    return fail(err);
  }
}
