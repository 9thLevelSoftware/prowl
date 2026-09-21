import type { CoverLetter, ProfileData, TailoredResume } from "@prowl/shared";

/**
 * The fully resolved resume that gets rendered. Identity fields (company, title, dates, institution)
 * are always copied from the confirmed profile, never from model output, so tailoring cannot alter them.
 */
export interface ResolvedResume {
  contact: ProfileData["contact"];
  headline: string;
  summary: string;
  skills: { category: string; items: string[] }[];
  work: { company: string; title: string; location: string; dates: string; bullets: string[] }[];
  projects: { name: string; url: string; bullets: string[] }[];
  education: { institution: string; degree: string; dates: string; details: string[] }[];
  certifications: string[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(d: string): string {
  const v = d.trim();
  if (!v) return "";
  if (/^present$/i.test(v) || /^current$/i.test(v)) return "Present";
  const m = /^(\d{4})-(\d{1,2})/.exec(v);
  if (m) {
    const month = MONTHS[Number(m[2]) - 1];
    return month ? `${month} ${m[1]}` : m[1]!;
  }
  return v;
}

export function formatRange(start: string, end: string): string {
  const a = formatDate(start);
  const b = formatDate(end);
  if (a && b) return `${a} – ${b}`;
  return a || b;
}

function degreeLine(e: ProfileData["education"][number]): string {
  return [e.degree, e.field].filter(Boolean).join(", ");
}

/** Baseline resume straight from the profile. */
export function resolveBaseline(p: ProfileData): ResolvedResume {
  const bySkillCat = new Map<string, string[]>();
  // Once the user has confirmed any skills, the baseline shows only confirmed ones. That keeps it
  // consistent with tailored output and makes before/after keyword coverage a fair comparison.
  const skills = p.skills.some((s) => s.confirmed) ? p.skills.filter((s) => s.confirmed) : p.skills;
  for (const s of skills) {
    const list = bySkillCat.get(s.category || "Skills") ?? [];
    list.push(s.name);
    bySkillCat.set(s.category || "Skills", list);
  }
  return {
    contact: p.contact,
    headline: p.headline,
    summary: p.summary,
    skills: [...bySkillCat].map(([category, items]) => ({ category, items })),
    work: p.work.map((w) => ({
      company: w.company,
      title: w.title,
      location: w.location,
      dates: formatRange(w.startDate, w.endDate),
      bullets: w.bullets,
    })),
    projects: p.projects.map((pr) => ({ name: pr.name, url: pr.url, bullets: pr.bullets.length ? pr.bullets : pr.description ? [pr.description] : [] })),
    education: p.education.map((e) => ({
      institution: e.institution,
      degree: degreeLine(e),
      dates: formatRange(e.startDate, e.endDate),
      details: e.details,
    })),
    certifications: p.certifications.map((c) => [c.name, c.issuer, c.date].filter(Boolean).join(" · ")),
  };
}

/** Merge tailored content onto profile identity fields. Unknown ids are dropped (and reported by validation). */
export function resolveTailored(p: ProfileData, t: TailoredResume): ResolvedResume {
  const base = resolveBaseline(p);
  const tailoredWork = new Map(t.work.map((w) => [w.workId, w]));
  // Keep every role in chronological profile order. Employment history is never hidden,
  // because gaps created by tailoring would misrepresent the candidate.
  const work = p.work.map((w) => {
    const tw = tailoredWork.get(w.id);
    return {
      company: w.company,
      title: w.title,
      location: w.location,
      dates: formatRange(w.startDate, w.endDate),
      bullets: tw ? tw.bullets.map((b) => b.text) : w.bullets,
    };
  });
  const projById = new Map(p.projects.map((pr) => [pr.id, pr]));
  const projects = t.projects
    .map((tp) => {
      const pr = projById.get(tp.projectId);
      return pr ? { name: pr.name, url: pr.url, bullets: tp.bullets.map((b) => b.text) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const eduIds = new Set(t.includeEducationIds);
  const education = p.education
    .filter((e) => eduIds.size === 0 || eduIds.has(e.id))
    .map((e) => ({ institution: e.institution, degree: degreeLine(e), dates: formatRange(e.startDate, e.endDate), details: e.details }));
  const certNames = new Set(t.includeCertifications.map((c) => c.toLowerCase()));
  const certifications = p.certifications
    .filter((c) => certNames.size === 0 || certNames.has(c.name.toLowerCase()))
    .map((c) => [c.name, c.issuer, c.date].filter(Boolean).join(" · "));
  return {
    ...base,
    headline: t.headline || base.headline,
    summary: t.summary.text || base.summary,
    skills: t.skills.filter((g) => g.items.length),
    work,
    projects,
    education,
    certifications,
  };
}

export interface ResolvedCoverLetter {
  contact: ProfileData["contact"];
  date: string;
  company: string;
  jobTitle: string;
  greeting: string;
  paragraphs: string[];
  closing: string;
  signature: string;
}

export function resolveCoverLetter(p: ProfileData, c: CoverLetter, job: { company: string; title: string }): ResolvedCoverLetter {
  return {
    contact: p.contact,
    date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    company: job.company,
    jobTitle: job.title,
    greeting: c.greeting,
    paragraphs: c.paragraphs.map((x) => x.text),
    closing: c.closing,
    signature: c.signature || p.contact.fullName,
  };
}

/** Plain-text rendering, used for keyword coverage and semantic scoring. */
export function resumeToText(r: ResolvedResume): string {
  const lines: string[] = [r.contact.fullName, r.headline, r.summary];
  for (const g of r.skills) lines.push(`${g.category}: ${g.items.join(", ")}`);
  for (const w of r.work) lines.push(`${w.title} ${w.company} ${w.dates}`, ...w.bullets);
  for (const p of r.projects) lines.push(p.name, ...p.bullets);
  for (const e of r.education) lines.push(`${e.degree} ${e.institution}`, ...e.details);
  lines.push(...r.certifications);
  return lines.filter(Boolean).join("\n");
}
