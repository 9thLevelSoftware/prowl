import {
  normalizeText,
  SENIORITIES,
  type JobRequirements,
  type Preferences,
  type ProfileData,
  type ScoreBreakdown,
  type Seniority,
} from "@jh/shared";
import { findSkill, textMentions } from "./skills";
import { semanticSimilarity } from "./embed";
import { yearsOfExperience } from "./profile";

export const WEIGHTS = { skills: 35, semantic: 25, experience: 20, preference: 20 } as const;

export interface JobForScoring {
  title: string;
  company: string;
  location: string;
  remote: boolean | null;
  salaryMin: number | null;
  salaryMax: number | null;
  descriptionText: string;
  requirements: JobRequirements;
}

/** Profile text used for semantic comparison: summary, titles, bullets, confirmed skills. */
export function profileText(p: ProfileData): string {
  return [
    p.headline,
    p.summary,
    ...p.work.flatMap((w) => [`${w.title} at ${w.company}`, ...w.bullets]),
    ...p.projects.flatMap((pr) => [pr.name, pr.description, ...pr.bullets]),
    p.skills.map((s) => s.name).join(", "),
  ]
    .filter(Boolean)
    .join("\n");
}

const SENIORITY_RANK: Record<Seniority, number> = Object.fromEntries(SENIORITIES.map((s, i) => [s, i])) as Record<Seniority, number>;

function inferProfileSeniority(years: number): Seniority {
  if (years < 1) return "entry";
  if (years < 3) return "entry";
  if (years < 6) return "mid";
  if (years < 10) return "senior";
  return "staff";
}

function locationOk(job: JobForScoring, prefs: Preferences): { ok: boolean; reason?: string } {
  const remoteKind = job.requirements.remote === "unknown" ? (job.remote ? "remote" : "unknown") : job.requirements.remote;
  if (prefs.remotePolicy === "remote_only" && remoteKind !== "remote" && remoteKind !== "unknown") {
    return { ok: false, reason: `Role is ${remoteKind}; you want remote only` };
  }
  if (remoteKind === "remote" || prefs.locations.length === 0) return { ok: true };
  if (prefs.remotePolicy === "any" || prefs.remotePolicy === "onsite_ok" || (prefs.remotePolicy === "hybrid_ok" && remoteKind !== "onsite")) {
    const loc = normalizeText(`${job.location} ${job.requirements.locationConstraints.join(" ")}`);
    const hit = prefs.locations.some((l) => {
      const nl = normalizeText(l);
      return nl === "anywhere" || (nl.length > 1 && loc.includes(nl));
    });
    return hit || !loc ? { ok: true } : { ok: false, reason: `Location "${job.location}" is outside your preferred locations` };
  }
  return { ok: false, reason: `Role is ${remoteKind}; your policy is ${prefs.remotePolicy}` };
}

export async function scoreJob(profile: ProfileData, prefs: Preferences, job: JobForScoring): Promise<ScoreBreakdown> {
  const req = job.requirements;
  const vetoReasons: string[] = [];
  const reasons: string[] = [];

  /* ---------------------------- hard filters ---------------------------- */
  if (prefs.companyExclude.some((c) => normalizeText(c) && normalizeText(job.company).includes(normalizeText(c)))) {
    vetoReasons.push(`${job.company} is on your excluded companies list`);
  }
  const loc = locationOk(job, prefs);
  if (!loc.ok && loc.reason) vetoReasons.push(loc.reason);
  if (prefs.requiresSponsorship && req.sponsorshipAvailable === false) vetoReasons.push("Posting says visa sponsorship is not available");
  if (req.workAuthorization && /clearance|citizen/i.test(req.workAuthorization) && prefs.workAuthorization) {
    const needsClearance = /clearance/i.test(req.workAuthorization);
    if (needsClearance && !/clearance/i.test(prefs.workAuthorization)) vetoReasons.push(`Requires: ${req.workAuthorization}`);
  }
  if (req.industry && prefs.industriesExclude.some((i) => textMentions(req.industry ?? "", i))) {
    vetoReasons.push(`Industry "${req.industry}" is excluded`);
  }

  /* ------------------------------- skills ------------------------------- */
  const confirmed = profile.skills.filter((s) => s.confirmed);
  const skillPool = confirmed.length ? confirmed : profile.skills;
  const fullText = profileText(profile);
  const matchedSkills: string[] = [];
  const missingSkills: string[] = [];
  const hit = (term: string) => !!findSkill(skillPool, term) || textMentions(fullText, term);
  for (const s of req.mustHaveSkills) (hit(s) ? matchedSkills : missingSkills).push(s);
  const niceHits = req.niceToHaveSkills.filter(hit);
  const mustRatio = req.mustHaveSkills.length ? matchedSkills.length / req.mustHaveSkills.length : 0.6;
  const niceRatio = req.niceToHaveSkills.length ? niceHits.length / req.niceToHaveSkills.length : 0.5;
  const skills = WEIGHTS.skills * (0.8 * mustRatio + 0.2 * niceRatio);
  if (req.mustHaveSkills.length) reasons.push(`Meets ${matchedSkills.length} of ${req.mustHaveSkills.length} required skills`);

  /* ------------------------------ semantic ------------------------------ */
  const sim = await semanticSimilarity(fullText, `${job.title}\n${req.roleSummary}\n${req.keyResponsibilities.join("\n")}\n${job.descriptionText.slice(0, 6000)}`);
  const semantic = WEIGHTS.semantic * sim.score;

  /* ----------------------------- experience ----------------------------- */
  const years = yearsOfExperience(profile);
  let expRatio = 1;
  if (req.minYearsExperience != null && req.minYearsExperience > 0) {
    const gap = req.minYearsExperience - years;
    expRatio = gap <= 0 ? 1 : gap <= 1 ? 0.75 : gap <= 3 ? 0.4 : 0.1;
    reasons.push(`${years} years of experience vs ${req.minYearsExperience}+ required`);
  }
  if (req.seniority) {
    const mine = prefs.seniority.length ? prefs.seniority : [inferProfileSeniority(years)];
    const distance = Math.min(...mine.map((m) => Math.abs(SENIORITY_RANK[m] - SENIORITY_RANK[req.seniority!])));
    if (distance >= 2) {
      expRatio *= 0.5;
      reasons.push(`Seniority "${req.seniority}" differs from your target`);
    }
    if (distance >= 3 && prefs.seniority.length) vetoReasons.push(`Seniority "${req.seniority}" is far from your target levels`);
  }
  const titleWords = new Set(normalizeText(job.title).split(" ").filter((w) => w.length > 3));
  const titleLineage = profile.work.some((w) => normalizeText(w.title).split(" ").some((x) => titleWords.has(x)));
  const experience = WEIGHTS.experience * (0.8 * expRatio + (titleLineage ? 0.2 : 0));

  /* ----------------------------- preference ----------------------------- */
  let pref = 0.5;
  if (prefs.targetTitles.length) {
    const titleHit = prefs.targetTitles.some((t) => {
      const words = normalizeText(t).split(" ").filter((w) => w.length > 2);
      const jt = normalizeText(job.title);
      return words.length > 0 && words.every((w) => jt.includes(w));
    });
    const partial = prefs.targetTitles.some((t) => normalizeText(t).split(" ").some((w) => w.length > 3 && normalizeText(job.title).includes(w)));
    pref = titleHit ? 1 : partial ? 0.6 : 0.15;
    if (titleHit) reasons.push("Title matches your target roles");
  }
  const salaryMax = job.salaryMax ?? req.salaryMax;
  if (prefs.salaryFloor > 0 && salaryMax != null) {
    if (salaryMax < prefs.salaryFloor) {
      pref *= 0.3;
      reasons.push(`Top of salary range ${salaryMax.toLocaleString()} is below your floor`);
    } else reasons.push("Salary range meets your floor");
  }
  if (prefs.industriesInclude.length && req.industry) {
    if (prefs.industriesInclude.some((i) => textMentions(req.industry ?? "", i))) pref = Math.min(1, pref + 0.2);
  }
  const preference = WEIGHTS.preference * pref;

  const raw = skills + semantic + experience + preference;
  const total = vetoReasons.length ? 0 : Math.round(raw);
  if (missingSkills.length) reasons.push(`Missing: ${missingSkills.slice(0, 5).join(", ")}`);

  return {
    vetoed: vetoReasons.length > 0,
    vetoReasons,
    skills: round1(skills),
    semantic: round1(semantic),
    experience: round1(experience),
    preference: round1(preference),
    total,
    matchedSkills,
    missingSkills,
    reasons,
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
