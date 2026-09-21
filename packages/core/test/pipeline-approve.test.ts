import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureApplication,
  eq,
  openDb,
  runMigrations,
  savePreferences,
  saveProfileVersion,
  schema as s,
  transitionApplication,
  type Db,
} from "@prowl/db";
import type { CoverLetter, TailoredResume } from "@prowl/shared";
import { approveApplication, buildFacts, ReviewBlockedError } from "../src";
import { profile } from "./fixtures";

let db: Db;
let seq = 0;

const cleanResume: TailoredResume = {
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
};

const dirtyResume: TailoredResume = {
  ...cleanResume,
  work: [{ workId: "w1", bullets: [{ text: "Invented uncited claim with no facts", factIds: [] }] }],
};

const cleanCover: CoverLetter = {
  greeting: "Dear Hiring Team,",
  paragraphs: [{ text: "I built a TypeScript payments API serving 2M requests per day.", factIds: ["W1.1"] }],
  closing: "Best,",
  signature: "Jordan Rivera",
};

const dirtyCover: CoverLetter = {
  greeting: "Dear Hiring Team,",
  paragraphs: [{ text: "I would be thrilled to invent achievements here.", factIds: [] }],
  closing: "Best,",
  signature: "Jordan Rivera",
};

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-approve-"));
  db = openDb(path.join(dir, "t.sqlite"));
  runMigrations(db);
  savePreferences(db, { dryRun: true });
});

function seed(opts: {
  resume: TailoredResume;
  cover?: CoverLetter;
  resumeAudit?: "pass" | "flagged" | "accepted";
  coverAudit?: "pass" | "flagged" | "accepted";
}): string {
  const facts = buildFacts(profile);
  const saved = saveProfileVersion(db, { data: profile, facts });
  const externalId = `job-${++seq}`;
  const job = db
    .insert(s.jobs)
    .values({
      sourceType: "greenhouse",
      externalId,
      dedupKey: externalId,
      title: "Backend Engineer",
      company: "Acme",
      applyUrl: "https://example.com/apply",
      atsType: "greenhouse",
    })
    .returning()
    .get();
  const app = ensureApplication(db, job.id);
  transitionApplication(db, app.id, "tailoring");
  const tr = db
    .insert(s.tailoredResumes)
    .values({
      jobId: job.id,
      profileId: saved.id,
      content: opts.resume,
      auditStatus: opts.resumeAudit ?? "pass",
      structuralErrors: [],
    })
    .returning()
    .get();
  let coverLetterId: string | null = null;
  if (opts.cover) {
    const cl = db
      .insert(s.coverLetters)
      .values({
        jobId: job.id,
        tailoredResumeId: tr.id,
        content: opts.cover,
        auditStatus: opts.coverAudit ?? "pass",
        structuralErrors: [],
      })
      .returning()
      .get();
    coverLetterId = cl.id;
  }
  transitionApplication(db, app.id, "ready_for_review", "ready", { tailoredResumeId: tr.id, coverLetterId });
  return app.id;
}

describe("approveApplication residual validate gate (PR 6 / DR-3)", () => {
  it("approves when resume and cover validate clean and audits are not flagged", () => {
    const id = seed({ resume: cleanResume, cover: cleanCover, resumeAudit: "pass", coverAudit: "pass" });
    approveApplication(db, id, { dryRun: true });
    const app = db.select().from(s.applications).where(eq(s.applications.id, id)).get()!;
    expect(app.status).toBe("approved");
    expect(app.dryRun).toBe(true);
  });

  it("refuses when the resume has residual validate errors even if audits are clean", () => {
    const id = seed({ resume: dirtyResume, cover: cleanCover, resumeAudit: "pass", coverAudit: "pass" });
    expect(() => approveApplication(db, id, { dryRun: true })).toThrow(ReviewBlockedError);
    try {
      approveApplication(db, id, { dryRun: true });
    } catch (err) {
      expect((err as Error).message).toContain("Uncleared validation errors");
      expect((err as Error).message).toContain("resume work:w1:0");
      expect((err as Error).message).toContain("cites no profile facts");
    }
    const app = db.select().from(s.applications).where(eq(s.applications.id, id)).get()!;
    expect(app.status).toBe("ready_for_review");
  });

  it("refuses when the cover letter has residual validate errors even if audits are clean", () => {
    const id = seed({ resume: cleanResume, cover: dirtyCover, resumeAudit: "pass", coverAudit: "pass" });
    expect(() => approveApplication(db, id, { dryRun: true })).toThrow(ReviewBlockedError);
    try {
      approveApplication(db, id, { dryRun: true });
    } catch (err) {
      expect((err as Error).message).toContain("cover cover:0");
      expect((err as Error).message).toContain("cites no profile facts");
    }
  });

  it("still refuses flagged audits (held positive)", () => {
    const id = seed({ resume: cleanResume, cover: cleanCover, resumeAudit: "flagged", coverAudit: "pass" });
    expect(() => approveApplication(db, id, { dryRun: true })).toThrow(/truthfulness flags/);
  });

  it("still refuses when cover audits are flagged", () => {
    const id = seed({ resume: cleanResume, cover: cleanCover, resumeAudit: "pass", coverAudit: "flagged" });
    expect(() => approveApplication(db, id, { dryRun: true })).toThrow(/cover letter has unresolved truthfulness flags/);
  });

  it("approves after residual errors are cleared and audits stay clean", () => {
    const id = seed({ resume: dirtyResume, cover: dirtyCover, resumeAudit: "pass", coverAudit: "pass" });
    expect(() => approveApplication(db, id, { dryRun: true })).toThrow(ReviewBlockedError);

    const app = db.select().from(s.applications).where(eq(s.applications.id, id)).get()!;
    db.update(s.tailoredResumes).set({ content: cleanResume }).where(eq(s.tailoredResumes.id, app.tailoredResumeId!)).run();
    db.update(s.coverLetters).set({ content: cleanCover }).where(eq(s.coverLetters.id, app.coverLetterId!)).run();

    approveApplication(db, id, { dryRun: true });
    const after = db.select().from(s.applications).where(eq(s.applications.id, id)).get()!;
    expect(after.status).toBe("approved");
  });
});
