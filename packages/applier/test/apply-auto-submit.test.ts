import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import type { LlmClient } from "@prowl/llm";
import { Preferences, ProfileData } from "@prowl/shared";
import { applyOnPage, type ApplyInput, type AnswerContext, type ApplyOutcome } from "../src";
import { startMockAts } from "./mock-ats";

let browser: Browser;
let mock: Awaited<ReturnType<typeof startMockAts>>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-apply-pr8-"));
process.env.PROWL_DATA_DIR = tmp;

const resumePath = path.join(tmp, "Jordan_Rivera_Resume_Acme.pdf");
const coverPath = path.join(tmp, "Jordan_Rivera_Cover_Letter_Acme.pdf");
fs.writeFileSync(resumePath, "%PDF-1.4 resume");
fs.writeFileSync(coverPath, "%PDF-1.4 cover");

const profile = ProfileData.parse({
  contact: { fullName: "Jordan Rivera", email: "jordan@example.com", phone: "555-0100", location: "Austin, TX", links: [{ label: "LinkedIn", url: "https://linkedin.com/in/jordan" }] },
  work: [{ id: "w1", company: "Paylane", title: "Senior Software Engineer", startDate: "2021-03", endDate: "present", bullets: ["Built APIs"] }],
});

function ctx(qa: AnswerContext["qa"] = []): AnswerContext {
  return {
    profile,
    facts: [],
    prefs: Preferences.parse({}),
    qa,
    job: { title: "Backend Engineer", company: "Acme", location: "Remote", descriptionText: "" },
    resumePath,
    coverLetterPath: coverPath,
    coverLetterText: null,
  };
}

function input(url: string, over: Partial<ApplyInput> = {}): ApplyInput {
  return {
    applicationId: "test-pr8",
    applyUrl: url,
    atsType: "greenhouse",
    dryRun: false,
    answers: ctx(),
    overrides: {},
    visionCheck: false,
    allowGenericSubmit: false,
    ...over,
  };
}

beforeAll(async () => {
  mock = await startMockAts();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await mock?.close();
});

async function run(i: ApplyInput): Promise<ApplyOutcome> {
  const page = await browser.newPage();
  try {
    return await applyOnPage(page, null, i);
  } finally {
    await page.close();
  }
}

describe("PR8 offline safety — applier still refuses outside auto-submit policy", () => {
  it("ashby mock auto-submits when allowlisted + not dry-run + clean", async () => {
    const before = mock.submissions.length;
    const out = await run(input(`${mock.url}/ashby`, { atsType: "ashby" }));
    expect(out.kind).toBe("submitted");
    expect(mock.submissions.length).toBe(before + 1);
    const sub = mock.submissions.at(-1)!;
    expect(sub.form).toBe("ashby");
    expect(sub.fields).toMatchObject({
      _systemfield_name: "Jordan Rivera",
      _systemfield_email: "jordan@example.com",
      _systemfield_resume: "Jordan_Rivera_Resume_Acme.pdf",
    });
  });

  it("ashby dry-run fills but does not submit", async () => {
    const before = mock.submissions.length;
    const out = await run(input(`${mock.url}/ashby`, { atsType: "ashby", dryRun: true }));
    expect(out.kind).toBe("dry_run_complete");
    expect(mock.submissions.length).toBe(before);
  });

  it("non-appliable ATS type never auto-submits (worker gate + applier refuse)", async () => {
    const before = mock.submissions.length;
    // Clean form + non-allowlisted ATS: applier must still refuse real submit.
    // Fail-closed question planning may fire first (PR4): unanswered required fields
    // also return needs_input with zero submissions — both outcomes are safe.
    const authQa = [{ questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", approved: true }];
    const out = await run(input(`${mock.url}/greenhouse`, { atsType: "workday", allowGenericSubmit: false, answers: ctx(authQa) }));
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.reason).toMatch(/unrecognized site|manual|not supported|question/i);
    expect(mock.submissions.length).toBe(before);
  });

  it("allowGenericSubmit false never auto-submits unknown sites", async () => {
    const before = mock.submissions.length;
    const authQa = [{ questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", approved: true }];
    const out = await run(input(`${mock.url}/greenhouse`, { atsType: "other", allowGenericSubmit: false, answers: ctx(authQa) }));
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    // Either the generic-submit deny or unanswered required questions — never a silent submit.
    expect(out.reason).toMatch(/unrecognized site|question/i);
    expect(mock.submissions.length).toBe(before);
  });

  it("CAPTCHA still returns needs_input with keepPageOpen and zero submissions", async () => {
    const before = mock.submissions.length;
    const out = await run(input(`${mock.url}/captcha`, { atsType: "ashby" }));
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.reason).toMatch(/human verification|captcha/i);
    expect(out.keepPageOpen).toBe(true);
    expect(mock.submissions.length).toBe(before);
  });
});
