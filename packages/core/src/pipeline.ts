import {
  and,
  enqueue,
  ensureApplication,
  eq,
  getActiveProfile,
  getPreferences,
  getProfileFacts,
  logApplicationEvent,
  schema as s,
  transitionApplication,
  type Db,
  type JobSource,
} from "@prowl/db";
import type { LlmClient } from "@prowl/llm";
import {
  APPLIABLE_ATS,
  canonicalUrl,
  hashString,
  logger,
  normalizeText,
  type RawJob,
} from "@prowl/shared";
import { renderCoverLetterFiles, renderResumeFiles, resolveCoverLetter, resolveTailored } from "@prowl/documents";
import { extractRequirements } from "./requirements";
import { scoreJob } from "./match";
import { auditClaims, coverLetterClaims, resumeClaims, tailorResume, writeCoverLetter, type JobContext } from "./tailor";

const log = logger("pipeline");

/* ================================ Ingest ================================ */

export function jobDedupKey(j: Pick<RawJob, "company" | "title" | "location">): string {
  return hashString(`${normalizeText(j.company)}|${normalizeText(j.title)}|${normalizeText(j.location)}`);
}

export interface IngestResult {
  total: number;
  inserted: string[];
  updated: number;
}

/** Upsert discovered jobs. When a duplicate arrives from a source we can apply through, it wins the apply URL. */
export function ingestJobs(db: Db, source: Pick<JobSource, "id" | "type" | "userId">, raws: RawJob[]): IngestResult {
  const inserted: string[] = [];
  let updated = 0;
  const now = new Date().toISOString();
  for (const r of raws) {
    if (!r.title || !r.applyUrl) continue;
    const dedupKey = jobDedupKey(r);
    const existing = db
      .select()
      .from(s.jobs)
      .where(and(eq(s.jobs.userId, source.userId), eq(s.jobs.dedupKey, dedupKey)))
      .get();
    if (existing) {
      const upgrade = APPLIABLE_ATS.includes(r.atsType) && !APPLIABLE_ATS.includes(existing.atsType);
      db.update(s.jobs)
        .set({
          lastSeenAt: now,
          isActive: true,
          ...(upgrade ? { applyUrl: canonicalUrl(r.applyUrl), atsType: r.atsType, sourceId: source.id, sourceType: source.type } : {}),
          ...(existing.descriptionText.length < r.descriptionText.length ? { descriptionText: r.descriptionText } : {}),
        })
        .where(eq(s.jobs.id, existing.id))
        .run();
      updated++;
      continue;
    }
    const row = db
      .insert(s.jobs)
      .values({
        userId: source.userId,
        sourceId: source.id,
        sourceType: source.type,
        externalId: r.externalId,
        dedupKey,
        title: r.title.trim(),
        company: r.company.trim(),
        location: r.location,
        remote: r.remote,
        salaryMin: r.salaryMin,
        salaryMax: r.salaryMax,
        descriptionText: r.descriptionText,
        atsType: r.atsType,
        applyUrl: r.applyUrl,
        postingUrl: r.postingUrl || r.applyUrl,
        postedAt: r.postedAt,
      })
      .returning({ id: s.jobs.id })
      .get();
    inserted.push(row.id);
  }
  return { total: raws.length, inserted, updated };
}

/* ============================ Match a job =============================== */

export async function processJob(db: Db, llm: LlmClient, jobId: string): Promise<{ score: number | null; queued: boolean }> {
  const job = db.select().from(s.jobs).where(eq(s.jobs.id, jobId)).get();
  if (!job) throw new Error(`Job ${jobId} not found`);
  const profile = getActiveProfile(db, job.userId);
  if (!profile) {
    log.info("no active profile yet; skipping scoring");
    return { score: null, queued: false };
  }
  let requirements = job.requirements;
  if (!requirements) {
    if (job.descriptionText.trim().length < 80) {
      db.update(s.jobs).set({ processingError: "Posting has no description to analyze" }).where(eq(s.jobs.id, job.id)).run();
      return { score: null, queued: false };
    }
    requirements = await extractRequirements(llm, job);
    db.update(s.jobs)
      .set({
        requirements,
        processingError: null,
        salaryMin: job.salaryMin ?? requirements.salaryMin,
        salaryMax: job.salaryMax ?? requirements.salaryMax,
      })
      .where(eq(s.jobs.id, job.id))
      .run();
  }
  const prefs = getPreferences(db, job.userId);
  const breakdown = await scoreJob(profile.data, prefs, { ...job, requirements });
  db.insert(s.jobMatches)
    .values({ userId: job.userId, jobId: job.id, profileId: profile.id, scoreTotal: breakdown.total, breakdown })
    .onConflictDoUpdate({ target: [s.jobMatches.jobId, s.jobMatches.profileId], set: { scoreTotal: breakdown.total, breakdown, updatedAt: new Date().toISOString() } })
    .run();

  let queued = false;
  if (!breakdown.vetoed && breakdown.total >= prefs.minMatchScore && prefs.autoTailor) {
    queued = queueTailoring(db, job.id, job.userId);
  }
  return { score: breakdown.total, queued };
}

/** Create (or reuse) the application for a job and enqueue tailoring. Returns false when already past that stage. */
export function queueTailoring(db: Db, jobId: string, userId: string, opts: { force?: boolean } = {}): boolean {
  const app = ensureApplication(db, jobId, userId);
  const restartable = ["matched", "failed", "skipped", "rejected_by_user"].includes(app.status);
  if (!restartable && !(opts.force && app.status === "ready_for_review")) return false;
  if (app.status === "skipped" || app.status === "rejected_by_user") transitionApplication(db, app.id, "matched", "Re-queued for tailoring");
  if (app.status === "failed") transitionApplication(db, app.id, "matched", "Retrying after failure");
  db.update(s.jobMatches).set({ status: "queued" }).where(eq(s.jobMatches.jobId, jobId)).run();
  enqueue(db, "tailor", { applicationId: app.id, force: !!opts.force }, { dedupKey: `tailor:${app.id}`, priority: 50, userId });
  return true;
}

/* ========================= Tailor an application ======================= */

export async function tailorApplication(db: Db, llm: LlmClient, applicationId: string, opts: { force?: boolean } = {}): Promise<void> {
  let app = db.select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
  if (!app) throw new Error(`Application ${applicationId} not found`);
  if (app.status === "ready_for_review" && opts.force) app = transitionApplication(db, app.id, "tailoring", "Re-tailoring on request");
  else if (app.status === "matched") app = transitionApplication(db, app.id, "tailoring");
  else if (app.status !== "tailoring") {
    log.info(`application ${app.id} is ${app.status}; nothing to tailor`);
    return;
  }

  const job = db.select().from(s.jobs).where(eq(s.jobs.id, app.jobId)).get();
  const profile = getActiveProfile(db, app.userId);
  if (!job || !profile) {
    transitionApplication(db, app.id, "failed", !job ? "Job no longer exists" : "No active profile", { errorText: "Missing job or profile" });
    return;
  }
  if (!job.requirements) {
    transitionApplication(db, app.id, "failed", "Job requirements have not been extracted", { errorText: "Missing requirements" });
    return;
  }
  const facts = getProfileFacts(db, profile.id);
  const prefs = getPreferences(db, app.userId);
  const jobCtx: JobContext = { ...job, requirements: job.requirements };

  try {
    logApplicationEvent(db, app.id, "tailor:start", `Tailoring resume for ${job.title}`);
    const t = await tailorResume(llm, profile.data, facts, jobCtx, { applicationId: app.id });
    const audit = await auditClaims(llm, facts, resumeClaims(profile.data, t.resume), t.issues, { jobId: job.id, applicationId: app.id, task: "audit_resume" });
    const resolved = resolveTailored(profile.data, t.resume);
    const files = await renderResumeFiles(resolved, { kind: "tailored", key: app.id, company: job.company });
    const tr = db
      .insert(s.tailoredResumes)
      .values({
        userId: app.userId,
        jobId: job.id,
        profileId: profile.id,
        content: t.resume,
        keywordCoverageBefore: t.keywordCoverageBefore,
        keywordCoverageAfter: t.keywordCoverageAfter,
        keywordReport: t.keywordReport,
        semanticBefore: t.semanticBefore,
        semanticAfter: t.semanticAfter,
        audit,
        auditStatus: audit.overall,
        structuralErrors: t.issues.map((i) => `${i.location}: ${i.message}`),
        pdfPath: files.pdfPath,
        docxPath: files.docxPath,
        fileName: files.fileName,
        model: llm.config.smartModel,
      })
      .returning()
      .get();
    logApplicationEvent(db, app.id, "tailor:resume", `Resume tailored (keywords ${t.keywordCoverageBefore}% → ${t.keywordCoverageAfter}%, audit ${audit.overall})`, {
      payload: { tailoredResumeId: tr.id, flagged: audit.items.filter((i) => i.verdict !== "entailed").length },
    });

    const { letter, issues } = await writeCoverLetter(llm, profile.data, facts, t.resume, jobCtx, prefs, { applicationId: app.id });
    const coverAudit = await auditClaims(llm, facts, coverLetterClaims(letter), issues, { jobId: job.id, applicationId: app.id, task: "audit_cover" });
    const coverFiles = await renderCoverLetterFiles(resolveCoverLetter(profile.data, letter, job), app.id);
    const cl = db
      .insert(s.coverLetters)
      .values({
        userId: app.userId,
        jobId: job.id,
        tailoredResumeId: tr.id,
        content: letter,
        audit: coverAudit,
        auditStatus: coverAudit.overall,
        pdfPath: coverFiles.pdfPath,
        fileName: coverFiles.fileName,
        model: llm.config.smartModel,
      })
      .returning()
      .get();

    transitionApplication(db, app.id, "ready_for_review", "Resume and cover letter ready for review", {
      tailoredResumeId: tr.id,
      coverLetterId: cl.id,
      errorText: null,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    log.error(`tailoring failed for ${app.id}`, err);
    transitionApplication(db, app.id, "failed", `Tailoring failed: ${msg.slice(0, 300)}`, { errorText: msg.slice(0, 4000) });
    throw err;
  }
}

/* ============================== Review ================================= */

export class ReviewBlockedError extends Error {}

/**
 * Approve an application for submission. Blocked while the audit has unresolved flags:
 * the user must edit the content (re-tailor) or explicitly accept each flagged claim.
 */
export function approveApplication(db: Db, applicationId: string, opts: { dryRun?: boolean } = {}): void {
  const app = db.select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
  if (!app) throw new Error("Application not found");
  if (app.status !== "ready_for_review" && app.status !== "needs_input" && app.status !== "failed") {
    throw new ReviewBlockedError(`Application is ${app.status}; only reviewed applications can be approved`);
  }
  const tr = app.tailoredResumeId ? db.select().from(s.tailoredResumes).where(eq(s.tailoredResumes.id, app.tailoredResumeId)).get() : undefined;
  const cl = app.coverLetterId ? db.select().from(s.coverLetters).where(eq(s.coverLetters.id, app.coverLetterId)).get() : undefined;
  if (!tr) throw new ReviewBlockedError("No tailored resume exists for this application");
  if (tr.auditStatus === "flagged") throw new ReviewBlockedError("The tailored resume has unresolved truthfulness flags");
  if (cl?.auditStatus === "flagged") throw new ReviewBlockedError("The cover letter has unresolved truthfulness flags");
  const job = db.select().from(s.jobs).where(eq(s.jobs.id, app.jobId)).get();
  const prefs = getPreferences(db, app.userId);
  const dryRun = opts.dryRun ?? prefs.dryRun;
  const appliable = !!job && APPLIABLE_ATS.includes(job.atsType);

  if (app.status === "failed") transitionApplication(db, app.id, "approved", "Re-approved after failure", { dryRun, approvedAt: new Date().toISOString() });
  else transitionApplication(db, app.id, "approved", dryRun ? "Approved (dry run: will fill but not submit)" : "Approved for submission", { dryRun, approvedAt: new Date().toISOString() });

  if (appliable) {
    enqueue(db, "apply", { applicationId: app.id }, { dedupKey: `apply:${app.id}`, priority: 80, userId: app.userId, maxAttempts: 2 });
  } else {
    transitionApplication(db, app.id, "applying", "This site cannot be applied to automatically");
    transitionApplication(db, app.id, "needs_input", "Apply manually using the link, then mark as submitted", {
      needsInputReason: `Automatic submission is not supported for ${job?.atsType ?? "this site"}. Open the posting, upload the tailored files, and mark this application as submitted.`,
    });
  }
}

/** The user reviewed the flagged claims and accepts them as accurate. Recorded in the audit trail. */
export function acceptAuditFlags(db: Db, applicationId: string, target: "resume" | "cover", note: string): void {
  const app = db.select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
  if (!app) throw new Error("Application not found");
  if (target === "resume" && app.tailoredResumeId) {
    db.update(s.tailoredResumes).set({ auditStatus: "accepted" }).where(eq(s.tailoredResumes.id, app.tailoredResumeId)).run();
  }
  if (target === "cover" && app.coverLetterId) {
    db.update(s.coverLetters).set({ auditStatus: "accepted" }).where(eq(s.coverLetters.id, app.coverLetterId)).run();
  }
  logApplicationEvent(db, app.id, "audit:accepted", `User accepted flagged ${target} claims as accurate`, { payload: { note } });
}
