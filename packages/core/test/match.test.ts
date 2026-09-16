import { describe, expect, it } from "vitest";
import { findSkill, scoreJob, termsEquivalent, textMentions, yearsOfExperience } from "../src";
import { prefs, profile, requirements } from "./fixtures";

const job = {
  title: "Senior Backend Engineer",
  company: "Fintechy",
  location: "Remote - US",
  remote: true,
  salaryMin: 150000,
  salaryMax: 190000,
  descriptionText: "We build payment APIs in TypeScript on Kubernetes with PostgreSQL.",
  requirements,
};

describe("skills", () => {
  it("matches synonyms and aliases", () => {
    expect(termsEquivalent("K8s", "Kubernetes")).toBe(true);
    expect(findSkill(profile.skills, "PostgreSQL")?.name).toBe("Postgres");
    expect(findSkill(profile.skills, "Kafka")).toBeUndefined();
    expect(textMentions("Deployed services on k8s", "Kubernetes")).toBe(true);
    expect(textMentions("Used Gopher tools", "Go")).toBe(false);
  });
});

describe("experience", () => {
  it("merges overlapping roles", () => {
    const years = yearsOfExperience({
      ...profile,
      work: [
        { ...profile.work[0]!, startDate: "2020-01", endDate: "2020-12" },
        { ...profile.work[1]!, startDate: "2020-06", endDate: "2021-12" },
      ],
    });
    expect(years).toBe(2);
  });
});

describe("scoreJob", () => {
  it("scores a strong match highly", async () => {
    const s = await scoreJob(profile, prefs, job);
    expect(s.vetoed).toBe(false);
    expect(s.matchedSkills).toEqual(["TypeScript", "PostgreSQL", "Kubernetes"]);
    expect(s.total).toBeGreaterThanOrEqual(65);
  });

  it("vetoes onsite roles for remote-only candidates", async () => {
    const s = await scoreJob(profile, prefs, { ...job, remote: false, requirements: { ...requirements, remote: "onsite" } });
    expect(s.vetoed).toBe(true);
    expect(s.total).toBe(0);
  });

  it("vetoes excluded companies", async () => {
    const s = await scoreJob(profile, { ...prefs, companyExclude: ["fintechy"] }, job);
    expect(s.vetoReasons[0]).toContain("excluded");
  });

  it("scores a mismatched role lower", async () => {
    const s = await scoreJob(profile, prefs, {
      ...job,
      title: "Registered Nurse",
      descriptionText: "Provide patient care in a hospital ICU.",
      requirements: { ...requirements, mustHaveSkills: ["RN license", "BLS", "ICU experience"], niceToHaveSkills: [], atsKeywords: ["RN"], seniority: null, minYearsExperience: 2, roleSummary: "ICU nurse", keyResponsibilities: ["Patient care"] },
    });
    expect(s.total).toBeLessThan(40);
  });
});
