import { z } from "zod";
import type { LlmClient } from "@prowl/llm";
import type { Preferences, ProfileData, ProfileFact } from "@prowl/shared";
import { normalizeText } from "@prowl/shared";
import { questionKey, type FormQuestion } from "./extract";

export type AnswerSource = "profile" | "qa_bank" | "file" | "default" | "llm_draft" | "user";

export interface PlannedAnswer {
  handle: string;
  label: string;
  type: FormQuestion["type"];
  required: boolean;
  /** Text value, chosen option label, or "; "-joined option labels for checkbox groups. */
  value: string;
  filePath?: string;
  source: AnswerSource;
  /** True when the answer must be approved by the user before submitting. */
  needsUser: boolean;
  reason?: string;
  questionKey: string;
  options: string[];
}

export interface QaEntry {
  questionKey: string;
  questionText: string;
  answer: string;
  approved: boolean;
}

export interface AnswerContext {
  profile: ProfileData;
  facts: ProfileFact[];
  prefs: Preferences;
  qa: QaEntry[];
  job: { title: string; company: string; location: string; descriptionText: string };
  resumePath: string;
  coverLetterPath: string | null;
  coverLetterText: string | null;
}

/* ============================== Option matching ============================== */

const YES = /^(yes|y|true|i do|i am|i have|i will|i consent|i agree|agree|accept)\b/i;
const NO = /^(no|n|false|i do not|i don't|i am not|i have not|i will not|decline)\b/i;

/** Pick the option that best matches an intended answer. Returns null when nothing is a confident match. */
export function matchOption(options: string[], answer: string): string | null {
  if (!options.length) return answer || null;
  const a = normalizeText(answer);
  if (!a) return null;
  const norm = options.map((o) => ({ o, n: normalizeText(o) }));
  const exact = norm.find((x) => x.n === a);
  if (exact) return exact.o;
  if (YES.test(answer) || NO.test(answer)) {
    const wantYes = YES.test(answer) && !NO.test(answer);
    const hit = norm.find((x) => (wantYes ? YES.test(x.o) && !NO.test(x.o) : NO.test(x.o)));
    if (hit) return hit.o;
  }
  const starts = norm.filter((x) => x.n.startsWith(a) || a.startsWith(x.n));
  if (starts.length === 1) return starts[0]!.o;
  const contains = norm.filter((x) => x.n.includes(a) || (x.n.length > 3 && a.includes(x.n)));
  if (contains.length === 1) return contains[0]!.o;
  // Token overlap (Jaccard) as the last resort, with a high bar.
  const at = new Set(a.split(" "));
  let best: { o: string; s: number } | null = null;
  for (const x of norm) {
    const xt = new Set(x.n.split(" "));
    const inter = [...at].filter((t) => xt.has(t)).length;
    const s = inter / new Set([...at, ...xt]).size;
    if (!best || s > best.s) best = { o: x.o, s };
  }
  return best && best.s >= 0.6 ? best.o : null;
}

/* ============================ Deterministic fields =========================== */

const EEO = /\b(gender|sex\b|race|ethnicity|hispanic|latino|veteran|disability|disabled|sexual orientation|lgbtq|transgender|pronoun)/i;
const DECLINE = /(decline|don't wish|do not wish|prefer not|not to (say|disclose|answer|self.identify)|choose not|i don't want|rather not)/i;

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

function link(profile: ProfileData, re: RegExp): string {
  return profile.contact.links.find((l) => re.test(l.label) || re.test(l.url))?.url ?? "";
}

function currentRole(profile: ProfileData) {
  return profile.work.find((w) => /present|current/i.test(w.endDate) || !w.endDate) ?? profile.work[0];
}

/** Standard fields every ATS asks for, answered straight from the confirmed profile. */
export function deterministicAnswer(q: FormQuestion, ctx: AnswerContext): Omit<PlannedAnswer, "handle" | "label" | "type" | "required" | "questionKey" | "options"> | null {
  const p = ctx.profile;
  const hint = `${q.label} ${q.name} ${q.id}`.toLowerCase();
  const l = q.label.toLowerCase();
  const { first, last } = splitName(p.contact.fullName);
  const ok = (value: string, source: AnswerSource = "profile") => (value ? { value, source, needsUser: false } : null);

  if (q.type === "file") {
    if (/autofill|auto.fill|parse/i.test(hint)) return { value: "", source: "default", needsUser: false, reason: "Skipped resume autofill widget" };
    if (/cover/.test(hint)) return ctx.coverLetterPath ? { value: "cover letter", filePath: ctx.coverLetterPath, source: "file", needsUser: false } : null;
    if (/resume|cv\b|curriculum/.test(hint) || q.id === "resume") return { value: "resume", filePath: ctx.resumePath, source: "file", needsUser: false };
    return null;
  }
  if (/cover letter/.test(l) && (q.type === "textarea" || q.type === "text") && ctx.coverLetterText) return ok(ctx.coverLetterText, "file");

  if (q.type === "text" || q.type === "email" || q.type === "tel" || q.type === "url") {
    if (/^first name|first_name|given name|legal first/.test(hint) || q.id === "first_name") return ok(first);
    if (/^last name|last_name|family name|surname|legal last/.test(hint) || q.id === "last_name") return ok(last);
    if (/preferred (first )?name/.test(l)) return ok(first);
    if (/^(full |legal )?name$|^your name|_systemfield_name|^name$/.test(l) || q.name === "name" || q.id === "_systemfield_name") return ok(p.contact.fullName);
    if (q.type === "email" || /e-?mail/.test(hint)) return ok(p.contact.email);
    if (q.type === "tel" || /phone|mobile/.test(hint)) return ok(p.contact.phone);
    if (/linkedin/.test(hint)) return ok(link(p, /linkedin/i));
    if (/github/.test(hint)) return ok(link(p, /github/i));
    if (/portfolio|website|personal (site|url)|other url/.test(hint)) return ok(link(p, /portfolio|website|site|blog/i) || p.contact.links.find((x) => !/linkedin|github/i.test(x.url))?.url || "");
    if (/current (company|employer)|^company$|most recent employer|current or previous employer/.test(l) || q.name === "org") return ok(currentRole(p)?.company ?? "");
    if (/current (job )?title|current or previous job title|most recent title/.test(l)) return ok(currentRole(p)?.title ?? "");
    if (/^(current )?location|^city|where are you located|location \(city\)/.test(l) || q.name === "location") return ok(p.contact.location);
  }
  if (q.type === "combobox" && (/location \(city\)|^city|current location/.test(l) || q.id === "candidate-location")) return ok(p.contact.location);
  if (/^school|university|college|institution/.test(l) && p.education[0]) return ok(p.education[0].institution);
  if (/^degree/.test(l) && p.education[0]?.degree) return ok(p.education[0].degree);
  if (/^discipline|field of study|major/.test(l) && p.education[0]?.field) return ok(p.education[0].field);
  return null;
}

/* ================================ LLM drafts ================================= */

const DraftOut = z.object({
  answers: z.array(
    z.object({
      handle: z.string(),
      answer: z.string().describe("The answer text, or the exact option label(s) to choose. For multi-select separate labels with '; '. Empty string when you cannot answer truthfully."),
      kind: z.enum(["matches_saved_answer", "factual_from_profile", "preference", "essay", "consent_or_legal", "unanswerable"]),
      savedQuestionKey: z.string().describe("When kind is matches_saved_answer, the questionKey of the saved answer used; else empty"),
      note: z.string().describe("Short explanation for the user"),
    }),
  ),
});

const DRAFT_SYSTEM = `You help a job candidate fill out an application form truthfully.
For each question, draft an answer using ONLY: the candidate's verified facts, their preferences, and their saved answers.
Rules:
- If a saved answer clearly answers the same question (even with different wording), use it and set kind "matches_saved_answer" with its questionKey.
- For choice questions, answer with the exact option label(s) from the list.
- Never invent experience, credentials, numbers, dates, salaries, or legal status. If the information is not provided, answer "" with kind "unanswerable".
- Essays ("why do you want to work here", "describe a project"): write 60-150 words grounded in the facts, specific to the company and role, no clichés. kind "essay".
- Consent, acknowledgment, legal attestations, background checks, non-compete, and privacy-policy questions: kind "consent_or_legal". Draft the answer the candidate most likely intends but it will be confirmed by them.
- Do not answer puzzles, coding challenges, or skill tests on the candidate's behalf; kind "unanswerable".`;

function prefsSummary(p: Preferences): string {
  return [
    `Work authorization: ${p.workAuthorization || "(not provided)"}`,
    `Requires visa sponsorship: ${p.requiresSponsorship ? "yes" : "no"}`,
    `Minimum salary: ${p.salaryFloor || "(not provided)"}`,
    `Remote policy: ${p.remotePolicy}`,
    `Preferred locations: ${p.locations.join(", ") || "(not provided)"}`,
  ].join("\n");
}

export async function planAnswers(llm: LlmClient | null, questions: FormQuestion[], ctx: AnswerContext, opts: { applicationId?: string } = {}): Promise<PlannedAnswer[]> {
  const approved = ctx.qa.filter((q) => q.approved);
  const byKey = new Map(approved.map((q) => [q.questionKey, q]));
  const plans: PlannedAnswer[] = [];
  const pending: FormQuestion[] = [];

  for (const q of questions) {
    const key = scopedKey(q, ctx);
    const base = { handle: q.handle, label: q.label, type: q.type, required: q.required, questionKey: key, options: q.options };

    const det = deterministicAnswer(q, ctx);
    if (det && (det.value || det.filePath || det.source === "default")) {
      plans.push({ ...base, ...det, value: q.options.length ? (matchOption(q.options, det.value) ?? det.value) : det.value });
      continue;
    }

    const saved = byKey.get(key) ?? byKey.get(questionKey(q.label));
    if (saved) {
      const value = q.options.length ? matchMulti(q, saved.answer) : saved.answer;
      if (value) {
        plans.push({ ...base, value, source: "qa_bank", needsUser: false });
        continue;
      }
    }

    if (EEO.test(q.label) && q.options.length) {
      const eeoSaved = byKey.get(`eeo:${eeoCategory(q.label)}`);
      const choice = (eeoSaved && matchOption(q.options, eeoSaved.answer)) ?? q.options.find((o) => DECLINE.test(o));
      if (choice) {
        plans.push({ ...base, value: choice, source: eeoSaved ? "qa_bank" : "default", needsUser: false, reason: eeoSaved ? undefined : "Voluntary self-identification: declined by default" });
        continue;
      }
    }
    if (EEO.test(q.label) && !q.required) {
      plans.push({ ...base, value: "", source: "default", needsUser: false, reason: "Optional self-identification left blank" });
      continue;
    }

    if (q.type === "checkbox_single" && !q.required && /(marketing|future (job )?opportunit|newsletter|text messages|sms)/i.test(q.label)) {
      plans.push({ ...base, value: "", source: "default", needsUser: false, reason: "Optional marketing consent left unchecked" });
      continue;
    }
    pending.push(q);
  }

  if (pending.length && llm) {
    const out = await llm.object({ task: "form_answers", tier: "smart", applicationId: opts.applicationId, maxOutputTokens: 8000 }, DraftOut, {
      system: DRAFT_SYSTEM,
      prompt: `CANDIDATE FACTS:\n${ctx.facts.map((f) => `[${f.id}] ${f.text}`).join("\n")}\n\nCANDIDATE PREFERENCES:\n${prefsSummary(ctx.prefs)}\n\nSAVED ANSWERS (approved by candidate):\n${
        approved.map((a) => `- questionKey "${a.questionKey}": Q: ${a.questionText} A: ${a.answer}`).join("\n") || "(none)"
      }\n\nJOB: ${ctx.job.title} at ${ctx.job.company} (${ctx.job.location})\n${ctx.job.descriptionText.slice(0, 4000)}\n\nQUESTIONS:\n${pending
        .map((q) => `- handle "${q.handle}" [${q.type}${q.required ? ", required" : ""}] ${q.label}${q.options.length ? `\n  options: ${q.options.slice(0, 60).join(" | ")}` : ""}`)
        .join("\n")}`,
    });
    const byHandle = new Map(out.answers.map((a) => [a.handle, a]));
    for (const q of pending) {
      const a = byHandle.get(q.handle);
      const key = scopedKey(q, ctx);
      const base = { handle: q.handle, label: q.label, type: q.type, required: q.required, questionKey: key, options: q.options };
      if (!a || !a.answer.trim() || a.kind === "unanswerable") {
        plans.push({ ...base, value: "", source: "llm_draft", needsUser: q.required, reason: a?.note || "No answer available from your profile" });
        continue;
      }
      const value = q.options.length ? matchMulti(q, a.answer) : a.answer.trim();
      const reuse = a.kind === "matches_saved_answer" && approved.some((s) => s.questionKey === a.savedQuestionKey);
      plans.push({
        ...base,
        value: value ?? "",
        source: reuse ? "qa_bank" : "llm_draft",
        // Every model-drafted answer to a required question is confirmed by the user once.
        // Optional questions without a saved answer are left blank rather than guessed.
        needsUser: reuse ? !value : q.required,
        reason: a.note,
      });
      if (!reuse && !q.required) plans[plans.length - 1]!.value = "";
    }
  } else {
    for (const q of pending) {
      plans.push({ handle: q.handle, label: q.label, type: q.type, required: q.required, questionKey: scopedKey(q, ctx), options: q.options, value: "", source: "llm_draft", needsUser: q.required, reason: "No saved answer" });
    }
  }
  return plans;
}

/** Essay-style answers are company-specific; factual ones are reusable across applications. */
export function scopedKey(q: FormQuestion, ctx: Pick<AnswerContext, "job">): string {
  const key = questionKey(q.label);
  const companySpecific = q.type === "textarea" || new RegExp(`\\b${normalizeText(ctx.job.company).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(normalizeText(q.label));
  return companySpecific ? `${normalizeText(ctx.job.company)}:${key}` : key;
}

export function eeoCategory(label: string): string {
  const l = label.toLowerCase();
  if (/veteran/.test(l)) return "veteran";
  if (/disab/.test(l)) return "disability";
  if (/hispanic|latino/.test(l)) return "hispanic";
  if (/race|ethnic/.test(l)) return "race";
  if (/orientation|lgbtq/.test(l)) return "orientation";
  if (/transgender/.test(l)) return "transgender";
  if (/pronoun/.test(l)) return "pronouns";
  return "gender";
}

function matchMulti(q: FormQuestion, answer: string): string {
  if (q.type !== "checkbox") return matchOption(q.options, answer) ?? "";
  return answer
    .split(/;|\n/)
    .map((a) => matchOption(q.options, a.trim()))
    .filter((x): x is string => !!x)
    .join("; ");
}
