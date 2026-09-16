import { z } from "zod";
import type { LlmClient } from "@jh/llm";
import {
  ProfileData,
  ProfileExtractOut,
  type ProfileFact,
  type ProfileData as ProfileDataT,
} from "@jh/shared";

const EXTRACT_SYSTEM = `You convert resumes into structured JSON.
Rules:
- Copy facts exactly as written. Do not rewrite, embellish, summarize, or infer anything that is not on the page.
- Bullets must be copied verbatim (fix only broken line-wrapping).
- Dates: use YYYY-MM when a month is given, YYYY when only a year is given, "present" for current roles, "" when absent.
- Skills: list every distinct tool, technology, language, methodology, or domain skill that is explicitly named anywhere in the resume. Use a short category such as "Languages", "Cloud", "Tools", "Methods", "Domain".
- Use empty strings or empty arrays for anything missing. Never invent contact details.`;

let counter = 0;
const shortId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Parse resume text into a profile. Extracted skills start unconfirmed until the user reviews them. */
export async function extractProfile(llm: LlmClient, resumeText: string): Promise<ProfileDataT> {
  const out = await llm.object({ task: "extract_profile", tier: "fast" }, ProfileExtractOut, {
    system: EXTRACT_SYSTEM,
    prompt: `Resume text:\n"""\n${resumeText}\n"""`,
  });
  return fromExtraction(out);
}

export function fromExtraction(out: z.infer<typeof ProfileExtractOut>): ProfileDataT {
  const seen = new Set<string>();
  return ProfileData.parse({
    contact: out.contact,
    headline: out.headline,
    summary: out.summary,
    work: out.work.map((w) => ({ ...w, id: shortId("w") })),
    education: out.education.map((e) => ({ ...e, id: shortId("e") })),
    skills: out.skills
      .filter((s) => {
        const k = s.name.trim().toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((s) => ({ name: s.name.trim(), category: s.category || "General", aliases: [], confirmed: false })),
    certifications: out.certifications,
    projects: out.projects.map((p) => ({ ...p, id: shortId("p") })),
  });
}

/** Ensure every entry has a stable id (editor-created rows may not). */
export function normalizeProfile(p: ProfileDataT): ProfileDataT {
  const parsed = ProfileData.parse(p);
  return {
    ...parsed,
    work: parsed.work.map((w) => ({ ...w, id: w.id || shortId("w"), bullets: w.bullets.map((b) => b.trim()).filter(Boolean) })),
    education: parsed.education.map((e) => ({ ...e, id: e.id || shortId("e") })),
    projects: parsed.projects.map((pr) => ({ ...pr, id: pr.id || shortId("p"), bullets: pr.bullets.map((b) => b.trim()).filter(Boolean) })),
    skills: parsed.skills.filter((s) => s.name.trim()),
  };
}

/**
 * Atomize the profile into citable facts. IDs are deterministic from structure so the
 * same profile always yields the same ledger, which keeps prompts cache-friendly.
 */
export function buildFacts(p: ProfileDataT): ProfileFact[] {
  const facts: ProfileFact[] = [];
  if (p.summary.trim()) facts.push({ id: "S", kind: "summary", text: p.summary.trim(), refId: "" });
  p.work.forEach((w, wi) => {
    const dates = [w.startDate, w.endDate].filter(Boolean).join(" to ");
    facts.push({
      id: `W${wi + 1}`,
      kind: "role",
      text: `${w.title} at ${w.company}${w.location ? ` (${w.location})` : ""}${dates ? `, ${dates}` : ""}`,
      refId: w.id,
    });
    w.bullets.forEach((b, bi) => facts.push({ id: `W${wi + 1}.${bi + 1}`, kind: "bullet", text: b, refId: w.id }));
  });
  p.projects.forEach((pr, pi) => {
    facts.push({ id: `P${pi + 1}`, kind: "project", text: `${pr.name}${pr.description ? `: ${pr.description}` : ""}`, refId: pr.id });
    pr.bullets.forEach((b, bi) => facts.push({ id: `P${pi + 1}.${bi + 1}`, kind: "bullet", text: b, refId: pr.id }));
  });
  p.education.forEach((e, ei) => {
    facts.push({
      id: `E${ei + 1}`,
      kind: "education",
      text: [e.degree, e.field, e.institution, [e.startDate, e.endDate].filter(Boolean).join(" to ")].filter(Boolean).join(", "),
      refId: e.id,
    });
    e.details.forEach((d, di) => facts.push({ id: `E${ei + 1}.${di + 1}`, kind: "education", text: d, refId: e.id }));
  });
  p.skills
    .filter((s) => s.confirmed)
    .forEach((s, si) => {
      facts.push({
        id: `K${si + 1}`,
        kind: "skill",
        text: `Skill: ${s.name}${s.aliases.length ? ` (also known as ${s.aliases.join(", ")})` : ""}`,
        refId: s.name,
      });
    });
  p.certifications.forEach((c, ci) =>
    facts.push({ id: `C${ci + 1}`, kind: "certification", text: [c.name, c.issuer, c.date].filter(Boolean).join(", "), refId: c.name }),
  );
  if (p.additionalContext.trim()) facts.push({ id: "X", kind: "context", text: p.additionalContext.trim(), refId: "" });
  return facts;
}

export function factsToPrompt(facts: ProfileFact[]): string {
  return facts.map((f) => `[${f.id}] (${f.kind}) ${f.text}`).join("\n");
}

/* ------------------------- Guided resume builder ------------------------ */

const DraftBulletsOut = z.object({
  bullets: z.array(z.string()),
  questions: z.array(z.string()).describe("Questions whose answers would let the user add concrete scope or results. Never assume the answers."),
});

/**
 * Turn a user's rough notes about a role into resume bullets. The notes are the only source:
 * no numbers, tools, or outcomes may appear that the notes do not state.
 */
export async function draftBulletsFromNotes(
  llm: LlmClient,
  input: { title: string; company: string; notes: string },
): Promise<z.infer<typeof DraftBulletsOut>> {
  return llm.object({ task: "builder_bullets", tier: "smart" }, DraftBulletsOut, {
    system: `You help a job seeker write resume bullets from their own notes.
Write 2-6 concise, achievement-oriented bullets that start with a strong past-tense verb.
Use ONLY information in the notes. Do not add metrics, percentages, team sizes, tools, technologies, or outcomes that the notes do not state.
If a bullet would be stronger with a number the notes do not give, leave the number out and add a question asking the user for it instead.`,
    prompt: `Role: ${input.title} at ${input.company}\nNotes from the candidate:\n"""\n${input.notes}\n"""`,
  });
}

const SummaryOut = z.object({ headline: z.string(), summary: z.string() });

export async function draftSummary(llm: LlmClient, profile: ProfileDataT): Promise<z.infer<typeof SummaryOut>> {
  const facts = buildFacts({ ...profile, summary: "" });
  return llm.object({ task: "builder_summary", tier: "smart" }, SummaryOut, {
    system: `Write a resume headline (under 12 words) and a 2-3 sentence professional summary.
Use only the facts provided. Do not invent years of experience, metrics, industries, or skills. Avoid clichés like "results-driven" or "passionate".`,
    prompt: `Facts:\n${factsToPrompt(facts)}`,
  });
}

/* ----------------------------- Experience ------------------------------ */

function parseYm(s: string, isEnd: boolean): number | null {
  const v = s.trim().toLowerCase();
  if (!v) return null;
  if (v === "present" || v === "current" || v === "now") {
    const d = new Date();
    return d.getFullYear() * 12 + d.getMonth();
  }
  const m = /^(\d{4})(?:-(\d{1,2}))?/.exec(v);
  if (!m) return null;
  const month = m[2] ? Number(m[2]) - 1 : isEnd ? 11 : 0;
  return Number(m[1]) * 12 + month;
}

/** Total years of professional experience, merging overlapping roles. */
export function yearsOfExperience(p: ProfileDataT): number {
  const ranges = p.work
    .map((w) => [parseYm(w.startDate, false), parseYm(w.endDate || "present", true)] as const)
    .filter((r): r is readonly [number, number] => r[0] !== null && r[1] !== null && r[1] >= r[0])
    .map(([a, b]) => [a, b] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let months = 0;
  let cur: [number, number] | null = null;
  for (const r of ranges) {
    if (!cur) cur = [...r];
    else if (r[0] <= cur[1] + 1) cur[1] = Math.max(cur[1], r[1]);
    else {
      months += cur[1] - cur[0] + 1;
      cur = [...r];
    }
  }
  if (cur) months += cur[1] - cur[0] + 1;
  return Math.round((months / 12) * 10) / 10;
}
