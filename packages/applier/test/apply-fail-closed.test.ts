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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-apply-fc-"));
process.env.PROWL_DATA_DIR = tmp;

const resumePath = path.join(tmp, "Jordan_Rivera_Resume_Acme.pdf");
const coverPath = path.join(tmp, "Jordan_Rivera_Cover_Letter_Acme.pdf");
fs.writeFileSync(resumePath, "%PDF-1.4 resume");
fs.writeFileSync(coverPath, "%PDF-1.4 cover");

const profile = ProfileData.parse({
  contact: { fullName: "Jordan Rivera", email: "jordan@example.com", phone: "555-0100", location: "Austin, TX", links: [{ label: "LinkedIn", url: "https://linkedin.com/in/jordan" }] },
  work: [{ id: "w1", company: "Paylane", title: "Senior Software Engineer", startDate: "2021-03", endDate: "present", bullets: ["Built APIs"] }],
});

const AUTH_QA = [{ questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", approved: true }];

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
  return {
    applicationId: "test-fc",
    applyUrl: url,
    atsType: "greenhouse",
    dryRun: false,
    answers: ctx(AUTH_QA),
    overrides: {},
    visionCheck: false,
    allowGenericSubmit: false,
    ...over,
  };
}

/** Minimal stand-in for LlmClient — only visionReview calls object() on this path. */
function llmStub(behavior: "fail" | "problems" | "clean"): LlmClient {
  return {
    object: async () => {
      if (behavior === "fail") throw new Error("vision provider unavailable");
      if (behavior === "problems") {
        return { looksComplete: false, problems: [{ field: "Email", problem: "still empty" }] };
      }
      return { looksComplete: true, problems: [] };
    },
  } as unknown as LlmClient;
}

function gates(out: ApplyOutcome): string[] {
  return out.evidence.gates.map((g) => g.code);
}

function logHas(out: ApplyOutcome, needle: string): boolean {
  return out.evidence.log.some((l) => l.includes(needle));
}

beforeAll(async () => {
  mock = await startMockAts();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await mock?.close();
});

async function run(i: ApplyInput, llm: LlmClient | null = null): Promise<ApplyOutcome> {
  const page = await browser.newPage();
  try {
    return await applyOnPage(page, llm, i);
  } finally {
    await page.close();
  }
}

describe("apply path fail-closed (PR4)", () => {
  it("dry-run happy path still completes when required fields are filled", async () => {
    const before = mock.submissions.length;
    const out = await run(input(`${mock.url}/greenhouse`, { dryRun: true }));
    expect(out.kind).toBe("dry_run_complete");
    expect(mock.submissions.length).toBe(before);
    expect(gates(out)).not.toContain("blocked:empty_required");
  });

  it("real submit happy path still works when required fields are filled", async () => {
    const out = await run(input(`${mock.url}/greenhouse`));
    expect(out.kind).toBe("submitted");
  });

  it("blocks real submit when a required combobox stays empty — no hooks.submit", async () => {
    const before = mock.submissions.length;
    const out = await run(
      input(`${mock.url}/greenhouse`, {
        overrides: { "are you legally authorized to work in the united states": "" },
      }),
    );
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.reason).toMatch(/empty required|Blocked before submit/i);
    expect(gates(out)).toContain("blocked:empty_required");
    expect(logHas(out, "blocked:empty_required")).toBe(true);
    expect(mock.submissions.length).toBe(before);
  });

  it("blocks real submit when a required free-text field stays empty", async () => {
    const before = mock.submissions.length;
    const out = await run(
      input(`${mock.url}/greenhouse-gap`, {
        overrides: { "are you willing to relocate": "" },
      }),
    );
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(gates(out)).toContain("blocked:empty_required");
    const gate = out.evidence.gates.find((g) => g.code === "blocked:empty_required");
    expect(gate?.fields?.join(" ")).toMatch(/relocate/i);
    expect(mock.submissions.length).toBe(before);
  });

  it("dry-run with empty required does not imply a clean form", async () => {
    const before = mock.submissions.length;
    const out = await run(
      input(`${mock.url}/greenhouse`, {
        dryRun: true,
        overrides: { "are you legally authorized to work in the united states": "" },
      }),
    );
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.reason).toMatch(/not complete|empty required|Dry run stopped/i);
    expect(gates(out)).toContain("blocked:empty_required");
    expect(mock.submissions.length).toBe(before);
  });

  it("vision-check failure fails closed on real submit — no submit without override", async () => {
    const before = mock.submissions.length;
    const out = await run(input(`${mock.url}/greenhouse`, { visionCheck: true }), llmStub("fail"));
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.reason).toMatch(/vision check failed|Blocked before submit/i);
    expect(gates(out)).toContain("blocked:vision_failed");
    expect(logHas(out, "blocked:vision_failed")).toBe(true);
    expect(mock.submissions.length).toBe(before);
  });

  it("vision-check problems fail closed on real submit", async () => {
    const before = mock.submissions.length;
    const out = await run(input(`${mock.url}/greenhouse`, { visionCheck: true }), llmStub("problems"));
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.reason).toMatch(/vision check/i);
    expect(mock.submissions.length).toBe(before);
  });

  it("vision-check clean still allows real submit", async () => {
    const out = await run(input(`${mock.url}/greenhouse`, { visionCheck: true }), llmStub("clean"));
    expect(out.kind).toBe("submitted");
  });

  it("dry-run may complete after vision failure but evidence records blocked:vision_failed", async () => {
    const before = mock.submissions.length;
    const out = await run(input(`${mock.url}/greenhouse`, { dryRun: true, visionCheck: true }), llmStub("fail"));
    expect(out.kind).toBe("dry_run_complete");
    expect(gates(out)).toContain("blocked:vision_failed");
    expect(logHas(out, "blocked:vision_failed")).toBe(true);
    expect(mock.submissions.length).toBe(before);
  });

  it("explicit safety override accepts a real submit past vision failure and records override accepted", async () => {
    const out = await run(
      input(`${mock.url}/greenhouse`, { visionCheck: true, overrideSafetyBlocks: true }),
      llmStub("fail"),
    );
    expect(out.kind).toBe("submitted");
    expect(gates(out)).toContain("override_accepted");
    expect(logHas(out, "override accepted")).toBe(true);
  });

  it("question overrides are recorded as override accepted in evidence", async () => {
    const out = await run(
      input(`${mock.url}/greenhouse`, {
        overrides: { "are you legally authorized to work in the united states": "Yes" },
      }),
    );
    expect(out.kind).toBe("submitted");
    expect(gates(out)).toContain("override_accepted");
    expect(logHas(out, "override accepted")).toBe(true);
  });

  it("CAPTCHA pause still returns needs_input with zero submissions", async () => {
    const before = mock.submissions.length;
    const out = await run(input(`${mock.url}/captcha`, { answers: ctx(AUTH_QA) }));
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.reason).toMatch(/human verification|captcha/i);
    expect(out.keepPageOpen).toBe(true);
    expect(mock.submissions.length).toBe(before);
  });

  it("allowGenericSubmit false still pauses unrecognized sites", async () => {
    const before = mock.submissions.length;
    const out = await run(input(`${mock.url}/greenhouse`, { atsType: "other", allowGenericSubmit: false }));
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.reason).toMatch(/unrecognized site/i);
    expect(mock.submissions.length).toBe(before);
  });
});
