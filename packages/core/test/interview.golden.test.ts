/**
 * Golden interview test against a real LLM provider. It costs quota, so it only runs with:
 *   JH_GOLDEN=1 pnpm test:golden
 * The AI connection comes from your real database (Settings). The interview itself runs in a
 * throwaway database so nothing is written to your profile or preferences.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDb, openDb, runMigrations, saveProfileVersion } from "@jh/db";
import { getLlm } from "@jh/llm";
import { InterviewDraft, answerInterview, buildFacts, finishInterview, hasEvidence, startInterview } from "../src";
import { profile } from "./fixtures";

const enabled = process.env.JH_GOLDEN === "1";

/** A backend engineer who answers plainly and mentions one skill that isn't on the resume. */
const PERSONA = [
  "Senior or staff backend engineer roles, mostly in payments or fintech.",
  "Senior or staff level. I don't want to manage people.",
  "Remote only, anywhere in the US. I'm based in Austin and won't relocate.",
  "At least 180000 base.",
  "I'm a US citizen, so I'm authorized to work in the US.",
  "No, I will never need sponsorship.",
  "Two weeks' notice. I also run our Terraform modules for all AWS infrastructure, which isn't on my resume.",
  "No gambling or crypto companies please. That's everything.",
];

describe.skipIf(!enabled)("golden: interview", () => {
  it("fills the required preferences from the candidate's own answers and invents nothing", async () => {
    const llm = getLlm(getDb());
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jh-golden-iv-")), "t.sqlite"));
    runMigrations(db);
    saveProfileVersion(db, { data: profile, facts: buildFacts(profile) });

    const iv = await startInterview(db, llm);
    expect(iv.messages[0]!.content.length).toBeGreaterThan(10);

    for (const answer of PERSONA) {
      const r = await answerInterview(db, llm, iv.id, answer);
      const last = r.interview.messages.at(-1)!;
      expect(last.role).toBe("assistant");
      expect(last.content.trim().length).toBeGreaterThan(0);
    }

    const done = await finishInterview(db, llm, iv.id);
    const d = InterviewDraft.parse(done.draft);
    const p = d.preferences;
    expect(p.targetTitles?.length).toBeGreaterThan(0);
    expect(p.targetTitles!.join(" ").toLowerCase()).toContain("engineer");
    expect(p.remotePolicy).toBe("remote_only");
    expect(p.salaryFloor).toBe(180000);
    expect(p.workAuthorization).toBeTruthy();
    expect(p.requiresSponsorship).toBe(false);
    expect(p.companyExclude ?? []).not.toContain("crypto companies");

    // Evidence must be the candidate's words, and additions must come from what the candidate said.
    for (const a of d.screeningAnswers) expect(hasEvidence(a.evidence, done.messages), a.questionText).toBe(true);
    for (const a of d.profileAdditions) {
      expect(hasEvidence(a.evidence, done.messages), a.text).toBe(true);
      expect(a.text.toLowerCase()).toMatch(/terraform|aws|infrastructure/);
    }
  });
});
