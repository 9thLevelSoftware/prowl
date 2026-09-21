import { describe, expect, it } from "vitest";
import type { TailoredResume } from "@prowl/shared";
import { buildFacts, extractNumbers, unsupportedNumbers, validateTailored, validateCoverLetter } from "../src";
import { profile } from "./fixtures";

const facts = buildFacts(profile);

function tailored(over: Partial<TailoredResume> = {}): TailoredResume {
  return {
    headline: "Senior Backend Engineer",
    summary: { text: "Backend engineer building payment APIs in TypeScript and Go.", factIds: ["S"] },
    skills: [{ category: "Languages", items: ["TypeScript", "Go"] }],
    work: [
      { workId: "w1", bullets: [{ text: "Built a TypeScript payments API serving 2M requests per day", factIds: ["W1.1"] }] },
      { workId: "w2", bullets: [{ text: "Maintained PostgreSQL schemas for the order service", factIds: ["W2.1"] }] },
    ],
    projects: [],
    includeEducationIds: ["e1"],
    includeCertifications: ["AWS Certified Developer"],
    changeNotes: [],
    ...over,
  };
}

describe("fact ledger", () => {
  it("gives stable ids and includes only confirmed skills", () => {
    const ids = facts.map((f) => f.id);
    expect(ids).toContain("W1.2");
    expect(ids).toContain("E1");
    expect(facts.filter((f) => f.kind === "skill").map((f) => f.text).join()).not.toContain("Rust");
    expect(buildFacts(profile)).toEqual(facts);
  });
});

describe("number checks", () => {
  it("extracts numbers with units", () => {
    expect(extractNumbers("Cut latency 40% and saved $1.5M across 3 teams")).toEqual(["40%", "1.5m", "3"]);
  });
  it("flags invented metrics", () => {
    expect(unsupportedNumbers("Cut p95 latency by 60%", ["Cut p95 latency by 40% by moving hot paths to Go"])).toEqual(["60%"]);
    expect(unsupportedNumbers("Cut p95 latency by 40 percent", ["Cut p95 latency by 40% by moving hot paths to Go"])).toEqual([]);
    expect(unsupportedNumbers("Mentored three engineers", ["Mentored 3 engineers"])).toEqual([]);
    expect(unsupportedNumbers("Mentored five engineers", ["Mentored 3 engineers"])).toEqual(["5"]);
  });
});

describe("validateTailored", () => {
  it("passes a faithful rewrite", () => {
    const v = validateTailored(profile, facts, tailored());
    expect(v.errors).toEqual([]);
  });

  it("rejects bullets without citations and unknown fact ids", () => {
    const v = validateTailored(
      profile,
      facts,
      tailored({ work: [{ workId: "w1", bullets: [{ text: "Led platform strategy", factIds: [] }, { text: "Did things", factIds: ["W9.9"] }] }] }),
    );
    expect(v.errors.map((e) => e.message)).toEqual(["Claim cites no profile facts", "Cites unknown fact ids: W9.9"]);
  });

  it("rejects numbers that the cited fact does not contain", () => {
    const v = validateTailored(profile, facts, tailored({ work: [{ workId: "w1", bullets: [{ text: "Cut p95 latency by 55%", factIds: ["W1.2"] }] }] }));
    expect(v.errors[0]?.message).toContain("55%");
  });

  it("strips unconfirmed and invented skills but allows synonyms of confirmed skills", () => {
    const v = validateTailored(profile, facts, tailored({ skills: [{ category: "Tech", items: ["Kubernetes", "PostgreSQL", "Rust", "Kafka"] }] }));
    expect(v.resume.skills[0]?.items).toEqual(["Kubernetes", "PostgreSQL"]);
    expect(v.issues.filter((i) => i.severity === "fixed").map((i) => i.message)).toEqual([
      'Removed "Rust": not a confirmed skill in your profile',
      'Removed "Kafka": not a confirmed skill in your profile',
    ]);
  });

  it("drops unknown work ids and certifications not in the profile", () => {
    const v = validateTailored(profile, facts, tailored({ work: [{ workId: "nope", bullets: [] }], includeCertifications: ["CKA"] }));
    expect(v.resume.work).toEqual([]);
    expect(v.resume.includeCertifications).toEqual([]);
  });
});

describe("validateCoverLetter", () => {
  it("flags invented numbers in paragraphs", () => {
    const issues = validateCoverLetter(facts, {
      greeting: "Dear Hiring Team,",
      paragraphs: [{ text: "At Paylane I cut latency by 70%.", factIds: ["W1.2"] }],
      closing: "Best,",
      signature: "Jordan Rivera",
    });
    expect(issues[0]?.message).toContain("70%");
  });
});
