import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, runMigrations, saveProfileVersion, getActiveProfile, getPreferences, schema as s, upsertSuggestion, type Db } from "@prowl/db";
import { applyInterview, answerInterview, buildFacts, finishInterview, hasEvidence, InterviewDraft, InterviewTurnOut, mergeTurn, nearDuplicate, splitAvoidList, startInterview, type InterviewDraft as Draft } from "../src";
import { profile } from "./fixtures";

process.env.PROWL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-iv-data-"));

/** Scripted stand-in for the AI client: returns queued outputs per task, recording prompts. */
function fakeLlm(script: Record<string, unknown[]>) {
  const calls: { task: string; prompt: string }[] = [];
  return {
    calls,
    async object(ctx: { task: string }, _schema: unknown, input: { prompt?: string }) {
      calls.push({ task: ctx.task, prompt: input.prompt ?? "" });
      const q = script[ctx.task];
      if (!q?.length) throw new Error(`no scripted output for ${ctx.task}`);
      return q.shift();
    },
  };
}

const noPrefs = { targetTitles: null, locations: null, remotePolicy: null, salaryFloor: null, seniority: null, industriesInclude: null, industriesExclude: null, companyExclude: null, workAuthorization: null, requiresSponsorship: null, dailyApplyCap: null, dryRun: null };
const noHints = { pursue: [], avoid: [], industries: [], stageOrSize: [] };
const turn = (over: Record<string, unknown>) => ({ preferences: noPrefs, screeningAnswers: [], profileAdditions: [], companyHints: noHints, dealbreakers: [], startDate: null, coverage: [], done: false, message: "Next?", quickReplies: [], inputKind: "text", ...over });

let db: Db;
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jh-iv-")), "t.sqlite"));
  runMigrations(db);
  saveProfileVersion(db, { data: profile, facts: buildFacts(profile) });
});

describe("interview", () => {
  it("requires a profile", async () => {
    const empty = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jh-iv-")), "e.sqlite"));
    runMigrations(empty);
    await expect(startInterview(empty, fakeLlm({}) as any)).rejects.toThrow(/resume/);
  });

  it("runs a full interview, keeps only evidenced answers, and applies an approved review", async () => {
    const llm = fakeLlm({
      interview_analyze: [
        { careerSummary: "Backend engineer, 7 years, payments.", preferences: { ...noPrefs, targetTitles: ["Senior Backend Engineer"], seniority: ["senior"] }, message: "Looking for senior backend roles?", quickReplies: ["Yes", "Something else"], inputKind: "choice" },
      ],
      interview_turn: [
        turn({
          preferences: { ...noPrefs, targetTitles: ["Staff Backend Engineer", "Senior Backend Engineer"], remotePolicy: "remote_only", salaryFloor: "190000", seniority: ["staff", "wizard"] },
          screeningAnswers: [
            { questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", evidence: "US citizen" },
            { questionKey: "what are your salary expectations", questionText: "Salary?", answer: "$250k", evidence: "I want 250k" },
          ],
          profileAdditions: [
            { kind: "skill", text: "Kafka", workId: null, evidence: "I ran Kafka clusters at Paylane" },
            { kind: "skill", text: "Rust", workId: null, evidence: "expert in Rust" },
            { kind: "bullet", text: "Ran Kafka clusters processing payment events", workId: "w1", evidence: "I ran Kafka clusters at Paylane" },
          ],
          companyHints: { pursue: ["Stripe"], avoid: ["Paylane"], industries: ["Fintech"], stageOrSize: ["Series B+"] },
          coverage: [
            { topic: "roles", status: "covered" },
            { topic: "location", status: "covered" },
          ],
        }),
        turn({
          preferences: { ...noPrefs, requiresSponsorship: false, workAuthorization: "US citizen" },
          coverage: ["seniority", "compensation", "authorization", "sponsorship"].map((topic) => ({ topic, status: "covered" })),
          done: true,
          message: "Thanks, that covers it.",
        }),
      ],
      interview_summarize: [
        {
          preferences: { ...noPrefs, targetTitles: ["Staff Backend Engineer", "Senior Backend Engineer"] },
          keywords: ["backend", "platform"],
          screeningAnswers: [{ questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", evidence: "US citizen" }],
          companyHints: noHints,
        },
      ],
    });

    const iv = await startInterview(db, llm as any);
    expect(iv.messages[0]!.content).toMatch(/senior backend/);
    expect(InterviewDraft.parse(iv.draft).preferences.targetTitles).toEqual(["Senior Backend Engineer"]);
    // Resuming returns the same interview instead of starting a new one.
    expect((await startInterview(db, llm as any)).id).toBe(iv.id);

    const r1 = await answerInterview(db, llm as any, iv.id, "Staff or senior backend, fully remote, at least 190000. I'm a US citizen. I ran Kafka clusters at Paylane. Please avoid Paylane.");
    const d1 = InterviewDraft.parse(r1.interview.draft);
    expect(d1.preferences).toMatchObject({ targetTitles: ["Staff Backend Engineer", "Senior Backend Engineer"], remotePolicy: "remote_only", salaryFloor: 190000 });
    // "wizard" is not a valid seniority, so the whole invalid field is dropped rather than guessed.
    expect(d1.preferences.seniority).toEqual(["senior"]);
    expect(d1.screeningAnswers.map((a) => a.questionKey)).toEqual(["are you legally authorized to work in the united states"]);
    expect(d1.profileAdditions.map((a) => a.text)).toEqual(["Kafka", "Ran Kafka clusters processing payment events"]);
    expect(d1.profileAdditions[1]!.workId).toBe("w1");
    expect(r1.rejected).toHaveLength(2);
    expect(r1.readyToFinish).toBe(false);

    const r2 = await answerInterview(db, llm as any, iv.id, "No sponsorship needed");
    expect(r2.readyToFinish).toBe(true);

    const reviewed = await finishInterview(db, llm as any, iv.id);
    expect(reviewed.status).toBe("review");
    const draft: Draft = InterviewDraft.parse(reviewed.draft);
    expect(draft.preferences.keywords).toEqual(["backend", "platform"]);
    expect(draft.preferences.requiresSponsorship).toBe(false);

    const sug = upsertSuggestion(db, { origin: "ai", company: "Stripe", type: "greenhouse", config: { boardToken: "stripe", companyName: "Stripe" }, key: "greenhouse:stripe", status: "verified", jobsOpen: 10, jobsMatching: 3 });
    const kafka = draft.profileAdditions.find((a) => a.text === "Kafka")!;
    const result = await applyInterview(db, iv.id, { draft, additionIds: [kafka.id], suggestionIds: [sug.id] });
    expect(result).toMatchObject({ preferencesSaved: true, answersSaved: 1, profileVersion: 2, sourcesAdded: 1 });

    const prefs = getPreferences(db);
    expect(prefs).toMatchObject({ remotePolicy: "remote_only", salaryFloor: 190000, requiresSponsorship: false });
    expect(prefs.companyExclude).toContain("Paylane");
    const p = getActiveProfile(db)!;
    expect(p.data.skills.find((k) => k.name === "Kafka")).toMatchObject({ confirmed: true });
    // The unconfirmed bullet was not applied.
    expect(p.data.work[0]!.bullets.some((b) => b.includes("Kafka"))).toBe(false);
    expect(db.select().from(s.jobSources).all().map((x) => x.name)).toEqual(["Stripe"]);
    expect(db.select().from(s.queueTasks).all().some((t) => t.type === "discover_source")).toBe(true);
    expect(db.select().from(s.qaBank).all()).toHaveLength(1);
    await expect(applyInterview(db, iv.id, { draft, additionIds: [], suggestionIds: [] })).rejects.toThrow(/already applied/);
  });

  it("checks evidence against the candidate's own words only", () => {
    const messages = [
      { role: "assistant" as const, content: "Do you need sponsorship? Many people say no.", at: "" },
      { role: "user" as const, content: "Nope, I'm a green card holder.", at: "" },
    ];
    expect(hasEvidence("green card holder", messages)).toBe(true);
    expect(hasEvidence("GREEN CARD HOLDER.", messages)).toBe(true);
    expect(hasEvidence("Many people say no", messages)).toBe(false);
    expect(hasEvidence("", messages)).toBe(false);
  });

  it("only lets the candidate skip topics, never the model", () => {
    const draft = InterviewDraft.parse({ coverage: { roles: "covered", location: "open", compensation: "open" } });
    const coverage = [
      { topic: "roles", status: "skipped" },
      { topic: "location", status: "covered" },
      { topic: "compensation", status: "skipped" },
    ];
    const answered = [{ role: "user" as const, content: "Remote in New York.", at: "" }];
    const a = mergeTurn(draft, InterviewTurnOut.parse(turn({ coverage })), answered, profile).draft.coverage;
    expect(a).toMatchObject({ roles: "covered", location: "covered", compensation: "open" });

    const skipped = [{ role: "user" as const, content: "I'd rather skip this question.", at: "" }];
    const b = mergeTurn(draft, InterviewTurnOut.parse(turn({ coverage })), skipped, profile).draft.coverage;
    expect(b).toMatchObject({ roles: "covered", compensation: "skipped" });
  });

  it("accepts turns where the model leaves out empty fields", () => {
    const out = InterviewTurnOut.parse({ preferences: { workAuthorization: "US citizen" }, companyHints: { pursue: [] }, done: false, message: "Next?", quickReplies: [], inputKind: "text" });
    expect(out.preferences.salaryFloor).toBeNull();
    expect(out.companyHints.stageOrSize).toEqual([]);
    expect(out.coverage).toEqual([]);
  });

  it("drops near-duplicate profile additions", () => {
    expect(nearDuplicate("Led a migration to Kubernetes-based platforms.", "Led migration to Kubernetes-based platforms")).toBe(true);
    expect(nearDuplicate("Led migration to Kubernetes", "Built a payments ledger")).toBe(false);
    const evidence = "I led our migration to Kubernetes-based platforms";
    const messages = [{ role: "user" as const, content: evidence, at: "" }];
    const out = InterviewTurnOut.parse(
      turn({
        profileAdditions: [
          { kind: "bullet", text: "Led a migration to Kubernetes-based platforms.", workId: null, evidence },
          { kind: "bullet", text: "Led migration to Kubernetes-based platforms", workId: null, evidence },
          { kind: "skill", text: "Kubernetes", workId: null, evidence },
        ],
      }),
    );
    expect(mergeTurn(InterviewDraft.parse({}), out, messages, profile).draft.profileAdditions.map((a) => a.kind)).toEqual(["bullet", "skill"]);
  });

  it("treats categories to avoid as industries, not employer names", () => {
    expect(splitAvoidList(["crypto companies", "Meta", "early-stage startups", "gambling industry"])).toEqual({ companies: ["Meta"], industries: ["Crypto", "Early-stage", "Gambling"] });
  });
});
