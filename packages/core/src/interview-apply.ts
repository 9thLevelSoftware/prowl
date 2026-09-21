import {
  enqueue,
  eq,
  getActiveProfile,
  getInterview,
  getPreferences,
  savePreferences,
  saveProfileVersion,
  schema as s,
  updateInterview,
  type Db,
} from "@prowl/db";
import { LOCAL_USER_ID, type Preferences, type ProfileData } from "@prowl/shared";
import { renderResumeFiles, resolveBaseline } from "@prowl/documents";
import { buildFacts, normalizeProfile } from "./profile";
import {
  InterviewDraft,
  InterviewError,
  allowedCompanyHints,
  allowedDealbreakers,
  allowedPreferenceFields,
  allowedScreeningAnswers,
  type CompanyHints,
  type ProfileAddition,
} from "./interview";

/** Server-visible explicit review confirmations (D-03). Set only when the user confirms unevidenced fields on review. */
export interface ApplyConfirmations {
  preferenceFields?: string[];
  companyHints?: string[];
  screeningKeys?: string[];
  dealbreakers?: string[];
}

export interface ApplySelection {
  draft: InterviewDraft;
  /** Profile addition ids the user confirmed. */
  additionIds: string[];
  /** Source suggestion ids the user checked. */
  suggestionIds: string[];
  /** Explicit review-screen confirmations for items that lack transcript evidence (D-03). */
  confirmations?: ApplyConfirmations;
}

export interface ApplyResult {
  preferencesSaved: boolean;
  answersSaved: number;
  profileVersion: number | null;
  sourcesAdded: number;
  /** Items dropped because they lacked transcript evidence and were not explicitly confirmed (D-03). */
  dropped: {
    preferenceFields: string[];
    companyHints: string[];
    screeningKeys: string[];
    dealbreakers: string[];
  };
}

/** Add one suggestion as a job source and queue its first discovery run. Returns false if already added. */
export function addSuggestionAsSource(db: Db, suggestionId: string, userId = LOCAL_USER_ID): boolean {
  const sug = db.select().from(s.sourceSuggestions).where(eq(s.sourceSuggestions.id, suggestionId)).get();
  if (!sug || sug.status === "added") return false;
  const src = db
    .insert(s.jobSources)
    .values({ userId, type: sug.type, name: sug.company, config: sug.config, enabled: true })
    .returning()
    .get();
  db.update(s.sourceSuggestions).set({ status: "added" }).where(eq(s.sourceSuggestions.id, sug.id)).run();
  enqueue(db, "discover_source", { sourceId: src.id }, { dedupKey: `discover:${src.id}`, priority: 60, userId, maxAttempts: 2 });
  return true;
}

export function applyAdditions(profile: ProfileData, additions: ProfileAddition[]): ProfileData {
  const next: ProfileData = structuredClone(profile);
  const context: string[] = [];
  for (const a of additions) {
    const text = a.text.trim();
    if (!text) continue;
    if (a.kind === "skill") {
      const existing = next.skills.find((sk) => sk.name.toLowerCase() === text.toLowerCase());
      if (existing) existing.confirmed = true;
      else next.skills.push({ name: text, category: "General", aliases: [], confirmed: true });
    } else if (a.kind === "certification") {
      if (!next.certifications.some((c) => c.name.toLowerCase() === text.toLowerCase())) next.certifications.push({ name: text, issuer: "", date: "" });
    } else if (a.kind === "bullet" && a.workId && next.work.some((w) => w.id === a.workId)) {
      const role = next.work.find((w) => w.id === a.workId)!;
      if (!role.bullets.includes(text)) role.bullets.push(text);
    } else {
      context.push(text);
    }
  }
  if (context.length) next.additionalContext = [next.additionalContext.trim(), ...context].filter(Boolean).join("\n");
  return normalizeProfile(next);
}

/**
 * Apply an approved interview: preferences, screening answers, confirmed profile additions,
 * and chosen sources. Nothing here runs until the user presses Apply on the review screen.
 *
 * D-03: preference fields, companyHints, dealbreakers, and screening answers persist only when
 * the interview transcript has candidate evidence OR the review screen recorded an explicit
 * confirmation. SEC-06: this path never writes preferences.dryRun = false.
 */
export async function applyInterview(db: Db, interviewId: string, selection: ApplySelection, userId = LOCAL_USER_ID): Promise<ApplyResult> {
  const iv = getInterview(db, interviewId);
  if (!iv) throw new InterviewError("Interview not found");
  if (iv.status === "applied") throw new InterviewError("This interview was already applied");
  const draft = InterviewDraft.parse(selection.draft);
  const messages = iv.messages;
  const confirmations: ApplyConfirmations = selection.confirmations ?? {};
  const confPrefs = new Set(confirmations.preferenceFields ?? []);
  const confHints = new Set(confirmations.companyHints ?? []);
  const confScreen = new Set(confirmations.screeningKeys ?? []);
  const confDeals = new Set(confirmations.dealbreakers ?? []);

  const { allowed: allowedPrefKeys, dropped: droppedPrefFields } = allowedPreferenceFields(draft, messages, confPrefs);
  const { allowed: allowedHints, dropped: droppedHints } = allowedCompanyHints(draft, messages, confHints);
  const { allowed: allowedAnswers, dropped: droppedScreenKeys } = allowedScreeningAnswers(draft, messages, confScreen);
  const { allowed: allowedDeals, dropped: droppedDeals } = allowedDealbreakers(draft, messages, confDeals);

  const draftPrefs = (draft.preferences ?? {}) as Record<string, unknown>;
  const prefPatch: Partial<Preferences> = {};
  for (const key of allowedPrefKeys) {
    const v = draftPrefs[key];
    if (v === undefined || v === null) continue;
    (prefPatch as Record<string, unknown>)[key] = v;
  }
  // companyExclude merges the evidenced/confirmed draft exclude list with allowed avoid hints.
  const draftExclude = allowedPrefKeys.has("companyExclude") ? (draft.preferences.companyExclude ?? []) : [];
  const avoidFromHints = allowedHints.avoid;
  if (allowedPrefKeys.has("companyExclude") || avoidFromHints.length) {
    prefPatch.companyExclude = [...new Set([...draftExclude, ...avoidFromHints].map((a) => a.trim()).filter(Boolean))];
  }
  // SEC-06 / D-03: interview Apply never writes dryRun. Real submit is submitForRealAction / approveApplication.
  delete (prefPatch as Record<string, unknown>).dryRun;

  const result: ApplyResult = {
    preferencesSaved: false,
    answersSaved: 0,
    profileVersion: null,
    sourcesAdded: 0,
    dropped: { preferenceFields: droppedPrefFields, companyHints: droppedHints, screeningKeys: droppedScreenKeys, dealbreakers: droppedDeals },
  };

  db.transaction((tx) => {
    savePreferences(tx as unknown as Db, prefPatch, userId);
    result.preferencesSaved = true;

    for (const a of allowedAnswers) {
      tx.insert(s.qaBank)
        .values({ userId, questionKey: a.questionKey, questionText: a.questionText, answer: a.answer.trim(), approved: true })
        .onConflictDoUpdate({ target: [s.qaBank.userId, s.qaBank.questionKey], set: { answer: a.answer.trim(), questionText: a.questionText, approved: true } })
        .run();
      result.answersSaved++;
    }

    for (const id of selection.suggestionIds) if (addSuggestionAsSource(tx as unknown as Db, id, userId)) result.sourcesAdded++;
  });

  const chosen = draft.profileAdditions.filter((a) => selection.additionIds.includes(a.id));
  if (chosen.length) {
    const profile = getActiveProfile(db, userId);
    if (!profile) throw new InterviewError("Your profile is missing");
    const data = applyAdditions(profile.data, chosen);
    const row = saveProfileVersion(db, { data, facts: buildFacts(data) }, userId);
    result.profileVersion = row.version;
    try {
      const files = await renderResumeFiles(resolveBaseline(data), { kind: "baseline", key: `v${row.version}` });
      db.update(s.profiles).set({ baselinePdfPath: files.pdfPath, baselineDocxPath: files.docxPath }).where(eq(s.profiles.id, row.id)).run();
    } catch {
      /* the baseline PDF can be regenerated from the Profile page */
    }
  }

  // Re-score what has already been found against the new preferences and profile.
  const jobs = db.select({ id: s.jobs.id }).from(s.jobs).where(eq(s.jobs.userId, userId)).all();
  for (const j of jobs) enqueue(db, "process_job", { jobId: j.id }, { dedupKey: `process:${j.id}`, priority: 110, userId });

  // Persist a draft that matches what was actually allowed (D-03) so applied state is honest.
  const persistHints: CompanyHints = allowedHints;
  const persistDraft: InterviewDraft = {
    ...draft,
    companyHints: persistHints,
    screeningAnswers: allowedAnswers,
    dealbreakers: allowedDeals,
  };
  updateInterview(db, interviewId, { status: "applied", draft: persistDraft });
  return result;
}
