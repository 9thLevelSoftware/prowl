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
import { coverLetterSystemPrompt, tailorSystemPrompt } from "./resume-craft";
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
// Craft guidance lives in resume-craft.ts (ResumeSkills knowledge, truth-gated).
const TAILOR_SYSTEM = tailorSystemPrompt();

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
  const system = coverLetterSystemPrompt(words, prefs.coverLetterTone);
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
