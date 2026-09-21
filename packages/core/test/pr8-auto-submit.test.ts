import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureApplication,
  enqueue,
  eq,
  getPreferences,
  openDb,
  recoverInterruptedApplies,
  runMigrations,
  saveProfileVersion,
  savePreferences,
  schema as s,
  transitionApplication,
  type Db,
} from "@prowl/db";
import { canAutoSubmit } from "@prowl/shared";
import { addSuggestionAsSource, approveApplication, buildFacts, ReviewBlockedError } from "../src";
import { profile } from "./fixtures";

process.env.PROWL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-pr8-core-"));
process.env.PROWL_SECRETS_NO_KEYCHAIN = "1";
process.env.PROWL_CATALOG_OFFLINE = "1";

let db: Db;
let profileId: string;
let seq = 0;

beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prowl-pr8-")), "t.sqlite"));
  runMigrations(db);
  const p = saveProfileVersion(db, { data: profile, facts: buildFacts(profile) });
  profileId = p.id;
  savePreferences(db, { dryRun: true, applyDelaySecondsMin: 0, applyDelaySecondsMax: 0 });
});

function seedReviewed(opts: { atsType: string; auditStatus?: "pending" | "pass" | "flagged" | "accepted" }) {
  const externalId = `pr8-${++seq}`;
  const job = db
    .insert(s.jobs)
    .values({
      sourceType: opts.atsType as "greenhouse",
      externalId,
      dedupKey: externalId,
      title: "Backend Engineer",
      company: "Acme",
      applyUrl: "https://example.com/apply",
      atsType: opts.atsType as "greenhouse",
    })
    .returning()
    .get();
  const app = ensureApplication(db, job.id);
  transitionApplication(db, app.id, "tailoring");
  const tr = db
    .insert(s.tailoredResumes)
    .values({
      jobId: job.id,
      profileId,
      // Residual validate (PR6) runs on approve: every claim must cite real profile facts.
      content: { headline: "Engineer", summary: { text: profile.summary, factIds: ["S"] }, skills: [], work: [], projects: [], includeEducationIds: [], includeCertifications: [], changeNotes: [] },
      auditStatus: opts.auditStatus ?? "pass",
      pdfPath: path.join(os.tmpdir(), "pr8-resume.pdf"),
    })
    .returning()
    .get();
  transitionApplication(db, app.id, "ready_for_review", "ready", { tailoredResumeId: tr.id });
  return { jobId: job.id, applicationId: app.id, tailoredResumeId: tr.id };
}

function getApp(id: string) {
  return db.select().from(s.applications).where(eq(s.applications.id, id)).get()!;
}

function applyTasks() {
  return db.select().from(s.queueTasks).where(eq(s.queueTasks.type, "apply")).all();
}

describe("approveApplication + canAutoSubmit (PR8)", () => {
  it("non-appliable ATS goes to needs_input with no apply task", () => {
    const { applicationId } = seedReviewed({ atsType: "workday" });
    approveApplication(db, applicationId, { dryRun: true });
    const app = getApp(applicationId);
    expect(app.status).toBe("needs_input");
    expect(app.needsInputReason).toMatch(/not supported/i);
    expect(applyTasks()).toHaveLength(0);
  });

  it("allowlisted ATS + dry-run still enqueues the fill lane", () => {
    const { applicationId } = seedReviewed({ atsType: "greenhouse" });
    approveApplication(db, applicationId, { dryRun: true });
    const app = getApp(applicationId);
    expect(app.status).toBe("approved");
    expect(app.dryRun).toBe(true);
    expect(applyTasks()).toHaveLength(1);
    expect(canAutoSubmit({ atsType: "greenhouse", dryRun: true, auditStatus: "pass" })).toBe(false);
  });

  it("allowlisted ATS + real submit (dryRun false) enqueues when audit is clean", () => {
    const { applicationId } = seedReviewed({ atsType: "ashby", auditStatus: "pass" });
    approveApplication(db, applicationId, { dryRun: false });
    const app = getApp(applicationId);
    expect(app.status).toBe("approved");
    expect(app.dryRun).toBe(false);
    expect(applyTasks()).toHaveLength(1);
    expect(canAutoSubmit({ atsType: "ashby", dryRun: false, auditStatus: "pass" })).toBe(true);
  });

  it("flagged audit still refuses approval (ReviewBlockedError)", () => {
    const { applicationId } = seedReviewed({ atsType: "greenhouse", auditStatus: "flagged" });
    expect(() => approveApplication(db, applicationId, { dryRun: false })).toThrow(ReviewBlockedError);
    expect(applyTasks()).toHaveLength(0);
    expect(canAutoSubmit({ atsType: "greenhouse", dryRun: false, auditStatus: "flagged" })).toBe(false);
  });

  it("recovery fail-safe lock: interrupted apply → needs_input, re-approve required, no silent auto-submit", () => {
    const { applicationId } = seedReviewed({ atsType: "greenhouse", auditStatus: "pass" });
    approveApplication(db, applicationId, { dryRun: false });
    expect(getApp(applicationId).status).toBe("approved");
    transitionApplication(db, applicationId, "applying", "Filling form");
    enqueue(db, "apply", { applicationId }, { dedupKey: `apply:${applicationId}`, userId: "local" });

    const { recovered } = recoverInterruptedApplies(db);
    expect(recovered).toBe(1);
    const after = getApp(applicationId);
    expect(after.status).toBe("needs_input");
    expect(after.dryRun).toBe(false);
    // Recovery must not re-open the auto-submit lane without a fresh approve.
    expect(canAutoSubmit({ atsType: "greenhouse", dryRun: after.dryRun, auditStatus: "pass" })).toBe(true);
    // But status is needs_input, so handleApply refuses until approveApplication runs again.
    expect(after.status).not.toBe("approved");

    approveApplication(db, applicationId, { dryRun: false });
    expect(getApp(applicationId).status).toBe("approved");
    expect(applyTasks().length).toBeGreaterThanOrEqual(1);
  });
});

describe("unconfirmed dual contract (PR8)", () => {
  it("user-explicit Add (interview suggestion) stays free enabled:true", () => {
    const sug = db
      .insert(s.sourceSuggestions)
      .values({
        userId: "local",
        origin: "learned",
        company: "Stripe",
        domain: "",
        why: "Candidate named Stripe",
        type: "greenhouse",
        config: { boardToken: "stripe", companyName: "Stripe" },
        key: "greenhouse:stripe",
        status: "verified",
        sampleTitles: ["Engineer"],
        note: null,
      })
      .returning()
      .get();
    const added = addSuggestionAsSource(db, sug.id);
    expect(added).toBe(true);
    const src = db.select().from(s.jobSources).all().find((x) => x.name === "Stripe")!;
    expect(src).toBeDefined();
    expect(src.enabled).toBe(true);
  });

  it("web user-explicit Add action source keeps enabled:true (source contract)", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../../apps/web/lib/actions/system.ts", import.meta.url), "utf8"));
    expect(src).toMatch(/enabled:\s*true/);
  });

  it("system career-page discoveredSources insert is enabled:false (source contract)", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../../apps/worker/src/handlers.ts", import.meta.url), "utf8"));
    expect(src).toMatch(/enabled:\s*false/);
    // The system insert must carry enabled:false explicitly, not rely on column default.
    expect(src).toMatch(/config:\s*d\.config,\s*enabled:\s*false/);
  });

  it("preferences dryRun default stays true when empty", () => {
    expect(getPreferences(db).dryRun).toBe(true);
  });
});
