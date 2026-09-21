import { describe, expect, it } from "vitest";
import {
  APPLIABLE_ATS,
  ATS_TYPES,
  Preferences,
  TRANSITIONS,
  canAutoSubmit,
  canTransition,
  type ApplicationStatus,
} from "../src";

describe("TRANSITIONS / canTransition", () => {
  it("exports a total map over every application status", () => {
    const statuses: ApplicationStatus[] = ["matched", "tailoring", "ready_for_review", "approved", "applying", "needs_input", "submitted", "failed", "skipped", "rejected_by_user"];
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...statuses].sort());
  });

  it("allows the hardbaked legal edges and rejects illegal ones", () => {
    expect(canTransition("matched", "tailoring")).toBe(true);
    expect(canTransition("ready_for_review", "approved")).toBe(true);
    expect(canTransition("approved", "applying")).toBe(true);
    expect(canTransition("applying", "needs_input")).toBe(true);
    expect(canTransition("needs_input", "approved")).toBe(true);
    expect(canTransition("applying", "approved")).toBe(true);
    expect(canTransition("submitted", "approved")).toBe(false);
    expect(canTransition("matched", "approved")).toBe(false);
    expect(canTransition("applying", "submitted")).toBe(true);
  });

  it("treats identity as legal (same-status is a no-op)", () => {
    expect(canTransition("approved", "approved")).toBe(true);
    expect(canTransition("submitted", "submitted")).toBe(true);
  });
});

describe("APPLIABLE_ATS", () => {
  it("allowlists only greenhouse, lever, ashby", () => {
    expect([...APPLIABLE_ATS]).toEqual(["greenhouse", "lever", "ashby"]);
  });

  it("does not include aggregator/unknown ATS types", () => {
    for (const t of ["workday", "smartrecruiters", "linkedin", "indeed", "other"] as const) {
      expect(APPLIABLE_ATS).not.toContain(t);
      expect(ATS_TYPES).toContain(t);
    }
  });
});

describe("Preferences dryRun default (fail-closed)", () => {
  it("defaults dryRun to true", () => {
    expect(Preferences.parse({}).dryRun).toBe(true);
  });

  it("keeps dryRun true when other prefs are set", () => {
    expect(Preferences.parse({ targetTitles: ["PM"], dailyApplyCap: 3 }).dryRun).toBe(true);
  });
});

describe("canAutoSubmit (PR8 shared gate)", () => {
  it("allows real submit only for allowlisted ATS + dryRun false + clean audit", () => {
    for (const atsType of APPLIABLE_ATS) {
      expect(canAutoSubmit({ atsType, dryRun: false, auditStatus: "pass" })).toBe(true);
      expect(canAutoSubmit({ atsType, dryRun: false, auditStatus: "accepted" })).toBe(true);
      expect(canAutoSubmit({ atsType, dryRun: false, auditStatus: "pending" })).toBe(true);
    }
  });

  it("refuses dry-run, default/missing dryRun, and flagged audits", () => {
    expect(canAutoSubmit({ atsType: "greenhouse", dryRun: true, auditStatus: "pass" })).toBe(false);
    expect(canAutoSubmit({ atsType: "greenhouse", dryRun: null, auditStatus: "pass" })).toBe(false);
    expect(canAutoSubmit({ atsType: "greenhouse", dryRun: undefined, auditStatus: "pass" })).toBe(false);
    expect(canAutoSubmit({ atsType: "greenhouse", dryRun: false, auditStatus: "flagged" })).toBe(false);
  });

  it("refuses non-allowlisted, missing, and unknown ATS types", () => {
    for (const atsType of ["workday", "smartrecruiters", "linkedin", "indeed", "other", null, undefined, ""]) {
      expect(canAutoSubmit({ atsType, dryRun: false, auditStatus: "pass" })).toBe(false);
    }
  });
});
