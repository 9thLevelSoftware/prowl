import { describe, expect, it } from "vitest";
import { CoverLetterOut, type CoverLetter, type TailoredResume } from "@prowl/shared";
import {
  buildFacts,
  extractNumbers,
  partitionStoredIssues,
  residualValidateErrors,
  toStoredStructuralIssues,
  unsupportedNumbers,
  validateTailored,
  validateCoverLetter,
} from "../src";
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

function letter(paragraphs: { text: string; factIds: string[] }[]): CoverLetter {
  return { greeting: "Dear Hiring Team,", paragraphs, closing: "Best,", signature: "Jordan Rivera" };
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

describe("validateCoverLetter (PR 6 parity)", () => {
  it("flags invented numbers in paragraphs", () => {
    const issues = validateCoverLetter(facts, letter([{ text: "At Paylane I cut latency by 70%.", factIds: ["W1.2"] }]));
    expect(issues[0]?.message).toContain("70%");
  });

  it("treats empty factIds as an error (parity with resume)", () => {
    const issues = validateCoverLetter(facts, letter([{ text: "I would love to join your team.", factIds: [] }]));
    expect(issues).toEqual([{ location: "cover:0", severity: "error", message: "Claim cites no profile facts" }]);
  });

  it("does not fall back to all profile facts when citations are empty", () => {
    // 40% and 3 appear in the profile; the old code used the full ledger as the corpus
    // and would not error on empty citations. Empty factIds must error, not pass.
    const issues = validateCoverLetter(facts, letter([{ text: "I cut latency by 40% and mentored 3 engineers.", factIds: [] }]));
    expect(issues.map((i) => i.message)).toEqual(["Claim cites no profile facts"]);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
  });

  it("does not treat unknown-only citations as supported by the full profile", () => {
    const issues = validateCoverLetter(facts, letter([{ text: "I cut latency by 40%.", factIds: ["NOPE"] }]));
    expect(issues.some((i) => i.message.includes("unknown fact ids: NOPE"))).toBe(true);
    // No valid citations → numbers are not silently accepted via whole-profile fallback.
    expect(issues.some((i) => i.message.includes("40%"))).toBe(false);
  });

  it("checks numbers only against valid cited facts when some ids are unknown", () => {
    const issues = validateCoverLetter(facts, letter([{ text: "I cut latency by 70%.", factIds: ["W1.2", "GHOST"] }]));
    expect(issues.some((i) => i.message.includes("unknown fact ids: GHOST"))).toBe(true);
    expect(issues.some((i) => i.message.includes("70%"))).toBe(true);
  });

  it("passes a cited paragraph whose numbers are supported", () => {
    const issues = validateCoverLetter(facts, letter([{ text: "I built a TypeScript payments API handling 2M requests per day.", factIds: ["W1.1"] }]));
    expect(issues).toEqual([]);
  });
});

describe("CoverLetterOut Zod parse (cover edit path)", () => {
  it("rejects malformed cover edit payloads before validate/render", () => {
    expect(() => CoverLetterOut.parse({ greeting: "Hi" })).toThrow();
    expect(() => CoverLetterOut.parse({ greeting: "Hi", paragraphs: [{ text: "x" }], closing: "Bye", signature: "Me" })).toThrow();
    expect(() => CoverLetterOut.parse({ greeting: "Hi", paragraphs: "nope", closing: "Bye", signature: "Me" })).toThrow();
  });

  it("accepts a well-formed letter including empty factIds (validate emits the error)", () => {
    const parsed = CoverLetterOut.parse(letter([{ text: "Hello", factIds: [] }]));
    expect(parsed.paragraphs[0]?.factIds).toEqual([]);
  });
});

describe("residualValidateErrors + structural storage split", () => {
  it("names residual resume and cover errors", () => {
    const residual = residualValidateErrors(
      profile,
      facts,
      tailored({ work: [{ workId: "w1", bullets: [{ text: "Invented claim", factIds: [] }] }] }),
      letter([{ text: "Uncited cover claim.", factIds: [] }]),
    );
    expect(residual.some((r) => r.startsWith("resume work:w1:0:") && r.includes("cites no profile facts"))).toBe(true);
    expect(residual.some((r) => r.startsWith("cover cover:0:") && r.includes("cites no profile facts"))).toBe(true);
  });

  it("returns empty when resume and cover are clean", () => {
    expect(residualValidateErrors(profile, facts, tailored(), letter([{ text: "Built a TypeScript payments API serving 2M requests per day.", factIds: ["W1.1"] }]))).toEqual([]);
  });

  it("stores errors separately from fixed issues", () => {
    const stored = toStoredStructuralIssues([
      { location: "work:w1:0", severity: "error", message: "Claim cites no profile facts" },
      { location: "skills", severity: "fixed", message: 'Removed "Rust": not a confirmed skill in your profile' },
    ]);
    const { errors, fixed } = partitionStoredIssues(stored);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("cites no profile facts");
    expect(fixed).toHaveLength(1);
    expect(fixed[0]?.message).toContain("Rust");
  });

  it("treats legacy string storage as display notes, not residual errors", () => {
    const { errors, fixed } = partitionStoredIssues(["work:w1:0: Claim cites no profile facts", { location: "x", severity: "error", message: "still bad" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("still bad");
    expect(fixed).toHaveLength(1);
  });
});