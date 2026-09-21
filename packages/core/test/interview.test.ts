import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, runMigrations, saveProfileVersion, getActiveProfile, getPreferences, schema as s, upsertSuggestion, type Db } from "@prowl/db";
import {
  applyInterview,
  answerInterview,
  allowedCompanyHints,
  allowedPreferenceFields,
  allowedScreeningAnswers,
  buildFacts,
  finishInterview,
  hasEvidence,
  InterviewDraft,
  InterviewTurnOut,
  mergeTurn,
  nearDuplicate,
  splitAvoidList,
  startInterview,
  type InterviewDraft as Draft,
} from "../src";
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
const noHints = { pursue: [], avoid: [], industries: [], stageOrSize: [], evidence: [] };
const turn = (over: Record<string, unknown>) => ({
  preferences: noPrefs,
  preferenceEvidence: {},
  screeningAnswers: [],
  profileAdditions: [],
  companyHints: noHints,
  dealbreakers: [],
  startDate: null,
  coverage: [],
  done: false,
  message: "Next?",
  quickReplies: [],
  inputKind: "text",
  ...over,
});

const CANDIDATE_TURN1 =
  "Staff or senior backend, fully remote, at least 190000. I'm a US citizen. I ran Kafka clusters at Paylane. Please avoid Paylane.";
const CANDIDATE_TURN2 = "No sponsorship needed";

let db: Db;
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jh-iv-")), "t.sqlite"));
  runMigrations(db);
  saveProfileVersion(db, { data: profile, facts: buildFacts(profile) });
});

/** Scripted interview where the model provides evidence quotes for stated prefs/hints. */
function evidencedInterviewLlm() {
  return fakeLlm({
    interview_analyze: [
      {
        careerSummary: "Backend engineer, 7 years, payments.",
        // Resume inferences — no candidate words yet (D-03: no preferenceEvidence).
        preferences: { ...noPrefs, targetTitles: ["Senior Backend Engineer"], seniority: ["senior"] },
        message: "Looking for senior backend roles?",
        quickReplies: ["Yes", "Something else"],
        inputKind: "choice",
      },
    ],
    interview_turn: [
      turn({
        preferences: {
          ...noPrefs,
          targetTitles: ["Staff Backend Engineer", "Senior Backend Engineer"],
          remotePolicy: "remote_only",
          salaryFloor: "190000",
          seniority: ["staff", "wizard"],
          // Model-invented without candidate words — must not persist without confirm (D-03 / D-11).
          dryRun: false,
          dailyApplyCap: 5,
          companyExclude: ["InventedCo"],
        },
        preferenceEvidence: {
          targetTitles: "Staff or senior backend",
          remotePolicy: "fully remote",
          salaryFloor: "190000",
          seniority: "Staff or senior",
          // dryRun / dailyApplyCap / companyExclude intentionally omitted
        },
        screeningAnswers: [
          { questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", evidence: "US citizen" },
          { questionKey: "what are your salary expectations", questionText: "Salary?", answer: "$250k", evidence: "I want 250k" },
        ],
        profileAdditions: [
          { kind: "skill", text: "Kafka", workId: null, evidence: "I ran Kafka clusters at Paylane" },
          { kind: "skill", text: "Rust", workId: null, evidence: "expert in Rust" },
          { kind: "bullet", text: "Ran Kafka clusters processing payment events", workId: "w1", evidence: "I ran Kafka clusters at Paylane" },
        ],
        companyHints: {
          pursue: ["Stripe"],
          avoid: ["Paylane"],
          industries: ["Fintech"],
          stageOrSize: ["Series B+"],
          // Only Paylane has candidate words; Stripe/Fintech/Series B+ are model guesses.
          evidence: ["Please avoid Paylane"],
        },
        coverage: [
          { topic: "roles", status: "covered" },
          { topic: "location", status: "covered" },
        ],
      }),
      turn({
        preferences: { ...noPrefs, requiresSponsorship: false, workAuthorization: "US citizen" },
        preferenceEvidence: {
          requiresSponsorship: "No sponsorship needed",
          workAuthorization: "US citizen",
        },
        coverage: ["seniority", "compensation", "authorization", "sponsorship"].map((topic) => ({ topic, status: "covered" })),
        done: true,
        message: "Thanks, that covers it.",
      }),
    ],
    interview_summarize: [
      {
        preferences: { ...noPrefs, targetTitles: ["Staff Backend Engineer", "Senior Backend Engineer"] },
        preferenceEvidence: { targetTitles: "Staff or senior backend", keywords: "backend" },
        keywords: ["backend", "platform"],
        screeningAnswers: [{ questionKey: "are you legally authorized to work in the united states", questionText: "Authorized?", answer: "Yes", evidence: "US citizen" }],
        companyHints: noHints,
      },
    ],
  });
}

async function runEvidencedInterview() {
  const llm = evidencedInterviewLlm();
  const iv = await startInterview(db, llm as any);
  const analyzeDraft = InterviewDraft.parse(iv.draft) as Draft;
  const r1 = await answerInterview(db, llm as any, iv.id, CANDIDATE_TURN1);
  const r2 = await answerInterview(db, llm as any, iv.id, CANDIDATE_TURN2);
  const reviewed = await finishInterview(db, llm as any, iv.id);
  return { llm, iv, r1, r2, reviewed, analyzeDraft, draft: InterviewDraft.parse(reviewed.draft) as Draft };
}

describe("interview", () => {
  it("requires a profile", async () => {
    const empty = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jh-iv-")), "e.sqlite"));
    runMigrations(empty);
    await expect(startInterview(empty, fakeLlm({}) as any)).rejects.toThrow(/resume/);
  });

  it("runs a full interview, keeps only evidenced answers, and applies an approved review (D-03 evidence path)", async () => {
    const { iv, r1, r2, reviewed, analyzeDraft, draft } = await runEvidencedInterview();

    // Analyze pre-fills resume inferences into the draft without evidence markers.
    expect(analyzeDraft.preferences.targetTitles).toEqual(["Senior Backend Engineer"]);
    expect(analyzeDraft.preferenceEvidence).toEqual({});
    expect(r1.rejected).toHaveLength(2);
    expect(r1.readyToFinish).toBe(false);
    expect(r2.readyToFinish).toBe(true);
    expect(reviewed.status).toBe("review");

    // Draft keeps model values for review visibility.
    expect(draft.preferences).toMatchObject({ remotePolicy: "remote_only", salaryFloor: 190000 });
    expect(draft.preferences.keywords).toEqual(["backend", "platform"]);
    expect(draft.preferences.requiresSponsorship).toBe(false);
    // "wizard" is not a valid seniority, so the whole invalid field is dropped rather than guessed.
    expect(draft.preferences.seniority).toEqual(["senior"]);
    expect(draft.screeningAnswers.map((a) => a.questionKey)).toEqual(["are you legally authorized to work in the united states"]);
    expect(draft.profileAdditions.map((a) => a.text)).toEqual(["Kafka", "Ran Kafka clusters processing payment events"]);
    expect(draft.profileAdditions[1]!.workId).toBe("w1");
    // Evidence map records candidate words for stated prefs/hints (D-03).
    expect(draft.preferenceEvidence.remotePolicy).toBe("fully remote");
    expect(draft.preferenceEvidence.salaryFloor).toBe("190000");
    expect(draft.hintEvidence).toContain("Please avoid Paylane");
    // dryRun / dailyApplyCap / companyExclude have no evidence markers.
    expect(draft.preferenceEvidence.dryRun).toBeUndefined();
    expect(draft.preferenceEvidence.dailyApplyCap).toBeUndefined();
    expect(draft.preferenceEvidence.companyExclude).toBeUndefined();

    const sug = upsertSuggestion(db, { origin: "ai", company: "Stripe", type: "greenhouse", config: { boardToken: "stripe", companyName: "Stripe" }, key: "greenhouse:stripe", status: "verified", jobsOpen: 10, jobsMatching: 3 });
    const kafka = draft.profileAdditions.find((a) => a.text === "Kafka")!;

    // Apply without confirmations: only evidenced prefs/hints/answers persist (D-03).
    const result = await applyInterview(db, iv.id, { draft, additionIds: [kafka.id], suggestionIds: [sug.id] });
    expect(result).toMatchObject({ preferencesSaved: true, answersSaved: 1, profileVersion: 2, sourcesAdded: 1 });
    expect(result.dropped.preferenceFields).toEqual(expect.arrayContaining(["dryRun", "dailyApplyCap", "companyExclude"]));
    expect(result.dropped.companyHints).toEqual(expect.arrayContaining(["Stripe", "Fintech", "Series B+"]));

    const prefs = getPreferences(db);
    // Evidenced fields persist.
    expect(prefs).toMatchObject({ remotePolicy: "remote_only", salaryFloor: 190000, requiresSponsorship: false, workAuthorization: "US citizen" });
    expect(prefs.targetTitles).toEqual(["Staff Backend Engineer", "Senior Backend Engineer"]);
    expect(prefs.companyExclude).toContain("Paylane");
    // Model-invented fields without evidence do NOT persist (D-11 negative contract).
    expect(prefs.dryRun).toBe(true);
    expect(prefs.dailyApplyCap).toBe(20);
    expect(prefs.companyExclude).not.toContain("InventedCo");

    const p = getActiveProfile(db)!;
    expect(p.data.skills.find((k) => k.name === "Kafka")).toMatchObject({ confirmed: true });
    // The unconfirmed bullet was not applied.
    expect(p.data.work[0]!.bullets.some((b) => b.includes("Kafka"))).toBe(false);
    expect(db.select().from(s.jobSources).all().map((x) => x.name)).toEqual(["Stripe"]);
    expect(db.select().from(s.queueTasks).all().some((t) => t.type === "discover_source")).toBe(true);
    expect(db.select().from(s.qaBank).all()).toHaveLength(1);
    await expect(applyInterview(db, iv.id, { draft, additionIds: [], suggestionIds: [] })).rejects.toThrow(/already applied/);
  });

  it("does not persist model-invented prefs/hints without evidence or confirm (D-03 / D-11)", async () => {
    const llm = fakeLlm({
      interview_analyze: [
        {
          careerSummary: "Backend engineer.",
          preferences: { ...noPrefs, targetTitles: ["Senior Backend Engineer"] },
          message: "Looking for senior backend roles?",
          quickReplies: [],
          inputKind: "text",
        },
      ],
      interview_turn: [
        turn({
          // Candidate only talks about remote work — model invents the rest.
          preferences: {
            ...noPrefs,
            remotePolicy: "remote_only",
            dryRun: false,
            dailyApplyCap: 3,
            companyExclude: ["Meta"],
            salaryFloor: 250000,
          },
          preferenceEvidence: { remotePolicy: "remote only" },
          companyHints: { pursue: [], avoid: ["Google"], industries: [], stageOrSize: [], evidence: [] },
          coverage: ["roles", "location", "compensation", "authorization", "sponsorship", "seniority"].map((topic) => ({ topic, status: "covered" })),
          done: true,
          message: "Thanks.",
        }),
      ],
      interview_summarize: [
        {
          preferences: { ...noPrefs, remotePolicy: "remote_only", dryRun: false, dailyApplyCap: 3, companyExclude: ["Meta"] },
          preferenceEvidence: { remotePolicy: "remote only" },
          keywords: [],
          screeningAnswers: [],
          companyHints: { pursue: [], avoid: ["Google"], industries: [], stageOrSize: [], evidence: [] },
        },
      ],
    });

    const iv = await startInterview(db, llm as any);
    await answerInterview(db, llm as any, iv.id, "Remote only please");
    const reviewed = await finishInterview(db, llm as any, iv.id);
    const draft = InterviewDraft.parse(reviewed.draft) as Draft;

    const result = await applyInterview(db, iv.id, { draft, additionIds: [], suggestionIds: [] });
    expect(result.dropped.preferenceFields).toEqual(expect.arrayContaining(["dryRun", "dailyApplyCap", "companyExclude", "salaryFloor"]));
    expect(result.dropped.companyHints).toContain("Google");

    const prefs = getPreferences(db);
    expect(prefs.remotePolicy).toBe("remote_only"); // evidenced
    expect(prefs.dryRun).toBe(true); // SEC-06: never false from interview
    expect(prefs.dailyApplyCap).toBe(20);
    expect(prefs.salaryFloor).toBe(0);
    expect(prefs.companyExclude ?? []).not.toContain("Meta");
    expect(prefs.companyExclude ?? []).not.toContain("Google");
  });

  it("persists unevidenced prefs/hints only when the review screen confirms them (D-03)", async () => {
    const llm = fakeLlm({
      interview_analyze: [
        {
          careerSummary: "Backend engineer.",
          preferences: { ...noPrefs, targetTitles: ["Senior Backend Engineer"] },
          message: "Looking for senior backend roles?",
          quickReplies: [],
          inputKind: "text",
        },
      ],
      interview_turn: [
        turn({
          preferences: { ...noPrefs, dryRun: false, dailyApplyCap: 3, companyExclude: ["Meta"] },
          preferenceEvidence: {},
          companyHints: { pursue: ["Stripe"], avoid: ["Google"], industries: ["Fintech"], stageOrSize: [], evidence: [] },
          coverage: ["roles", "location", "compensation", "authorization", "sponsorship", "seniority"].map((topic) => ({ topic, status: "covered" })),
          done: true,
          message: "Thanks.",
        }),
      ],
      interview_summarize: [
        {
          preferences: { ...noPrefs, dailyApplyCap: 3, companyExclude: ["Meta"] },
          preferenceEvidence: {},
          keywords: [],
          screeningAnswers: [],
          companyHints: { pursue: ["Stripe"], avoid: ["Google"], industries: ["Fintech"], stageOrSize: [], evidence: [] },
        },
      ],
    });

    const iv = await startInterview(db, llm as any);
    await answerInterview(db, llm as any, iv.id, "Backend engineer roles");
    const reviewed = await finishInterview(db, llm as any, iv.id);
    const draft = InterviewDraft.parse(reviewed.draft) as Draft;

    // Explicit review confirm allows persist — except dryRun (SEC-06 / submitForRealAction intent).
    const result = await applyInterview(db, iv.id, {
      draft,
      additionIds: [],
      suggestionIds: [],
      confirmations: {
        preferenceFields: ["dailyApplyCap", "companyExclude", "dryRun"],
        companyHints: ["Stripe", "Google", "Fintech", "Meta"],
      },
    });
    expect(result.dropped.preferenceFields).toContain("dryRun");
    expect(result.dropped.preferenceFields).not.toContain("dailyApplyCap");
    expect(result.dropped.preferenceFields).not.toContain("companyExclude");
    expect(result.dropped.companyHints).toEqual([]);

    const prefs = getPreferences(db);
    expect(prefs.dailyApplyCap).toBe(3);
    expect(prefs.companyExclude).toEqual(expect.arrayContaining(["Meta", "Google"]));
    expect(prefs.dryRun).toBe(true); // confirm of dryRun does NOT flip submit-for-real
  });

  it("re-validates screening answers at Apply: client-shaped draft alone is insufficient (CODE2-04)", async () => {
    const { iv, draft } = await runEvidencedInterview();

    // Simulate a client that injects a screening answer the candidate never gave.
    const forged: Draft = {
      ...draft,
      screeningAnswers: [
        ...draft.screeningAnswers,
        {
          questionKey: "do you have a security clearance",
          questionText: "Clearance?",
          answer: "Yes, top secret",
          evidence: "top secret clearance",
        },
      ],
    };

    const qaBefore = db.select().from(s.qaBank).all();
    expect(qaBefore).toHaveLength(0);

    const result = await applyInterview(db, iv.id, { draft: forged, additionIds: [], suggestionIds: [] });
    expect(result.answersSaved).toBe(1);
    expect(result.dropped.screeningKeys).toContain("do you have a security clearance");

    const qa = db.select().from(s.qaBank).all();
    expect(qa).toHaveLength(1);
    expect(qa[0]!.questionKey).toBe("are you legally authorized to work in the united states");
    expect(qa[0]!.approved).toBe(true);
    expect(qa.some((r) => r.questionKey === "do you have a security clearance")).toBe(false);

    // Explicit review confirm allows the unevidenced answer to persist with approved:true.
    // Use a fresh interview so we can apply again.
    const run2 = await runEvidencedInterview();
    const forged2: Draft = {
      ...run2.draft,
      screeningAnswers: [
        ...run2.draft.screeningAnswers,
        { questionKey: "do you have a security clearance", questionText: "Clearance?", answer: "Yes, top secret", evidence: "top secret clearance" },
      ],
    };
    const r2 = await applyInterview(db, run2.iv.id, {
      draft: forged2,
      additionIds: [],
      suggestionIds: [],
      confirmations: { screeningKeys: ["do you have a security clearance", "are you legally authorized to work in the united states"] },
    });
    expect(r2.answersSaved).toBe(2);
    const keys = db
      .select()
      .from(s.qaBank)
      .all()
      .map((r) => r.questionKey);
    expect(keys).toContain("do you have a security clearance");
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
    expect(out.companyHints.evidence).toEqual([]);
    expect(out.coverage).toEqual([]);
    expect(out.preferenceEvidence).toEqual({});
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

  it("gates preference fields, company hints, and screening answers on evidence or confirm (unit)", () => {
    const messages = [{ role: "user" as const, content: "Remote only. Please avoid Paylane. I'm a US citizen.", at: "" }];
    const draft = InterviewDraft.parse({
      preferences: { remotePolicy: "remote_only", dryRun: false, dailyApplyCap: 2, companyExclude: ["InventedCo"] },
      preferenceEvidence: { remotePolicy: "Remote only" },
      companyHints: { pursue: ["Stripe"], avoid: ["Paylane", "Google"], industries: [], stageOrSize: [] },
      hintEvidence: ["Please avoid Paylane"],
      screeningAnswers: [
        { questionKey: "auth", questionText: "Auth?", answer: "Yes", evidence: "US citizen" },
        { questionKey: "clearance", questionText: "Clearance?", answer: "Yes", evidence: "top secret" },
      ],
      dealbreakers: ["no gambling", "unrelated dealbreaker"],
    });

    const prefs = allowedPreferenceFields(draft, messages, new Set());
    expect(prefs.allowed.has("remotePolicy")).toBe(true);
    expect(prefs.allowed.has("dryRun")).toBe(false);
    expect(prefs.allowed.has("dailyApplyCap")).toBe(false);
    expect(prefs.allowed.has("companyExclude")).toBe(false);

    const prefsConfirmed = allowedPreferenceFields(draft, messages, new Set(["dailyApplyCap", "companyExclude", "dryRun"]));
    expect(prefsConfirmed.allowed.has("dailyApplyCap")).toBe(true);
    expect(prefsConfirmed.allowed.has("companyExclude")).toBe(true);
    // dryRun stays blocked even with confirm — not submitForRealAction intent.
    expect(prefsConfirmed.allowed.has("dryRun")).toBe(false);

    const hints = allowedCompanyHints(draft, messages, new Set());
    expect(hints.allowed.avoid).toEqual(["Paylane"]);
    expect(hints.dropped).toEqual(expect.arrayContaining(["Stripe", "Google"]));

    const hintsConfirmed = allowedCompanyHints(draft, messages, new Set(["Google", "Stripe"]));
    expect(hintsConfirmed.allowed.avoid).toEqual(expect.arrayContaining(["Paylane", "Google"]));
    expect(hintsConfirmed.allowed.pursue).toContain("Stripe");

    const answers = allowedScreeningAnswers(draft, messages, new Set());
    expect(answers.allowed.map((a) => a.questionKey)).toEqual(["auth"]);
    expect(answers.dropped).toEqual(["clearance"]);

    const answersConfirmed = allowedScreeningAnswers(draft, messages, new Set(["clearance"]));
    expect(answersConfirmed.allowed.map((a) => a.questionKey)).toEqual(["auth", "clearance"]);
  });
});
