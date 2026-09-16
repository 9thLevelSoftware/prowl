/**
 * Golden tests against a real LLM provider. They cost money/quota, so they only run with:
 *   JH_GOLDEN=1 pnpm test:golden
 * using the AI connection that is active on the Settings page (with its saved model and effort).
 */
import { describe, expect, it } from "vitest";
import { getDb, runMigrations } from "@jh/db";
import { getLlm } from "@jh/llm";
import type { TailoredResume } from "@jh/shared";
import { auditClaims, buildFacts, extractProfile, resumeClaims, tailorResume, validateTailored, writeCoverLetter, validateCoverLetter } from "../src";
import { prefs, profile, requirements } from "./fixtures";

const enabled = process.env.JH_GOLDEN === "1";
// Uses your real database so the active AI connection from Settings (and its saved model/effort) is used.
const db = getDb();
runMigrations(db);
const llm = getLlm(db);
const facts = buildFacts(profile);

const job = {
  id: "golden-job",
  title: "Senior Backend Engineer",
  company: "Fintechy",
  location: "Remote - US",
  descriptionText:
    "We build payment APIs in TypeScript and Go on Kubernetes with PostgreSQL. Requirements: 5+ years backend, TypeScript, PostgreSQL, Kubernetes. Nice to have: Kafka, event-driven systems, PCI compliance.",
  requirements,
};

describe.skipIf(!enabled)("golden: resume extraction", () => {
  it("copies facts verbatim and invents nothing", async () => {
    const text = `Jordan Rivera | jordan@example.com | 555-0100 | Austin, TX
SUMMARY
Backend engineer building payment APIs in TypeScript and Go.
EXPERIENCE
Senior Software Engineer, Paylane (Remote) Mar 2021 - Present
- Built a TypeScript payments API handling 2M requests per day
- Cut p95 latency by 40% by moving hot paths to Go
Software Engineer, ShopCo, Austin TX, Jun 2018 - Feb 2021
- Maintained PostgreSQL schemas for order service
EDUCATION
BS Computer Science, UT Austin, 2014-2018
SKILLS: TypeScript, Go, Postgres, K8s`;
    const p = await extractProfile(llm, text);
    expect(p.contact.fullName).toBe("Jordan Rivera");
    expect(p.work).toHaveLength(2);
    expect(p.work[0]!.startDate).toBe("2021-03");
    expect(p.work[0]!.endDate.toLowerCase()).toBe("present");
    expect(p.work[0]!.bullets).toContain("Built a TypeScript payments API handling 2M requests per day");
    const skillNames = p.skills.map((s) => s.name.toLowerCase());
    expect(skillNames).toEqual(expect.arrayContaining(["typescript", "go"]));
    expect(p.skills.every((s) => !s.confirmed)).toBe(true);
  }, 180_000);
});

describe.skipIf(!enabled)("golden: tailoring truthfulness", () => {
  it("produces a tailored resume with no structural errors and no audit flags", async () => {
    const t = await tailorResume(llm, profile, facts, job);
    expect(t.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(t.resume.skills.flatMap((g) => g.items)).not.toContain("Kafka");
    expect(t.resume.skills.flatMap((g) => g.items)).not.toContain("Rust");
    const audit = await auditClaims(llm, facts, resumeClaims(profile, t.resume), t.issues);
    const flagged = audit.items.filter((i) => i.verdict !== "entailed");
    expect(flagged, JSON.stringify(flagged, null, 2)).toEqual([]);
    expect(t.keywordCoverageAfter).toBeGreaterThanOrEqual(t.keywordCoverageBefore);
  }, 300_000);

  it("writes a cover letter that cites facts and invents no numbers", async () => {
    const t = await tailorResume(llm, profile, facts, job);
    const { letter, issues } = await writeCoverLetter(llm, profile, facts, t.resume, job, prefs);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(validateCoverLetter(facts, letter)).toEqual([]);
    expect(letter.signature).toContain("Jordan");
  }, 300_000);
});

describe.skipIf(!enabled)("golden: auditor catches fabrications", () => {
  const faithful: TailoredResume = {
    headline: "Senior Backend Engineer",
    summary: { text: "Backend engineer building payment APIs in TypeScript and Go.", factIds: ["S"] },
    skills: [{ category: "Languages", items: ["TypeScript", "Go"] }],
    work: [
      {
        workId: "w1",
        bullets: [
          { text: "Built a TypeScript payments API handling 2M requests per day", factIds: ["W1.1"] },
          { text: "Cut p95 latency by 40% by moving hot paths to Go", factIds: ["W1.2"] },
          { text: "Mentored 3 engineers", factIds: ["W1.3"] },
        ],
      },
    ],
    projects: [],
    includeEducationIds: [],
    includeCertifications: [],
    changeNotes: [],
  };

  const INJECTIONS: { name: string; bullet: string; factIds: string[] }[] = [
    { name: "invented tool", bullet: "Built a TypeScript and Kafka payments API handling 2M requests per day", factIds: ["W1.1"] },
    { name: "inflated ownership", bullet: "Architected and led the company-wide payments platform strategy", factIds: ["W1.1"] },
    { name: "invented outcome", bullet: "Cut p95 latency by moving hot paths to Go, saving $1.2M in annual infrastructure costs", factIds: ["W1.2"] },
    { name: "invented team scope", bullet: "Managed a team of 12 engineers across three time zones", factIds: ["W1.3"] },
    { name: "invented credential", bullet: "Built a PCI DSS certified payments API handling 2M requests per day", factIds: ["W1.1"] },
    { name: "invented employer claim", bullet: "Recognized as Paylane's Engineer of the Year for the payments API", factIds: ["W1.1"] },
  ];

  for (const inj of INJECTIONS) {
    it(`flags ${inj.name}`, async () => {
      const t: TailoredResume = structuredClone(faithful);
      t.work[0]!.bullets[1] = { text: inj.bullet, factIds: inj.factIds };
      const v = validateTailored(profile, facts, t);
      const audit = await auditClaims(llm, facts, resumeClaims(profile, v.resume), v.issues);
      const item = audit.items.find((i) => i.location === "work:w1:1");
      expect(item?.verdict, JSON.stringify(item)).not.toBe("entailed");
      expect(audit.overall).toBe("flagged");
    }, 180_000);
  }

  it("passes the faithful version", async () => {
    const v = validateTailored(profile, facts, faithful);
    const audit = await auditClaims(llm, facts, resumeClaims(profile, v.resume), v.issues);
    expect(audit.items.filter((i) => i.verdict !== "entailed"), JSON.stringify(audit.items)).toEqual([]);
  }, 180_000);
});
