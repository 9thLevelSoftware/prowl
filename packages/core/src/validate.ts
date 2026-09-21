import type { CoverLetter, ProfileData, ProfileFact, TailoredResume } from "@prowl/shared";
import { findSkill } from "./skills";

/**
 * Deterministic truthfulness checks that do not depend on a model's judgment.
 * They run before the LLM auditor, and their failures are always surfaced to the user.
 */

export interface StructuralIssue {
  location: string;
  severity: "error" | "fixed";
  message: string;
}

/** Numbers that carry meaning in a claim: 40%, $2.5M, 3x, 120, 2019. */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  const re = /(\$?\d[\d,]*(?:\.\d+)?)\s*(%|percent|x|k|m|mm|b|bn|million|billion|thousand)?/gi;
  for (const m of text.matchAll(re)) {
    const n = m[1]!.replace(/[$,]/g, "");
    if (!n || n === "0") continue;
    const unit = (m[2] ?? "").toLowerCase();
    const scale = unit === "k" || unit === "thousand" ? "k" : ["m", "mm", "million"].includes(unit) ? "m" : ["b", "bn", "billion"].includes(unit) ? "b" : unit === "percent" ? "%" : unit;
    out.push(`${Number(n)}${scale}`);
  }
  return out;
}

const WORD_NUMBERS: Record<string, string> = {
  two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12", fifteen: "15", twenty: "20", fifty: "50", hundred: "100",
};

function numbersIn(text: string): Set<string> {
  const lower = text.toLowerCase().replace(/\b(two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|fifty|hundred)\b/g, (w) => WORD_NUMBERS[w] ?? w);
  const set = new Set<string>();
  for (const n of extractNumbers(lower)) {
    set.add(n);
    set.add(n.replace(/[a-z%]+$/, "")); // also allow the bare number
  }
  return set;
}

/** Every number in `claim` must appear in the cited facts (or anywhere in the profile when citing broadly). */
export function unsupportedNumbers(claim: string, sources: string[]): string[] {
  const allowed = numbersIn(sources.join("\n"));
  const lower = claim.toLowerCase().replace(/\b(two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|fifty|hundred)\b/g, (w) => WORD_NUMBERS[w] ?? w);
  return extractNumbers(lower).filter((n) => !allowed.has(n) && !allowed.has(n.replace(/[a-z%]+$/, "")) );
}

export interface ValidationResult {
  resume: TailoredResume;
  issues: StructuralIssue[];
  errors: StructuralIssue[];
}

export function validateTailored(profile: ProfileData, facts: ProfileFact[], t: TailoredResume): ValidationResult {
  const issues: StructuralIssue[] = [];
  const factById = new Map(facts.map((f) => [f.id, f]));
  const workIds = new Set(profile.work.map((w) => w.id));
  const projectIds = new Set(profile.projects.map((p) => p.id));
  const eduIds = new Set(profile.education.map((e) => e.id));
  const confirmed = profile.skills.filter((s) => s.confirmed);

  const checkCitation = (location: string, text: string, factIds: string[]) => {
    const valid = factIds.filter((id) => factById.has(id));
    const invalid = factIds.filter((id) => !factById.has(id));
    if (!factIds.length) issues.push({ location, severity: "error", message: "Claim cites no profile facts" });
    if (invalid.length) issues.push({ location, severity: "error", message: `Cites unknown fact ids: ${invalid.join(", ")}` });
    if (valid.length) {
      const bad = unsupportedNumbers(text, valid.map((id) => factById.get(id)!.text));
      if (bad.length) issues.push({ location, severity: "error", message: `Numbers not found in cited facts: ${bad.join(", ")}` });
    }
  };

  checkCitation("summary", t.summary.text, t.summary.factIds);
  const headlineBad = unsupportedNumbers(t.headline, facts.map((f) => f.text));
  if (headlineBad.length) issues.push({ location: "headline", severity: "error", message: `Numbers not found in profile: ${headlineBad.join(", ")}` });

  const work = t.work.filter((w) => {
    if (!workIds.has(w.workId)) {
      issues.push({ location: `work:${w.workId}`, severity: "fixed", message: "Removed section for an unknown role id" });
      return false;
    }
    return true;
  });
  for (const w of work) w.bullets.forEach((b, i) => checkCitation(`work:${w.workId}:${i}`, b.text, b.factIds));

  const projects = t.projects.filter((p) => {
    if (!projectIds.has(p.projectId)) {
      issues.push({ location: `project:${p.projectId}`, severity: "fixed", message: "Removed section for an unknown project id" });
      return false;
    }
    return true;
  });
  for (const p of projects) p.bullets.forEach((b, i) => checkCitation(`project:${p.projectId}:${i}`, b.text, b.factIds));

  // Skills: only confirmed skills may appear. Anything else is removed deterministically.
  const skills = t.skills
    .map((g) => ({
      category: g.category,
      items: g.items.filter((item) => {
        if (findSkill(confirmed, item)) return true;
        issues.push({ location: "skills", severity: "fixed", message: `Removed "${item}": not a confirmed skill in your profile` });
        return false;
      }),
    }))
    .filter((g) => g.items.length);

  const includeEducationIds = t.includeEducationIds.filter((id) => eduIds.has(id));
  const certNames = new Set(profile.certifications.map((c) => c.name.toLowerCase()));
  const includeCertifications = t.includeCertifications.filter((c) => {
    if (certNames.has(c.toLowerCase())) return true;
    issues.push({ location: "certifications", severity: "fixed", message: `Removed certification "${c}": not in your profile` });
    return false;
  });

  const resume: TailoredResume = { ...t, work, projects, skills, includeEducationIds, includeCertifications };
  return { resume, issues, errors: issues.filter((i) => i.severity === "error") };
}

export function validateCoverLetter(facts: ProfileFact[], c: CoverLetter): StructuralIssue[] {
  const factById = new Map(facts.map((f) => [f.id, f]));
  const issues: StructuralIssue[] = [];
  c.paragraphs.forEach((p, i) => {
    const invalid = p.factIds.filter((id) => !factById.has(id));
    if (invalid.length) issues.push({ location: `cover:${i}`, severity: "error", message: `Cites unknown fact ids: ${invalid.join(", ")}` });
    const sources = p.factIds.filter((id) => factById.has(id)).map((id) => factById.get(id)!.text);
    const bad = unsupportedNumbers(p.text, sources.length ? sources : facts.map((f) => f.text));
    if (bad.length) issues.push({ location: `cover:${i}`, severity: "error", message: `Numbers not found in cited facts: ${bad.join(", ")}` });
  });
  return issues;
}
