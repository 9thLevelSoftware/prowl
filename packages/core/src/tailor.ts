import type { LlmClient } from "@jh/llm";
import {
  AuditReportOut,
  CoverLetterOut,
  TailoredResumeOut,
  type AuditReport,
  type CoverLetter,
  type JobRequirements,
  type Preferences,
  type ProfileData,
  type ProfileFact,
  type TailoredResume,
} from "@jh/shared";
import { resolveBaseline, resolveTailored, resumeToText } from "@jh/documents";
import { factsToPrompt } from "./profile";
import { findSkill, textMentions } from "./skills";
import { validateCoverLetter, validateTailored, type StructuralIssue } from "./validate";
import { semanticSimilarity } from "./embed";

export interface JobContext {
  id: string;
  title: string;
  company: string;
  location: string;
  descriptionText: string;
  requirements: JobRequirements;
}

/* ================================ Tailor ================================ */

// The system prompt and fact ledger form a stable prefix, so providers with implicit
// prompt caching (OpenAI, Gemini) reuse it across every job tailored against one profile.
const TAILOR_SYSTEM = `You tailor a candidate's resume to a specific job posting. You must be both effective and strictly truthful.

TRUTHFULNESS (non-negotiable):
- Every bullet and the summary must cite the fact ids ([W1.2], [K3], ...) they are derived from, in factIds.
- You may: reorder bullets, choose which bullets to include, sharpen verbs, tighten wording, lead with the parts most relevant to the job, merge two facts from the same role into one bullet, and describe genuine work using the posting's vocabulary when that vocabulary accurately describes what the fact says.
- You may NOT add or change: numbers, percentages, money, team sizes, durations, tools, technologies, titles, employers, dates, degrees, certifications, scope ("led" when the fact says "contributed"), seniority, or outcomes. If a fact has no metric, the bullet has no metric.
- The skills section may only contain skills listed as [K*] facts. When the posting spells a skill differently from the profile (profile "K8s", posting "Kubernetes"), use the posting's spelling of that same skill.
- Never claim a skill from the posting that the facts do not support, even if it seems likely.
- Do not list a skill the candidate has in a way that implies greater depth than the facts show.

ATS OPTIMIZATION (two-layer screening: keyword filter, then semantic ranking):
- Hard terms (tools, languages, frameworks, certifications, methodologies) that the candidate truthfully has and the posting names should appear verbatim, in the skills section and, where a cited fact supports it, inside a relevant bullet.
- Write bullets in natural, specific language. Do not stuff keyword lists into bullets or the summary. Repeating a term many times hurts semantic ranking.
- Put the most job-relevant bullets first in each role. Keep 3-6 bullets for recent relevant roles and 1-3 for older or less relevant roles.
- The summary is 2-3 sentences, mirrors the role's focus, and contains no claim that the cited facts do not support.
- The headline is under 12 words and describes the candidate truthfully (use their real title history), aligned to the target role where accurate.

OUTPUT:
- Include every work entry id from the profile in "work", in the same order. Use the exact ids given.
- includeEducationIds: include all education ids unless one is clearly irrelevant noise.
- includeCertifications: names exactly as listed in [C*] facts.
- changeNotes: 3-8 short notes explaining what you emphasized and why.`;

function profileIndex(p: ProfileData): string {
  const lines: string[] = ["WORK ENTRY IDS:"];
  p.work.forEach((w, i) => lines.push(`- workId "${w.id}" = W${i + 1}: ${w.title} at ${w.company}`));
  if (p.projects.length) {
    lines.push("PROJECT IDS:");
    p.projects.forEach((pr, i) => lines.push(`- projectId "${pr.id}" = P${i + 1}: ${pr.name}`));
  }
  if (p.education.length) {
    lines.push("EDUCATION IDS:");
    p.education.forEach((e, i) => lines.push(`- "${e.id}" = E${i + 1}: ${e.degree} ${e.institution}`));
  }
  return lines.join("\n");
}

function jobBlock(job: JobContext): string {
  const r = job.requirements;
  return `TARGET JOB
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Summary: ${r.roleSummary}
Required: ${r.mustHaveSkills.join("; ") || "(not stated)"}
Preferred: ${r.niceToHaveSkills.join("; ") || "(not stated)"}
ATS keywords: ${r.atsKeywords.join("; ")}
Responsibilities:
${r.keyResponsibilities.map((x) => `- ${x}`).join("\n")}

Full posting:
"""
${job.descriptionText.slice(0, 14_000)}
"""`;
}

export interface TailorResult {
  resume: TailoredResume;
  issues: StructuralIssue[];
  keywordReport: { keyword: string; before: boolean; after: boolean; inProfile: boolean }[];
  keywordCoverageBefore: number;
  keywordCoverageAfter: number;
  semanticBefore: number;
  semanticAfter: number;
}

export async function tailorResume(
  llm: LlmClient,
  profile: ProfileData,
  facts: ProfileFact[],
  job: JobContext,
  ctx: { applicationId?: string } = {},
): Promise<TailorResult> {
  const stablePrefix = `CANDIDATE FACTS (the only permitted source of claims):\n${factsToPrompt(facts)}\n\n${profileIndex(profile)}`;
  const call = (repairNote?: string) =>
    llm.object({ task: "tailor", tier: "smart", jobId: job.id, applicationId: ctx.applicationId, maxOutputTokens: 16_000 }, TailoredResumeOut, {
      system: TAILOR_SYSTEM,
      prompt: `${stablePrefix}\n\n${jobBlock(job)}${repairNote ? `\n\nYOUR PREVIOUS ATTEMPT HAD THESE PROBLEMS. Fix all of them:\n${repairNote}` : ""}`,
    });

  let raw = await call();
  let v = validateTailored(profile, facts, raw);
  if (v.errors.length) {
    // One repair round with the exact validator output.
    raw = await call(v.errors.map((e) => `- ${e.location}: ${e.message}`).join("\n"));
    v = validateTailored(profile, facts, raw);
  }

  const metrics = await measure(profile, v.resume, job);
  return { resume: v.resume, issues: v.issues, ...metrics };
}

export async function measure(profile: ProfileData, resume: TailoredResume, job: JobContext) {
  const baselineText = resumeToText(resolveBaseline(profile));
  const tailoredText = resumeToText(resolveTailored(profile, resume));
  const confirmed = profile.skills.filter((s) => s.confirmed);
  const keywords = [...new Set(job.requirements.atsKeywords.map((k) => k.trim()).filter(Boolean))];
  const keywordReport = keywords.map((keyword) => ({
    keyword,
    before: textMentions(baselineText, keyword),
    after: textMentions(tailoredText, keyword),
    inProfile: !!findSkill(confirmed, keyword) || textMentions(baselineText, keyword),
  }));
  const pct = (xs: boolean[]) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 100) : 0);
  const jobText = `${job.title}\n${job.requirements.roleSummary}\n${job.requirements.keyResponsibilities.join("\n")}\n${job.descriptionText.slice(0, 6000)}`;
  const [before, after] = await Promise.all([semanticSimilarity(baselineText, jobText), semanticSimilarity(tailoredText, jobText)]);
  return {
    keywordReport,
    keywordCoverageBefore: pct(keywordReport.map((k) => k.before)),
    keywordCoverageAfter: pct(keywordReport.map((k) => k.after)),
    semanticBefore: Math.round(before.score * 100),
    semanticAfter: Math.round(after.score * 100),
  };
}

/* ================================ Audit ================================= */

const AUDIT_SYSTEM = `You are a strict fact-checker for resumes and cover letters. You work for the candidate's integrity, not for their chances.
You receive (1) the candidate's verified facts and (2) a list of claims from a tailored document.
For EACH claim return exactly one item:
- "entailed": every assertion in the claim is directly supported by the facts. Rephrasing, reordering, synonyms, and using a different spelling for the same skill are fine.
- "exaggerated": the claim is based on a real fact but inflates it: bigger scope, stronger ownership ("led" vs "helped"), more seniority, broader impact, stronger outcome, or implies more depth with a skill than the facts show.
- "fabricated": the claim asserts something with no support: a tool, metric, employer, responsibility, certification, or result that does not appear in the facts.
For non-entailed items, put the exact unsupported words in offendingSpan and explain briefly.
Generic professional framing with no factual content ("I am excited to apply") is entailed.
Do not skip any claim. Keep the claim text exactly as given.`;

export interface Claim {
  location: string;
  text: string;
}

export function resumeClaims(profile: ProfileData, t: TailoredResume): Claim[] {
  const claims: Claim[] = [{ location: "headline", text: t.headline }, { location: "summary", text: t.summary.text }];
  const skillList = t.skills.flatMap((g) => g.items);
  if (skillList.length) claims.push({ location: "skills", text: `Has skills: ${skillList.join(", ")}` });
  for (const w of t.work) {
    const role = profile.work.find((x) => x.id === w.workId);
    w.bullets.forEach((b, i) => claims.push({ location: `work:${w.workId}:${i}`, text: `${role ? `[${role.title} at ${role.company}] ` : ""}${b.text}` }));
  }
  for (const p of t.projects) p.bullets.forEach((b, i) => claims.push({ location: `project:${p.projectId}:${i}`, text: b.text }));
  return claims;
}

export async function auditClaims(
  llm: LlmClient,
  facts: ProfileFact[],
  claims: Claim[],
  structural: StructuralIssue[],
  ctx: { jobId?: string; applicationId?: string; task?: string } = {},
): Promise<AuditReport> {
  const out = await llm.object(
    { task: ctx.task ?? "audit", tier: "smart", jobId: ctx.jobId, applicationId: ctx.applicationId, maxOutputTokens: 12_000, temperature: 0 },
    AuditReportOut,
    {
      system: AUDIT_SYSTEM,
      prompt: `VERIFIED FACTS:\n${factsToPrompt(facts)}\n\nCLAIMS TO CHECK:\n${claims.map((c) => `- location "${c.location}": ${c.text}`).join("\n")}`,
    },
  );
  const items = [...out.items];
  // Deterministic failures override the model: an unsupported number is never "entailed".
  for (const s of structural.filter((x) => x.severity === "error")) {
    const existing = items.find((i) => i.location === s.location);
    if (existing && existing.verdict === "entailed") {
      existing.verdict = "exaggerated";
      existing.explanation = `${s.message}. ${existing.explanation}`.trim();
    } else if (!existing) {
      items.push({ location: s.location, claim: claims.find((c) => c.location === s.location)?.text ?? "", verdict: "fabricated", offendingSpan: "", explanation: s.message });
    }
  }
  // A claim the auditor silently skipped is treated as unverified.
  for (const c of claims) {
    if (!items.some((i) => i.location === c.location)) {
      items.push({ location: c.location, claim: c.text, verdict: "exaggerated", offendingSpan: "", explanation: "Auditor did not return a verdict for this claim; review manually." });
    }
  }
  const overall = items.some((i) => i.verdict !== "entailed") ? "flagged" : "pass";
  return { items, overall };
}

/* ============================= Cover letter ============================= */

export async function writeCoverLetter(
  llm: LlmClient,
  profile: ProfileData,
  facts: ProfileFact[],
  resume: TailoredResume,
  job: JobContext,
  prefs: Preferences,
  ctx: { applicationId?: string; companyNote?: string } = {},
): Promise<{ letter: CoverLetter; issues: StructuralIssue[] }> {
  const words = prefs.coverLetterLength === "short" ? "180-250" : "280-380";
  const system = `You write cover letters that sound like a thoughtful human, not a template.
Rules:
- ${words} words across 3-4 paragraphs. Tone: ${prefs.coverLetterTone}.
- Open with the specific role and one concrete reason the candidate fits, drawn from the facts.
- Middle: 2-3 specific, relevant accomplishments from the facts, connected to what the posting needs.
- Close: brief, confident, no begging, no "I believe I would be a great fit".
- Each paragraph cites the fact ids it relies on in factIds (empty only for a paragraph with no factual claims).
- Truthfulness rules are identical to the resume: no invented metrics, tools, scope, titles, or outcomes. Do not claim knowledge about the company beyond the posting and the candidate's note.
- Avoid clichés: "passionate", "results-driven", "dynamic", "synergy", "I am writing to express my interest".
- greeting: "Dear Hiring Team," unless a hiring manager is named in the posting.
- signature: the candidate's full name.`;
  const prompt = `CANDIDATE FACTS:\n${factsToPrompt(facts)}\n\nCandidate name: ${profile.contact.fullName}\n\nTAILORED RESUME EMPHASIS:\n${resume.changeNotes.map((n) => `- ${n}`).join("\n")}\n\n${jobBlock(job)}${
    ctx.companyNote ? `\n\nCANDIDATE'S OWN NOTE ON WHY THIS COMPANY (may be used):\n${ctx.companyNote}` : ""
  }`;
  const call = (repair?: string) =>
    llm.object({ task: "cover_letter", tier: "smart", jobId: job.id, applicationId: ctx.applicationId, maxOutputTokens: 6000 }, CoverLetterOut, {
      system,
      prompt: repair ? `${prompt}\n\nFIX THESE PROBLEMS FROM YOUR LAST ATTEMPT:\n${repair}` : prompt,
    });
  let letter = await call();
  let issues = validateCoverLetter(facts, letter);
  if (issues.some((i) => i.severity === "error")) {
    letter = await call(issues.map((i) => `- ${i.location}: ${i.message}`).join("\n"));
    issues = validateCoverLetter(facts, letter);
  }
  if (!letter.signature.trim()) letter.signature = profile.contact.fullName;
  return { letter, issues };
}

export function coverLetterClaims(c: CoverLetter): Claim[] {
  return c.paragraphs.map((p, i) => ({ location: `cover:${i}`, text: p.text }));
}
