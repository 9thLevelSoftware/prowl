import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { Preferences, ProfileData } from "@prowl/shared";
import { applyOnPage, matchOption, type ApplyInput, type AnswerContext, type ApplyOutcome } from "../src";
import { startMockAts } from "./mock-ats";

let browser: Browser;
let mock: Awaited<ReturnType<typeof startMockAts>>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-apply-"));
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
    job: { title: "Senior Backend Engineer", company: "Acme", location: "Remote", descriptionText: "" },
    resumePath,
    coverLetterPath: coverPath,
    coverLetterText: null,
  };
}

function input(url: string, over: Partial<ApplyInput> = {}): ApplyInput {
  return { applicationId: "test-app", applyUrl: url, atsType: "greenhouse", dryRun: false, answers: ctx(), overrides: {}, visionCheck: false, allowGenericSubmit: false, ...over };
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

describe("matchOption", () => {
  it("maps intents onto real option labels", () => {
    expect(matchOption(["Yes", "No"], "yes, I am authorized")).toBe("Yes");
    expect(matchOption(["Yes, I consent", "No, I do not consent"], "No")).toBe("No, I do not consent");
    expect(matchOption(["Male", "Female", "Decline To Self Identify"], "Decline to self-identify")).toBe("Decline To Self Identify");
    expect(matchOption(["Red", "Blue"], "Green")).toBeNull();
  });
});

describe("greenhouse-like form", () => {
  it("pauses for a required question with no saved answer", async () => {
    const out = await run(input(`${mock.url}/greenhouse`));
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.pending.map((p) => p.label)).toEqual(["Are you legally authorized to work in the United States?"]);
    expect(mock.submissions).toHaveLength(0);
  });

  it("fills and submits once the answer is saved, declining EEO by default", async () => {
    const qa = [{ questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", approved: true }];
    const out = await run(input(`${mock.url}/greenhouse`, { answers: ctx(qa) }));
    expect(out.kind).toBe("submitted");
    const sub = mock.submissions.find((s) => s.form === "greenhouse")!;
    expect(sub.fields).toMatchObject({
      first_name: "Jordan",
      last_name: "Rivera",
      email: "jordan@example.com",
      phone: "555-0100",
      resume: "Jordan_Rivera_Resume_Acme.pdf",
      cover_letter: "Jordan_Rivera_Cover_Letter_Acme.pdf",
      question_1: "https://linkedin.com/in/jordan",
      question_2: "Yes",
      gender: "Decline To Self Identify",
    });
    if (out.kind === "submitted") {
      const snap = Object.fromEntries(out.evidence.fields.map((f) => [f.label, f.value]));
      expect(snap["Are you legally authorized to work in the United States?"]).toBe("Yes");
      expect(out.evidence.screenshots.map((s) => s.label)).toEqual(["before-submit", "confirmation"]);
      expect(out.evidence.resumeSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("stops before submitting in dry-run mode", async () => {
    const before = mock.submissions.length;
    const qa = [{ questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", approved: true }];
    const out = await run(input(`${mock.url}/greenhouse`, { answers: ctx(qa), dryRun: true }));
    expect(out.kind).toBe("dry_run_complete");
    expect(mock.submissions.length).toBe(before);
  });
});

describe("lever-like form", () => {
  it("handles externally labeled radios, follow-up questions, and per-application overrides", async () => {
    const first = await run(input(`${mock.url}/lever`, { atsType: "lever" }));
    expect(first.kind).toBe("needs_input");
    if (first.kind !== "needs_input") return;
    const keys = first.pending.map((p) => p.questionKey);
    expect(keys).toEqual([
      "will you now or in the future require sponsorship for employment visa status",
      "have you worked here before",
      "acme:why do you want to work at acme",
    ]);

    const out = await run(
      input(`${mock.url}/lever`, {
        atsType: "lever",
        overrides: {
          "will you now or in the future require sponsorship for employment visa status": "No",
          "have you worked here before": "Yes",
          "if yes which team": "Payments",
          "acme:why do you want to work at acme": "I build payment APIs and Acme runs payments at scale.",
        },
      }),
    );
    expect(out.kind).toBe("submitted");
    const sub = mock.submissions.find((s) => s.form === "lever")!;
    expect(sub.fields).toMatchObject({
      name: "Jordan Rivera",
      email: "jordan@example.com",
      resume: "Jordan_Rivera_Resume_Acme.pdf",
      org: "Paylane",
      "cards[abc][field0]": "No",
      "cards[abc][field1]": "Yes",
      team: "Payments",
      "cards[abc][field2]": "I build payment APIs and Acme runs payments at scale.",
    });
  });
});
