import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  ProfileData,
  ProfileFact,
  Preferences,
  JobRequirements,
  ScoreBreakdown,
  TailoredResume,
  AuditReport,
  CoverLetter,
  ApplicationStatus,
  OutcomeStatus,
  AtsType,
  SourceType,
} from "@prowl/shared";

/*
 * Conventions (keep the schema portable to Postgres for the hosted version):
 *  - text UUID primary keys, ISO-8601 text timestamps, JSON stored as text.
 *  - every row carries user_id.
 */

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const now = () => new Date().toISOString();
const timestamps = {
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
};
const userId = () => text("user_id").notNull().default("local");

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().default(""),
  displayName: text("display_name").notNull().default(""),
  ...timestamps,
});

export const settings = sqliteTable(
  "settings",
  {
    id: id(),
    userId: userId(),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).$type<unknown>(),
    ...timestamps,
  },
  (t) => [uniqueIndex("settings_user_key").on(t.userId, t.key)],
);

export const profiles = sqliteTable(
  "profiles",
  {
    id: id(),
    userId: userId(),
    version: integer("version").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    data: text("data", { mode: "json" }).$type<ProfileData>().notNull(),
    sourceText: text("source_text").notNull().default(""),
    sourceFileName: text("source_file_name").notNull().default(""),
    baselinePdfPath: text("baseline_pdf_path"),
    baselineDocxPath: text("baseline_docx_path"),
    ...timestamps,
  },
  (t) => [index("profiles_user_active").on(t.userId, t.isActive)],
);

export const profileFacts = sqliteTable(
  "profile_facts",
  {
    id: text("id").notNull(),
    userId: userId(),
    profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ProfileFact["kind"]>().notNull(),
    text: text("text").notNull(),
    refId: text("ref_id").notNull().default(""),
    ...timestamps,
  },
  (t) => [uniqueIndex("profile_facts_pk").on(t.profileId, t.id)],
);

export const preferences = sqliteTable("preferences", {
  id: id(),
  userId: userId().unique(),
  data: text("data", { mode: "json" }).$type<Preferences>().notNull(),
  ...timestamps,
});

export const jobSources = sqliteTable("job_sources", {
  id: id(),
  userId: userId(),
  type: text("type").$type<SourceType>().notNull(),
  name: text("name").notNull(),
  /** Adapter-specific config: board token, company slug, search query, domain... */
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: text("last_run_at"),
  lastRunStatus: text("last_run_status"),
  lastRunMessage: text("last_run_message"),
  lastRunJobCount: integer("last_run_job_count"),
  ...timestamps,
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    userId: userId(),
    sourceId: text("source_id").references(() => jobSources.id, { onDelete: "set null" }),
    sourceType: text("source_type").$type<SourceType>().notNull(),
    externalId: text("external_id").notNull(),
    dedupKey: text("dedup_key").notNull(),
    title: text("title").notNull(),
    company: text("company").notNull(),
    location: text("location").notNull().default(""),
    remote: integer("remote", { mode: "boolean" }),
    salaryMin: real("salary_min"),
    salaryMax: real("salary_max"),
    descriptionText: text("description_text").notNull().default(""),
    requirements: text("requirements", { mode: "json" }).$type<JobRequirements>(),
    atsType: text("ats_type").$type<AtsType>().notNull().default("other"),
    applyUrl: text("apply_url").notNull(),
    postingUrl: text("posting_url").notNull().default(""),
    postedAt: text("posted_at"),
    firstSeenAt: text("first_seen_at").notNull().$defaultFn(now),
    lastSeenAt: text("last_seen_at").notNull().$defaultFn(now),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    processingError: text("processing_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("jobs_user_dedup").on(t.userId, t.dedupKey), index("jobs_user_seen").on(t.userId, t.lastSeenAt)],
);

export const jobMatches = sqliteTable(
  "job_matches",
  {
    id: id(),
    userId: userId(),
    jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    scoreTotal: real("score_total").notNull(),
    breakdown: text("breakdown", { mode: "json" }).$type<ScoreBreakdown>().notNull(),
    status: text("status").$type<"new" | "interested" | "ignored" | "queued">().notNull().default("new"),
    ...timestamps,
  },
  (t) => [uniqueIndex("job_matches_job_profile").on(t.jobId, t.profileId), index("job_matches_score").on(t.userId, t.scoreTotal)],
);

export const tailoredResumes = sqliteTable("tailored_resumes", {
  id: id(),
  userId: userId(),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  content: text("content", { mode: "json" }).$type<TailoredResume>().notNull(),
  keywordCoverageBefore: real("keyword_coverage_before"),
  keywordCoverageAfter: real("keyword_coverage_after"),
  keywordReport: text("keyword_report", { mode: "json" }).$type<{ keyword: string; before: boolean; after: boolean; inProfile: boolean }[]>(),
  semanticBefore: real("semantic_before"),
  semanticAfter: real("semantic_after"),
  audit: text("audit", { mode: "json" }).$type<AuditReport>(),
  auditStatus: text("audit_status").$type<"pending" | "pass" | "flagged" | "accepted">().notNull().default("pending"),
  /** Structured deterministic issues: errors vs fixed are stored separately (PR 6 / PI-07). */
  structuralErrors: text("structural_errors", { mode: "json" }).$type<{ location: string; severity: "error" | "fixed"; message: string }[]>(),
  pdfPath: text("pdf_path"),
  docxPath: text("docx_path"),
  fileName: text("file_name"),
  model: text("model"),
  ...timestamps,
});

export const coverLetters = sqliteTable("cover_letters", {
  id: id(),
  userId: userId(),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  tailoredResumeId: text("tailored_resume_id").references(() => tailoredResumes.id, { onDelete: "set null" }),
  content: text("content", { mode: "json" }).$type<CoverLetter>().notNull(),
  audit: text("audit", { mode: "json" }).$type<AuditReport>(),
  auditStatus: text("audit_status").$type<"pending" | "pass" | "flagged" | "accepted">().notNull().default("pending"),
  /** Structured deterministic issues: errors vs fixed are stored separately (PR 6 / PI-07). */
  structuralErrors: text("structural_errors", { mode: "json" }).$type<{ location: string; severity: "error" | "fixed"; message: string }[]>(),
  pdfPath: text("pdf_path"),
  fileName: text("file_name"),
  model: text("model"),
  ...timestamps,
});

export const applications = sqliteTable(
  "applications",
  {
    id: id(),
    userId: userId(),
    jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    tailoredResumeId: text("tailored_resume_id").references(() => tailoredResumes.id, { onDelete: "set null" }),
    coverLetterId: text("cover_letter_id").references(() => coverLetters.id, { onDelete: "set null" }),
    status: text("status").$type<ApplicationStatus>().notNull().default("matched"),
    outcome: text("outcome").$type<OutcomeStatus>().notNull().default("none"),
    outcomeNotes: text("outcome_notes").notNull().default(""),
    atsType: text("ats_type").$type<AtsType>().notNull().default("other"),
    applyUrl: text("apply_url").notNull().default(""),
    /** Fail-closed default: new applications are dry-run until approveApplication / submit-for-real writes false. */
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(true),
    approvedAt: text("approved_at"),
    submittedAt: text("submitted_at"),
    confirmationText: text("confirmation_text"),
    confirmationScreenshotPath: text("confirmation_screenshot_path"),
    formSnapshot: text("form_snapshot", { mode: "json" }).$type<FormSnapshot>(),
    submittedResumePath: text("submitted_resume_path"),
    submittedResumeSha256: text("submitted_resume_sha256"),
    submittedCoverLetterPath: text("submitted_cover_letter_path"),
    submittedCoverLetterSha256: text("submitted_cover_letter_sha256"),
    needsInputReason: text("needs_input_reason"),
    pendingQuestions: text("pending_questions", { mode: "json" }).$type<PendingQuestion[]>(),
    errorText: text("error_text"),
    attemptCount: integer("attempt_count").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("applications_user_job").on(t.userId, t.jobId), index("applications_status").on(t.userId, t.status)],
);

export interface FormSnapshotField {
  label: string;
  name: string;
  type: string;
  value: string;
  required: boolean;
  source: "profile" | "qa_bank" | "file" | "default" | "llm_draft" | "user";
}
export interface FormSnapshot {
  url: string;
  capturedAt: string;
  fields: FormSnapshotField[];
}
export interface PendingQuestion {
  questionKey: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  draftAnswer: string;
}

export const applicationEvents = sqliteTable(
  "application_events",
  {
    id: id(),
    userId: userId(),
    applicationId: text("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message").notNull().default(""),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    screenshotPath: text("screenshot_path"),
    at: text("at").notNull().$defaultFn(now),
  },
  (t) => [index("application_events_app").on(t.applicationId, t.at)],
);

export const qaBank = sqliteTable(
  "qa_bank",
  {
    id: id(),
    userId: userId(),
    questionKey: text("question_key").notNull(),
    questionText: text("question_text").notNull(),
    answer: text("answer").notNull(),
    answerType: text("answer_type").$type<"text" | "select" | "boolean" | "number">().notNull().default("text"),
    approved: integer("approved", { mode: "boolean" }).notNull().default(false),
    timesUsed: integer("times_used").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("qa_bank_user_key").on(t.userId, t.questionKey)],
);

export const queueTasks = sqliteTable(
  "queue_tasks",
  {
    id: id(),
    userId: userId(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"pending" | "running" | "done" | "failed" | "cancelled">().notNull().default("pending"),
    priority: integer("priority").notNull().default(100),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: text("run_after").notNull().$defaultFn(now),
    lockedBy: text("locked_by"),
    lockedAt: text("locked_at"),
    lastError: text("last_error"),
    dedupKey: text("dedup_key"),
    ...timestamps,
  },
  (t) => [index("queue_tasks_pick").on(t.status, t.runAfter, t.priority), index("queue_tasks_dedup").on(t.dedupKey, t.status)],
);

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: id(),
  userId: userId(),
  kind: text("kind").notNull(),
  status: text("status").$type<"running" | "done" | "failed">().notNull().default("running"),
  startedAt: text("started_at").notNull().$defaultFn(now),
  finishedAt: text("finished_at"),
  stats: text("stats", { mode: "json" }).$type<Record<string, number>>(),
  message: text("message"),
});

export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: id(),
    userId: userId(),
    task: text("task").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    costUsd: real("cost_usd"),
    durationMs: integer("duration_ms").notNull().default(0),
    ok: integer("ok", { mode: "boolean" }).notNull().default(true),
    error: text("error"),
    jobId: text("job_id"),
    applicationId: text("application_id"),
    at: text("at").notNull().$defaultFn(now),
  },
  (t) => [index("llm_calls_at").on(t.userId, t.at)],
);

/* ======================= Interview and source builder ====================== */

export interface InterviewMessage {
  role: "assistant" | "user";
  content: string;
  quickReplies?: string[];
  inputKind?: "text" | "choice" | "multi" | "number";
  at: string;
}

export const interviews = sqliteTable(
  "interviews",
  {
    id: id(),
    userId: userId(),
    profileId: text("profile_id").references(() => profiles.id, { onDelete: "set null" }),
    status: text("status").$type<"active" | "review" | "applied" | "abandoned">().notNull().default("active"),
    messages: text("messages", { mode: "json" }).$type<InterviewMessage[]>().notNull(),
    /** InterviewDraft from @prowl/core, stored as JSON. */
    draft: text("draft", { mode: "json" }).$type<Record<string, any>>().notNull(),
    careerSummary: text("career_summary").notNull().default(""),
    sourceRunId: text("source_run_id"),
    ...timestamps,
  },
  (t) => [index("interviews_user_status").on(t.userId, t.status)],
);

export type Interview = typeof interviews.$inferSelect;

export type SuggestionStatus = "pending" | "verified" | "unconfirmed" | "not_found" | "added" | "dismissed";

export const sourceSuggestions = sqliteTable(
  "source_suggestions",
  {
    id: id(),
    userId: userId(),
    runId: text("run_id"),
    origin: text("origin").$type<"ai" | "web_search" | "learned" | "search">().notNull(),
    company: text("company").notNull(),
    domain: text("domain").notNull().default(""),
    why: text("why").notNull().default(""),
    type: text("type").$type<SourceType>().notNull(),
    /** Adapter config for the source that would be created. */
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Stable identity for de-duplication, e.g. "greenhouse:stripe". */
    key: text("key").notNull(),
    status: text("status").$type<SuggestionStatus>().notNull().default("pending"),
    jobsOpen: integer("jobs_open"),
    jobsMatching: integer("jobs_matching"),
    sampleTitles: text("sample_titles", { mode: "json" }).$type<string[]>(),
    note: text("note"),
    ...timestamps,
  },
  (t) => [uniqueIndex("source_suggestions_user_key").on(t.userId, t.key), index("source_suggestions_status").on(t.userId, t.status)],
);

export type SourceSuggestion = typeof sourceSuggestions.$inferSelect;

/** AI calls in progress right now, from any process. Rows are removed when the call ends. */
export const aiActivity = sqliteTable("ai_activity", {
  id: id(),
  userId: userId(),
  task: text("task").notNull(),
  model: text("model").notNull(),
  effort: text("effort"),
  connectionLabel: text("connection_label").notNull().default(""),
  process: text("process").$type<"web" | "worker" | "other">().notNull(),
  pid: integer("pid").notNull(),
  jobId: text("job_id"),
  applicationId: text("application_id"),
  startedAt: text("started_at").notNull().$defaultFn(now),
});

export type AiActivity = typeof aiActivity.$inferSelect;

/* ============================ AI connections ============================ */

export type ConnectionKind = "openai-chatgpt" | "gemini-oauth" | "api-key" | "openai-compatible" | "env";
export type ConnectionSdk = "openai" | "openai-chatgpt" | "anthropic" | "google" | "openai-compatible" | "env";
export type ConnectionStatus = "untested" | "ok" | "error" | "needs_signin";

export interface ModelSelection {
  model: string;
  effort: string | null;
}

export interface ConnectionSelections {
  main: ModelSelection | null;
  fast: ModelSelection | null;
  /** Last effort chosen per model on this connection, restored when that model is picked again. */
  effortByModel: Record<string, string>;
}

export type EffortKind = "effort" | "budget" | "toggle" | "none";

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number | null;
  reasoning: boolean;
  effortKind: EffortKind;
  efforts: string[];
  defaultEffort: string | null;
  costIn: number | null;
  costOut: number | null;
  costCachedIn: number | null;
  /** The provider offers a built-in web search tool for this model. */
  webSearch?: boolean;
  /** "live" when the provider's model list returned it, "catalog" when known only from models.dev. */
  source: "live" | "catalog";
}

export const llmConnections = sqliteTable("llm_connections", {
  id: id(),
  userId: userId(),
  kind: text("kind").$type<ConnectionKind>().notNull(),
  sdk: text("sdk").$type<ConnectionSdk>().notNull(),
  catalogProviderId: text("catalog_provider_id"),
  label: text("label").notNull(),
  baseUrl: text("base_url"),
  authType: text("auth_type").$type<"oauth" | "api_key" | "none" | "env">().notNull(),
  accountLabel: text("account_label"),
  accountId: text("account_id"),
  keyHint: text("key_hint"),
  tokenExpiresAt: text("token_expires_at"),
  refreshLockUntil: text("refresh_lock_until"),
  googleProject: text("google_project"),
  googleClientId: text("google_client_id"),
  selections: text("selections", { mode: "json" }).$type<ConnectionSelections>().notNull(),
  modelsCache: text("models_cache", { mode: "json" }).$type<ModelInfo[]>(),
  modelsFetchedAt: text("models_fetched_at"),
  modelsError: text("models_error"),
  status: text("status").$type<ConnectionStatus>().notNull().default("untested"),
  lastError: text("last_error"),
  lastTestedAt: text("last_tested_at"),
  concurrency: integer("concurrency").notNull().default(2),
  ...timestamps,
});

export type LlmConnection = typeof llmConnections.$inferSelect;

export const workerHeartbeats = sqliteTable("worker_heartbeats", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  lastBeatAt: text("last_beat_at").notNull(),
  currentTask: text("current_task"),
});

export type Job = typeof jobs.$inferSelect;
export type JobSource = typeof jobSources.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type JobMatch = typeof jobMatches.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type ApplicationEvent = typeof applicationEvents.$inferSelect;
export type TailoredResumeRow = typeof tailoredResumes.$inferSelect;
export type CoverLetterRow = typeof coverLetters.$inferSelect;
export type QueueTask = typeof queueTasks.$inferSelect;
export type QaEntry = typeof qaBank.$inferSelect;
