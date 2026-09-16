import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated data dir, headless bundled Chromium, and an LLM provider with no credentials:
// this proves the apply path works without any AI calls when answers are already saved.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jh-e2e-"));
process.env.JH_DATA_DIR = tmp;
process.env.JH_BROWSER_CHANNEL = "chromium";
process.env.JH_LLM_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "";
process.env.JH_SECRETS_NO_KEYCHAIN = "1";
process.env.JH_CATALOG_OFFLINE = "1";

const { openDb, runMigrations, saveProfileVersion, savePreferences, ensureApplication, transitionApplication, claimTask, completeTask, schema: s, eq } = await import("@jh/db");
const { LlmClient } = await import("@jh/llm");
const { ProfileData } = await import("@jh/shared");
const { buildFacts, approveApplication, ReviewBlockedError } = await import("@jh/core");
const { renderResumeFiles, renderCoverLetterFiles, resolveBaseline, resolveCoverLetter, closeRenderer } = await import("@jh/documents");
const { closeContext } = await import("@jh/browser");
const { handleApply } = await import("../src/handlers");
const { startMockAts } = await import("../../../packages/applier/test/mock-ats");

const db = openDb(path.join(tmp, "e2e.sqlite"));
runMigrations(db);
const llm = new LlmClient(db);
let mock: Awaited<ReturnType<typeof startMockAts>>;
let applicationId = "";

beforeAll(async () => {
  mock = await startMockAts();
  const data = ProfileData.parse({
    contact: { fullName: "Jordan Rivera", email: "jordan@example.com", phone: "555-0100", location: "Austin, TX", links: [{ label: "LinkedIn", url: "https://linkedin.com/in/jordan" }] },
    work: [{ id: "w1", company: "Paylane", title: "Senior Software Engineer", startDate: "2021-03", endDate: "present", bullets: ["Built payments APIs"] }],
    skills: [{ name: "TypeScript", confirmed: true }],
  });
  const profile = saveProfileVersion(db, { data, facts: buildFacts(data) });
  savePreferences(db, { headlessBrowser: true, dryRun: true, applyDelaySecondsMin: 0, applyDelaySecondsMax: 0 });
  db.insert(s.qaBank).values({ questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", approved: true }).run();

  const job = db
    .insert(s.jobs)
    .values({ sourceType: "greenhouse", externalId: "e2e", dedupKey: "e2e", title: "Backend Engineer", company: "Acme", applyUrl: `${mock.url}/greenhouse`, atsType: "greenhouse" })
    .returning()
    .get();
  const app = ensureApplication(db, job.id);
  applicationId = app.id;
  transitionApplication(db, app.id, "tailoring");

  const content = {
    headline: "Engineer",
    summary: { text: "Builds payments APIs", factIds: ["W1.1"] },
    skills: [{ category: "Languages", items: ["TypeScript"] }],
    work: [{ workId: "w1", bullets: [{ text: "Built payments APIs", factIds: ["W1.1"] }] }],
    projects: [],
    includeEducationIds: [],
    includeCertifications: [],
    changeNotes: [],
  };
  const files = await renderResumeFiles(resolveBaseline(data), { kind: "tailored", key: app.id, company: "Acme" });
  const tr = db.insert(s.tailoredResumes).values({ jobId: job.id, profileId: profile.id, content, auditStatus: "flagged", pdfPath: files.pdfPath }).returning().get();
  const letter = { greeting: "Dear Hiring Team,", paragraphs: [{ text: "I build payments APIs.", factIds: ["W1.1"] }], closing: "Best,", signature: "Jordan Rivera" };
  const clFiles = await renderCoverLetterFiles(resolveCoverLetter(data, letter, job), app.id);
  const cl = db.insert(s.coverLetters).values({ jobId: job.id, tailoredResumeId: tr.id, content: letter, auditStatus: "pass", pdfPath: clFiles.pdfPath }).returning().get();
  transitionApplication(db, app.id, "ready_for_review", "ready", { tailoredResumeId: tr.id, coverLetterId: cl.id });
}, 120_000);

afterAll(async () => {
  await closeContext();
  await closeRenderer();
  await mock?.close();
});

async function runQueuedApply() {
  const task = claimTask(db, "test", ["apply"]);
  expect(task).toBeDefined();
  await handleApply(db, llm, task!);
  completeTask(db, task!.id);
  return db.select().from(s.applications).where(eq(s.applications.id, applicationId)).get()!;
}

describe("worker apply flow", () => {
  it("refuses approval while truthfulness flags are unresolved", () => {
    expect(() => approveApplication(db, applicationId, { dryRun: true })).toThrow(ReviewBlockedError);
    db.update(s.tailoredResumes).set({ auditStatus: "pass" }).run();
  });

  it("dry run fills the form, records evidence, and does not submit", async () => {
    approveApplication(db, applicationId, { dryRun: true });
    const app = await runQueuedApply();
    expect(app.status).toBe("needs_input");
    expect(app.needsInputReason).toContain("Dry run complete");
    expect(mock.submissions).toHaveLength(0);
    const fields = Object.fromEntries(app.formSnapshot!.fields.map((f) => [f.label, f.value]));
    expect(fields["First Name"]).toBe("Jordan");
    expect(fields["Are you legally authorized to work in the United States?"]).toBe("Yes");
    const events = db.select().from(s.applicationEvents).where(eq(s.applicationEvents.applicationId, applicationId)).all();
    expect(events.some((e) => e.type === "screenshot:before-submit" && e.screenshotPath && fs.existsSync(e.screenshotPath))).toBe(true);
  }, 180_000);

  it("real submission records the confirmation and exact files sent", async () => {
    approveApplication(db, applicationId, { dryRun: false });
    const app = await runQueuedApply();
    expect(app.status).toBe("submitted");
    expect(app.dryRun).toBe(false);
    expect(app.submittedAt).toBeTruthy();
    expect(app.confirmationText).toMatch(/thank you for applying/i);
    expect(app.submittedResumeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(app.submittedCoverLetterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mock.submissions).toHaveLength(1);
    expect(mock.submissions[0]!.fields.resume).toBe(path.basename(app.submittedResumePath!));
  }, 180_000);
});
