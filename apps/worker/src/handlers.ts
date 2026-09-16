import {
  and,
  enqueue,
  eq,
  getActiveProfile,
  getPreferences,
  getProfileFacts,
  logApplicationEvent,
  schema as s,
  sql,
  submittedToday,
  transitionApplication,
  type Db,
  type QueueTask,
} from "@jh/db";
import type { LlmClient } from "@jh/llm";
import { APPLIABLE_ATS, logger, randomBetween, type SourceType } from "@jh/shared";
import { ingestJobs, processJob, tailorApplication } from "@jh/core";
import { Firecrawl, getAdapter, prefilter } from "@jh/sources";
import { suggestLearnedBoards } from "./sources-task";
import { applyOnPage, type ApplyOutcome } from "@jh/applier";
import { newPage, withBrowserLock } from "@jh/browser";
import { emit } from "./events";

const log = logger("worker");

export class RescheduleError extends Error {
  constructor(
    message: string,
    readonly runAfter: Date,
  ) {
    super(message);
  }
}

/* ============================== Discovery ============================== */

export async function handleDiscoverAll(db: Db, task: QueueTask): Promise<void> {
  const sources = db.select().from(s.jobSources).where(and(eq(s.jobSources.userId, task.userId), eq(s.jobSources.enabled, true))).all();
  for (const src of sources) {
    enqueue(db, "discover_source", { sourceId: src.id }, { dedupKey: `discover:${src.id}`, priority: 120, userId: task.userId, maxAttempts: 2 });
  }
  emit({ type: "discovery:queued", count: sources.length });
}

export async function handleDiscoverSource(db: Db, llm: LlmClient, task: QueueTask): Promise<void> {
  const sourceId = String(task.payload.sourceId);
  const src = db.select().from(s.jobSources).where(eq(s.jobSources.id, sourceId)).get();
  if (!src) return;
  const adapter = getAdapter(src.type);
  const prefs = getPreferences(db, src.userId);
  const run = db.insert(s.pipelineRuns).values({ userId: src.userId, kind: `discover:${src.type}`, message: src.name }).returning().get();
  const progress = (msg: string) => {
    log.info(`[${src.name}] ${msg}`);
    emit({ type: "discovery:progress", sourceId, message: msg });
  };
  try {
    const cfg = adapter.validate(src.config);
    const firecrawl = await Firecrawl.fromSettings(db).catch(() => null);
    const result = await adapter.discover(cfg, { prefs, llm, progress, firecrawl });
    const kept = prefilter(result.jobs, prefs);
    const ingest = ingestJobs(db, src, kept);
    // Company boards behind aggregator and career-page jobs become source suggestions.
    if (!["greenhouse", "lever", "ashby"].includes(src.type)) {
      const learned = suggestLearnedBoards(db, src.userId, src.name, kept);
      if (learned) emit({ type: "sources:learned", count: learned });
    }

    let added = 0;
    for (const d of result.discoveredSources ?? []) {
      const exists = db
        .select({ id: s.jobSources.id })
        .from(s.jobSources)
        .where(and(eq(s.jobSources.userId, src.userId), eq(s.jobSources.type, d.type), sql`json_extract(${s.jobSources.config}, '$') = json(${JSON.stringify(d.config)})`))
        .get();
      if (!exists) {
        db.insert(s.jobSources).values({ userId: src.userId, type: d.type as SourceType, name: d.name, config: d.config }).run();
        added++;
      }
    }
    for (const jobId of ingest.inserted) {
      enqueue(db, "process_job", { jobId }, { dedupKey: `process:${jobId}`, priority: 100, userId: src.userId });
    }
    const message = `${result.jobs.length} found, ${kept.length} matched your titles/keywords, ${ingest.inserted.length} new${added ? `, ${added} new board source(s) added` : ""}${result.notes?.length ? `. ${result.notes.join(". ")}` : ""}`;
    db.update(s.jobSources)
      .set({ lastRunAt: new Date().toISOString(), lastRunStatus: "ok", lastRunMessage: message, lastRunJobCount: kept.length })
      .where(eq(s.jobSources.id, src.id))
      .run();
    db.update(s.pipelineRuns)
      .set({ status: "done", finishedAt: new Date().toISOString(), stats: { found: result.jobs.length, kept: kept.length, inserted: ingest.inserted.length, updated: ingest.updated }, message })
      .where(eq(s.pipelineRuns.id, run.id))
      .run();
    emit({ type: "discovery:done", sourceId, message });
  } catch (err) {
    const message = (err as Error).message;
    db.update(s.jobSources).set({ lastRunAt: new Date().toISOString(), lastRunStatus: "error", lastRunMessage: message }).where(eq(s.jobSources.id, src.id)).run();
    db.update(s.pipelineRuns).set({ status: "failed", finishedAt: new Date().toISOString(), message }).where(eq(s.pipelineRuns.id, run.id)).run();
    emit({ type: "discovery:error", sourceId, message });
    throw err;
  }
}

/* =========================== Match and tailor ========================== */

export async function handleProcessJob(db: Db, llm: LlmClient, task: QueueTask): Promise<void> {
  const jobId = String(task.payload.jobId);
  try {
    const r = await processJob(db, llm, jobId);
    emit({ type: "job:scored", jobId, score: r.score, queued: r.queued });
  } catch (err) {
    db.update(s.jobs).set({ processingError: (err as Error).message.slice(0, 1000) }).where(eq(s.jobs.id, jobId)).run();
    throw err;
  }
}

export async function handleTailor(db: Db, llm: LlmClient, task: QueueTask): Promise<void> {
  const applicationId = String(task.payload.applicationId);
  emit({ type: "application:tailoring", applicationId });
  await tailorApplication(db, llm, applicationId, { force: !!task.payload.force });
  emit({ type: "application:updated", applicationId });
}

/* ================================ Apply ================================ */

function nextMorning(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, randomBetween(0, 45), 0, 0);
  return d;
}

export async function handleApply(db: Db, llm: LlmClient, task: QueueTask): Promise<void> {
  const applicationId = String(task.payload.applicationId);
  const app = db.select().from(s.applications).where(eq(s.applications.id, applicationId)).get();
  if (!app || app.status !== "approved") return;
  const prefs = getPreferences(db, app.userId);

  if (!app.dryRun) {
    if (submittedToday(db, app.userId) >= prefs.dailyApplyCap) {
      throw new RescheduleError(`Daily cap of ${prefs.dailyApplyCap} reached`, nextMorning());
    }
    const last = db
      .select({ at: sql<string | null>`max(${s.applications.submittedAt})` })
      .from(s.applications)
      .where(and(eq(s.applications.userId, app.userId), eq(s.applications.dryRun, false)))
      .get();
    if (last?.at) {
      const earliest = new Date(last.at).getTime() + randomBetween(prefs.applyDelaySecondsMin, prefs.applyDelaySecondsMax) * 1000;
      if (earliest > Date.now()) throw new RescheduleError("Spacing out submissions", new Date(earliest));
    }
  }

  const job = db.select().from(s.jobs).where(eq(s.jobs.id, app.jobId)).get();
  const tr = app.tailoredResumeId ? db.select().from(s.tailoredResumes).where(eq(s.tailoredResumes.id, app.tailoredResumeId)).get() : undefined;
  const cl = app.coverLetterId ? db.select().from(s.coverLetters).where(eq(s.coverLetters.id, app.coverLetterId)).get() : undefined;
  const profile = getActiveProfile(db, app.userId);
  if (!job || !tr?.pdfPath || !profile) {
    transitionApplication(db, app.id, "applying");
    transitionApplication(db, app.id, "failed", "Missing job, tailored resume, or profile", { errorText: "Missing inputs" });
    return;
  }
  if (!APPLIABLE_ATS.includes(job.atsType)) {
    transitionApplication(db, app.id, "applying");
    transitionApplication(db, app.id, "needs_input", "Manual application required", { needsInputReason: `Automatic submission is not supported for ${job.atsType}.` });
    return;
  }

  transitionApplication(db, app.id, "applying", app.dryRun ? "Filling the form (dry run)" : "Submitting application", { attemptCount: app.attemptCount + 1 });
  emit({ type: "application:applying", applicationId });

  const qa = db
    .select()
    .from(s.qaBank)
    .where(eq(s.qaBank.userId, app.userId))
    .all()
    .map((q) => ({ questionKey: q.questionKey, questionText: q.questionText, answer: q.answer, approved: q.approved }));
  const coverText = cl ? [cl.content.greeting, ...cl.content.paragraphs.map((p) => p.text), cl.content.closing, cl.content.signature].join("\n\n") : null;

  let keepOpen = false;
  const outcome: ApplyOutcome = await withBrowserLock(async () => {
    const page = await newPage({ headless: prefs.headlessBrowser });
    try {
      const o = await applyOnPage(page, llm, {
        applicationId: app.id,
        applyUrl: job.applyUrl,
        atsType: job.atsType,
        dryRun: app.dryRun,
        answers: {
          profile: profile.data,
          facts: getProfileFacts(db, profile.id),
          prefs,
          qa,
          job,
          resumePath: tr.pdfPath!,
          coverLetterPath: cl?.pdfPath ?? null,
          coverLetterText: coverText,
        },
        overrides: {},
        visionCheck: true,
        allowGenericSubmit: false,
      });
      keepOpen = o.kind === "needs_input" && o.keepPageOpen && !prefs.headlessBrowser;
      return o;
    } finally {
      if (!keepOpen) await page.close().catch(() => undefined);
    }
  });

  for (const shot of outcome.evidence.screenshots) {
    logApplicationEvent(db, app.id, `screenshot:${shot.label}`, shot.label, { screenshotPath: shot.path });
  }
  logApplicationEvent(db, app.id, "apply:log", outcome.evidence.log.join("\n"));
  const snapshot = { url: outcome.evidence.url, capturedAt: new Date().toISOString(), fields: outcome.evidence.fields };
  const files = {
    submittedResumePath: tr.pdfPath,
    submittedResumeSha256: outcome.evidence.resumeSha256,
    submittedCoverLetterPath: cl?.pdfPath ?? null,
    submittedCoverLetterSha256: outcome.evidence.coverLetterSha256,
  };
  const lastShot = outcome.evidence.screenshots.at(-1)?.path ?? null;

  switch (outcome.kind) {
    case "submitted":
      transitionApplication(db, app.id, "submitted", "Application submitted", {
        submittedAt: new Date().toISOString(),
        confirmationText: outcome.confirmationText.slice(0, 4000),
        confirmationScreenshotPath: lastShot,
        formSnapshot: snapshot,
        pendingQuestions: null,
        needsInputReason: null,
        errorText: null,
        ...files,
      });
      for (const f of outcome.evidence.fields.filter((x) => x.source === "qa_bank")) {
        db.update(s.qaBank).set({ timesUsed: sql`${s.qaBank.timesUsed} + 1` }).where(and(eq(s.qaBank.userId, app.userId), eq(s.qaBank.questionText, f.label))).run();
      }
      break;
    case "dry_run_complete":
      transitionApplication(db, app.id, "needs_input", "Dry run finished: the form was filled but not submitted", {
        needsInputReason: "Dry run complete. Review the filled-form screenshot and field values, then choose Submit for real.",
        formSnapshot: snapshot,
        confirmationScreenshotPath: lastShot,
        pendingQuestions: null,
        ...files,
      });
      break;
    case "needs_input": {
      for (const p of outcome.pending) {
        db.insert(s.qaBank)
          .values({ userId: app.userId, questionKey: p.questionKey, questionText: p.label, answer: p.value, answerType: p.options.length ? "select" : "text", approved: false })
          .onConflictDoUpdate({ target: [s.qaBank.userId, s.qaBank.questionKey], set: { questionText: p.label, answer: sql`CASE WHEN ${s.qaBank.approved} THEN ${s.qaBank.answer} ELSE ${p.value} END` } })
          .run();
      }
      transitionApplication(db, app.id, "needs_input", outcome.reason, {
        needsInputReason: outcome.reason,
        formSnapshot: snapshot,
        pendingQuestions: outcome.pending.map((p) => ({ questionKey: p.questionKey, label: p.label, type: p.type, options: p.options, required: p.required, draftAnswer: p.value })),
        ...files,
      });
      break;
    }
    case "failed":
      transitionApplication(db, app.id, "failed", outcome.error, { errorText: outcome.error, formSnapshot: snapshot });
      break;
  }
  emit({ type: "application:updated", applicationId, status: outcome.kind });
}
