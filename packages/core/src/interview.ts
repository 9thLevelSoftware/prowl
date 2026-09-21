import crypto from "node:crypto";
import { z } from "zod";
import {
  eq,
  getActiveProfile,
  getInterview,
  getOpenInterview,
  getPreferences,
  schema as s,
  updateInterview,
  type Db,
  type Interview,
  type InterviewMessage,
} from "@prowl/db";
import type { LlmClient } from "@prowl/llm";
import { COMMON_QUESTIONS } from "@prowl/applier/qa-seed";
import { LOCAL_USER_ID, Preferences, RemotePolicy, Seniority, normalizeText, usableKeywords, type ProfileData } from "@prowl/shared";
import { buildFacts, factsToPrompt, yearsOfExperience } from "./profile";

/* ================================== Topics ================================= */

export const TOPICS = [
  { key: "roles", label: "Target roles", required: true },
  { key: "seniority", label: "Seniority and scope", required: true },
  { key: "industries", label: "Industries and companies", required: false },
  { key: "location", label: "Location and remote work", required: true },
  { key: "compensation", label: "Compensation", required: true },
  { key: "authorization", label: "Work authorization", required: true },
  { key: "sponsorship", label: "Visa sponsorship", required: true },
  { key: "start", label: "Start date", required: false },
  { key: "company_type", label: "Company size and stage", required: false },
  { key: "dealbreakers", label: "Dealbreakers", required: false },
  { key: "pace", label: "Application pace", required: false },
  { key: "screening", label: "Screening defaults", required: false },
] as const;

export type TopicKey = (typeof TOPICS)[number]["key"];
const TOPIC_KEYS = TOPICS.map((t) => t.key) as [TopicKey, ...TopicKey[]];
export const REQUIRED_TOPICS = TOPICS.filter((t) => t.required).map((t) => t.key);

/* ================================== Draft ================================== */

export const ScreeningAnswer = z.object({ questionKey: z.string(), questionText: z.string(), answer: z.string(), evidence: z.string() });
export const ProfileAddition = z.object({
  id: z.string(),
  kind: z.enum(["skill", "bullet", "certification", "context"]),
  text: z.string(),
  workId: z.string().nullable(),
  evidence: z.string(),
});
export const CompanyHintsSchema = z.object({
  pursue: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  industries: z.array(z.string()).default([]),
  stageOrSize: z.array(z.string()).default([]),
});

export const InterviewDraft = z.object({
  preferences: Preferences.partial().default({}),
  screeningAnswers: z.array(ScreeningAnswer).default([]),
  profileAdditions: z.array(ProfileAddition).default([]),
  companyHints: CompanyHintsSchema.default({ pursue: [], avoid: [], industries: [], stageOrSize: [] }),
  dealbreakers: z.array(z.string()).default([]),
  startDate: z.string().default(""),
  coverage: z.record(z.string(), z.enum(["open", "covered", "skipped"])).default({}),
});
export type InterviewDraft = z.infer<typeof InterviewDraft>;
export type ScreeningAnswer = z.infer<typeof ScreeningAnswer>;
export type ProfileAddition = z.infer<typeof ProfileAddition>;

export function emptyDraft(): InterviewDraft {
  return InterviewDraft.parse({ coverage: Object.fromEntries(TOPIC_KEYS.map((k) => [k, "open"])) });
}

/* ============================ Model output schemas ========================= */

// Every field is in the schema and null means "no change". Models sometimes omit null fields, so they default to null.
const PrefPatchOut = z.object({
  targetTitles: z.array(z.string()).nullable().default(null),
  locations: z.array(z.string()).nullable().default(null),
  remotePolicy: RemotePolicy.nullable().default(null),
  salaryFloor: z.number().nullable().describe("Annual base salary floor as a number, e.g. 180000").default(null),
  seniority: z.array(Seniority).nullable().default(null),
  industriesInclude: z.array(z.string()).nullable().default(null),
  industriesExclude: z.array(z.string()).nullable().default(null),
  companyExclude: z.array(z.string()).nullable().default(null),
  workAuthorization: z.string().nullable().default(null),
  requiresSponsorship: z.boolean().nullable().default(null),
  dailyApplyCap: z.number().nullable().default(null),
  dryRun: z.boolean().nullable().default(null),
});

// Hint lists are low stakes, so a list the model leaves out becomes empty instead of failing the turn.
const HintsOut = z.object({
  pursue: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  industries: z.array(z.string()).default([]),
  stageOrSize: z.array(z.string()).default([]),
});

const AskOut = {
  message: z.string().describe("Your next message: brief acknowledgement plus exactly one clear question"),
  quickReplies: z.array(z.string()).describe("2-5 short likely answers the candidate can tap; empty for open-ended questions"),
  inputKind: z.enum(["text", "choice", "multi", "number"]),
};

const AnalyzeOut = z.object({
  careerSummary: z.string().describe("2-3 sentences on the candidate's career arc, seniority, and domain, grounded in the facts"),
  preferences: PrefPatchOut.describe("Reasonable starting guesses inferred from the resume, to be confirmed in the interview"),
  ...AskOut,
});

const TurnOut = z.object({
  preferences: PrefPatchOut,
  screeningAnswers: z.array(ScreeningAnswer).default([]).describe("Only answers the candidate stated. evidence = their exact words."),
  profileAdditions: z
    .array(z.object({ kind: ProfileAddition.shape.kind, text: z.string(), workId: z.string().nullable(), evidence: z.string() }))
    .default([])
    .describe("Skills, accomplishments, or certifications the candidate mentioned that are NOT in their facts. evidence = their exact words."),
  companyHints: HintsOut,
  dealbreakers: z.array(z.string()).default([]),
  startDate: z.string().nullable().default(null),
  coverage: z
    .array(z.object({ topic: z.enum(TOPIC_KEYS), status: z.enum(["covered", "skipped"]) }))
    .default([])
    .describe("Only topics the latest answer covered, or that the candidate explicitly declined. Leave out topics not discussed yet."),
  done: z.boolean().describe("True only when every required topic is covered and nothing important is unclear"),
  ...AskOut,
});

const SummaryOut = z.object({
  preferences: PrefPatchOut,
  keywords: z.array(z.string()).default([]).describe("0-6 distinctive words or short phrases that identify relevant job titles on their own, e.g. 'product management', 'payments product'. Never a bare level or role word such as 'head', 'vp', 'senior', or 'manager'."),
  screeningAnswers: z.array(ScreeningAnswer).default([]),
  companyHints: HintsOut,
});

type LlmLike = Pick<LlmClient, "object">;

/* ============================ Deterministic merge ========================== */

function userText(messages: InterviewMessage[]): string {
  return normalizeText(messages.filter((m) => m.role === "user").map((m) => m.content).join(" \n "));
}

/** Evidence must be words the candidate actually wrote (case and punctuation ignored). */
export function hasEvidence(evidence: string, messages: InterviewMessage[]): boolean {
  const e = normalizeText(evidence);
  return e.length >= 2 && userText(messages).includes(e);
}

/** The candidate explicitly declined a question (the Skip button sends "I'd rather skip this question."). */
const SKIP_RE = /\b(skip|rather not|prefer not|decline|pass on|don'?t want to (say|share|answer)|not comfortable|no comment)\b/i;
/** The candidate says they have nothing more to add. */
const DONE_RE = /\b(that'?s (all|everything|it)|nothing (else|more)|i'?m (done|finished)|all set|let'?s (wrap|finish))\b/i;

const STOP_WORDS = new Set(["a", "an", "the", "our", "my", "we", "i", "to", "of", "and", "for", "in", "on", "with"]);
function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w && !STOP_WORDS.has(w)));
}
/** True when two additions say the same thing in slightly different words. */
export function nearDuplicate(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared) >= 0.75;
}

const CATEGORY_RE = /\b(companies|company|firms?|startups?|businesses|industry|industries|sector|space)\b/i;
/** "crypto companies" is an industry to exclude, not an employer name. */
export function splitAvoidList(avoid: string[]): { companies: string[]; industries: string[] } {
  const companies: string[] = [];
  const industries: string[] = [];
  for (const raw of avoid) {
    const item = raw.trim();
    if (!item) continue;
    if (CATEGORY_RE.test(item)) {
      const name = item.replace(new RegExp(CATEGORY_RE.source, "gi"), "").replace(/\s+/g, " ").trim();
      if (name) industries.push(name.charAt(0).toUpperCase() + name.slice(1));
    } else companies.push(item);
  }
  return { companies, industries };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.map((x) => x.trim()).filter((x) => {
    const k = x.toLowerCase();
    if (!x || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Apply a preference patch, validating every field; invalid values are dropped rather than guessed. */
export function applyPreferencePatch(current: InterviewDraft["preferences"], patch: z.infer<typeof PrefPatchOut>): InterviewDraft["preferences"] {
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) continue;
    const field = (Preferences.shape as Record<string, z.ZodType>)[k];
    if (!field) continue;
    let value: unknown = v;
    if (k === "salaryFloor" || k === "dailyApplyCap") value = Math.round(Number(v));
    if (Array.isArray(value)) value = dedupe(value as string[]);
    const parsed = field.safeParse(value);
    if (parsed.success) next[k] = parsed.data;
  }
  return next as InterviewDraft["preferences"];
}

export interface TurnApplyResult {
  draft: InterviewDraft;
  rejected: string[];
}

export function mergeTurn(draft: InterviewDraft, out: z.infer<typeof TurnOut>, messages: InterviewMessage[], profile: ProfileData): TurnApplyResult {
  const rejected: string[] = [];
  const next: InterviewDraft = structuredClone(draft);
  next.preferences = applyPreferencePatch(next.preferences, out.preferences);

  for (const a of out.screeningAnswers) {
    if (!a.answer.trim() || !hasEvidence(a.evidence, messages)) {
      rejected.push(`screening answer "${a.questionText}" had no supporting words from you`);
      continue;
    }
    next.screeningAnswers = [...next.screeningAnswers.filter((x) => x.questionKey !== a.questionKey), a];
  }

  const workIds = new Set(profile.work.map((w) => w.id));
  for (const a of out.profileAdditions) {
    if (!hasEvidence(a.evidence, messages)) {
      rejected.push(`profile addition "${a.text}" had no supporting words from you`);
      continue;
    }
    const exists = next.profileAdditions.some((x) => x.kind === a.kind && nearDuplicate(x.text, a.text));
    if (exists) continue;
    const alreadyInProfile = a.kind === "skill" && profile.skills.some((sk) => normalizeText(sk.name) === normalizeText(a.text) && sk.confirmed);
    if (alreadyInProfile) continue;
    next.profileAdditions.push({ id: crypto.randomUUID(), kind: a.kind, text: a.text.trim(), workId: a.workId && workIds.has(a.workId) ? a.workId : null, evidence: a.evidence });
  }

  next.companyHints = {
    pursue: dedupe([...next.companyHints.pursue, ...out.companyHints.pursue]),
    avoid: dedupe([...next.companyHints.avoid, ...out.companyHints.avoid]),
    industries: dedupe([...next.companyHints.industries, ...out.companyHints.industries]),
    stageOrSize: dedupe([...next.companyHints.stageOrSize, ...out.companyHints.stageOrSize]),
  };
  next.dealbreakers = dedupe([...next.dealbreakers, ...out.dealbreakers]);
  if (out.startDate) next.startDate = out.startDate;
  const latest = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const declined = SKIP_RE.test(latest);
  for (const c of out.coverage) {
    // Models tend to mark topics they haven't asked about yet as "skipped". Only the candidate can skip,
    // and a covered topic stays covered.
    if (c.status === "skipped" && (!declined || next.coverage[c.topic] === "covered")) continue;
    next.coverage[c.topic] = c.status;
  }
  return { draft: next, rejected };
}

export function requiredCovered(draft: InterviewDraft): boolean {
  return REQUIRED_TOPICS.every((t) => draft.coverage[t] === "covered" || draft.coverage[t] === "skipped");
}

/* ================================= Prompts ================================= */

const INTERVIEWER = `You are a warm, efficient career interviewer helping a job seeker set up an automated job search.
You already have their verified resume facts. Your goal is to learn what they want next so the system can find and apply to the right jobs.

How to interview:
- Ask ONE clear question per message. Keep messages under 60 words.
- Build on the resume: propose specific options inferred from their background instead of asking open-ended questions when you can.
- Offer 2-5 quick replies that cover the likely answers.
- Cover the required topics first (${REQUIRED_TOPICS.join(", ")}), then optional ones if useful. Skip topics the candidate already answered.
- For work authorization and sponsorship, ask plainly and neutrally.
- Voluntary demographic (EEO) questions default to "Decline to self-identify". Mention this once near the end and only record a different answer if the candidate explicitly asks.
- Never assume salary, visa status, or location without the candidate saying so.

Recording rules:
- preferences: set only fields the candidate confirmed or clearly stated in this conversation; null means no change.
- screeningAnswers: map to the known question keys when the meaning matches. evidence MUST be the candidate's own words copied exactly.
- profileAdditions: only real skills, accomplishments, or certifications the candidate said they have that are NOT already in the facts. evidence MUST be their exact words. workId is the id of the related role, or null.
- coverage: list only topics the latest answer covered, or skipped when the candidate explicitly declined. Leave out topics you haven't asked about.
- companyHints.avoid: specific employer names only. A category such as "crypto companies" belongs in preferences.industriesExclude as the industry name.
- done: true when all required topics are covered and you have nothing important left to ask.`;

function knownQuestions(): string {
  return COMMON_QUESTIONS.map((q) => `- "${q.key}": ${q.text}${q.options ? ` (options: ${q.options.join(" | ")})` : ""}`).join("\n");
}

function roleIndex(profile: ProfileData): string {
  return profile.work.map((w) => `- workId "${w.id}": ${w.title} at ${w.company} (${w.startDate || "?"} to ${w.endDate || "?"})`).join("\n");
}

function transcript(messages: InterviewMessage[], last = 12): string {
  return messages
    .slice(-last)
    .map((m) => `${m.role === "user" ? "CANDIDATE" : "INTERVIEWER"}: ${m.content}`)
    .join("\n");
}

function draftView(d: InterviewDraft): string {
  const open = TOPICS.filter((t) => d.coverage[t.key] === "open").map((t) => `${t.key}${t.required ? " (required)" : ""}`);
  return JSON.stringify(
    { preferences: d.preferences, screeningAnswers: d.screeningAnswers.map((a) => ({ questionKey: a.questionKey, answer: a.answer })), companyHints: d.companyHints, dealbreakers: d.dealbreakers, startDate: d.startDate, openTopics: open },
    null,
    1,
  );
}

const nowIso = () => new Date().toISOString();

/* ================================= Engine ================================== */

export class InterviewError extends Error {}

export async function startInterview(db: Db, llm: LlmLike, userId = LOCAL_USER_ID): Promise<Interview> {
  const existing = getOpenInterview(db, userId);
  if (existing) return existing;
  const profile = getActiveProfile(db, userId);
  if (!profile) throw new InterviewError("Add your resume on the Profile page first. The interview builds on it.");
  const prefs = getPreferences(db, userId);
  const facts = buildFacts(profile.data);
  const years = yearsOfExperience(profile.data);

  const out = await llm.object({ task: "interview_analyze", tier: "smart", maxOutputTokens: 6000 }, AnalyzeOut, {
    system: INTERVIEWER,
    prompt: `CANDIDATE FACTS (${years} years of experience):\n${factsToPrompt(facts)}\n\nCURRENT SAVED PREFERENCES (may be defaults):\n${JSON.stringify({ targetTitles: prefs.targetTitles, locations: prefs.locations, remotePolicy: prefs.remotePolicy, salaryFloor: prefs.salaryFloor })}\n\nStart the interview. Summarize their career in careerSummary, pre-fill likely preferences from the resume, and open with a short friendly message that shows you read their resume and asks your first question about target roles.`,
  });

  const draft = emptyDraft();
  draft.preferences = applyPreferencePatch({}, out.preferences);
  const first: InterviewMessage = { role: "assistant", content: out.message, quickReplies: out.quickReplies.slice(0, 5), inputKind: out.inputKind, at: nowIso() };
  return db
    .insert(s.interviews)
    .values({ userId, profileId: profile.id, status: "active", messages: [first], draft, careerSummary: out.careerSummary })
    .returning()
    .get();
}

export interface AnswerResult {
  interview: Interview;
  rejected: string[];
  readyToFinish: boolean;
}

export async function answerInterview(db: Db, llm: LlmLike, interviewId: string, text: string): Promise<AnswerResult> {
  const iv = getInterview(db, interviewId);
  if (!iv || iv.status !== "active") throw new InterviewError("This interview is no longer active");
  const profile = (iv.profileId ? db.select().from(s.profiles).where(eq(s.profiles.id, iv.profileId)).get() : undefined) ?? getActiveProfile(db, iv.userId);
  if (!profile) throw new InterviewError("Your profile is missing");
  const answer = text.trim();
  if (!answer) throw new InterviewError("Type an answer, or use Skip");

  const messages: InterviewMessage[] = [...iv.messages, { role: "user", content: answer, at: nowIso() }];
  const draft = InterviewDraft.parse(iv.draft);
  const out = await llm.object({ task: "interview_turn", tier: "smart", maxOutputTokens: 6000 }, TurnOut, {
    system: INTERVIEWER,
    prompt: `CANDIDATE FACTS:\n${factsToPrompt(buildFacts(profile.data))}\n\nROLES (for workId):\n${roleIndex(profile.data)}\n\nKNOWN SCREENING QUESTION KEYS:\n${knownQuestions()}\n\nCAREER SUMMARY: ${iv.careerSummary}\n\nWHAT HAS BEEN RECORDED SO FAR:\n${draftView(draft)}\n\nCONVERSATION (most recent last):\n${transcript(messages)}\n\nRecord what the candidate's latest answer tells you, then ask the next question.`,
  });

  const merged = mergeTurn(draft, out, messages, profile.data);
  const ready = requiredCovered(merged.draft);
  messages.push({ role: "assistant", content: out.message, quickReplies: out.quickReplies.slice(0, 5), inputKind: out.inputKind, at: nowIso() });
  const interview = updateInterview(db, iv.id, { messages, draft: merged.draft });
  return { interview, rejected: merged.rejected, readyToFinish: ready && (out.done || DONE_RE.test(answer)) };
}

/** Normalize the draft at high effort and move the interview to review. */
export async function finishInterview(db: Db, llm: LlmLike, interviewId: string): Promise<Interview> {
  const iv = getInterview(db, interviewId);
  if (!iv) throw new InterviewError("Interview not found");
  if (iv.status === "review") return iv;
  const draft = InterviewDraft.parse(iv.draft);
  const userAnswers = iv.messages.filter((m) => m.role === "user").length;
  if (userAnswers === 0) throw new InterviewError("Answer at least one question first");

  const out = await llm.object({ task: "interview_summarize", tier: "smart", maxOutputTokens: 6000 }, SummaryOut, {
    system: `You turn a job-search interview into clean, final settings.
- Normalize target titles to common job-board titles (keep the candidate's intent; 2-6 titles).
- keywords: distinctive words or phrases that identify relevant titles on their own. Leave out bare level or role words (head, vp, senior, manager): target titles already cover those.
- Locations as "City, State" or "Country"; salaryFloor as an annual number.
- companyExclude and companyHints.avoid hold specific employer names only. Put categories the candidate wants to avoid (for example "crypto companies") in industriesExclude as the industry name ("Crypto").
- Keep only screening answers the candidate actually gave; copy their evidence exactly. Map them to the known question keys when the meaning matches.
- Do not add anything the candidate did not say. null means keep the current value.`,
    prompt: `KNOWN SCREENING QUESTION KEYS:\n${knownQuestions()}\n\nRECORDED SO FAR:\n${draftView(draft)}\nSCREENING ANSWERS WITH EVIDENCE:\n${JSON.stringify(draft.screeningAnswers)}\n\nFULL CONVERSATION:\n${transcript(iv.messages, 200)}`,
  });

  const next = structuredClone(draft);
  next.preferences = applyPreferencePatch(next.preferences, out.preferences);
  // A keyword matches a title on its own, so drop ones too broad to filter anything ("head", "vp").
  const keywords = out.keywords.filter((k) => usableKeywords([k]).length > 0);
  if (keywords.length) next.preferences.keywords = dedupe(keywords).slice(0, 8);
  const answers = out.screeningAnswers.filter((a) => a.answer.trim() && hasEvidence(a.evidence, iv.messages));
  // Keep earlier evidenced answers that the summary didn't restate.
  next.screeningAnswers = [...answers, ...draft.screeningAnswers.filter((a) => !answers.some((b) => b.questionKey === a.questionKey))];
  const avoid = splitAvoidList([...draft.companyHints.avoid, ...out.companyHints.avoid, ...(next.preferences.companyExclude ?? [])]);
  next.preferences.companyExclude = dedupe(avoid.companies);
  if (avoid.industries.length) next.preferences.industriesExclude = dedupe([...(next.preferences.industriesExclude ?? []), ...avoid.industries]);
  next.companyHints = {
    pursue: dedupe([...draft.companyHints.pursue, ...out.companyHints.pursue]),
    avoid: dedupe(avoid.companies),
    industries: dedupe([...draft.companyHints.industries, ...out.companyHints.industries]),
    stageOrSize: dedupe([...draft.companyHints.stageOrSize, ...out.companyHints.stageOrSize]),
  };
  return updateInterview(db, iv.id, { draft: next, status: "review" });
}

export function abandonInterview(db: Db, interviewId: string): void {
  updateInterview(db, interviewId, { status: "abandoned" });
}

/** The user edited the draft on the review screen. */
export function saveReviewDraft(db: Db, interviewId: string, draft: unknown): Interview {
  const iv = getInterview(db, interviewId);
  if (!iv || iv.status !== "review") throw new InterviewError("Only interviews under review can be edited");
  return updateInterview(db, interviewId, { draft: InterviewDraft.parse(draft) });
}

export { TurnOut as InterviewTurnOut, AnalyzeOut as InterviewAnalyzeOut, SummaryOut as InterviewSummaryOut };
