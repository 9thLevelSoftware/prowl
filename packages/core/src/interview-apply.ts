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
} from "@jh/db";
import { LOCAL_USER_ID, type ProfileData } from "@jh/shared";
import { renderResumeFiles, resolveBaseline } from "@jh/documents";
import { buildFacts, normalizeProfile } from "./profile";
import { InterviewDraft, InterviewError, type ProfileAddition } from "./interview";

export interface ApplySelection {
  draft: InterviewDraft;
  /** Profile addition ids the user confirmed. */
  additionIds: string[];
  /** Source suggestion ids the user checked. */
  suggestionIds: string[];
}

export interface ApplyResult {
  preferencesSaved: boolean;
  answersSaved: number;
  profileVersion: number | null;
  sourcesAdded: number;
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
 */
export async function applyInterview(db: Db, interviewId: string, selection: ApplySelection, userId = LOCAL_USER_ID): Promise<ApplyResult> {
  const iv = getInterview(db, interviewId);
  if (!iv) throw new InterviewError("Interview not found");
  if (iv.status === "applied") throw new InterviewError("This interview was already applied");
  const draft = InterviewDraft.parse(selection.draft);
  const result: ApplyResult = { preferencesSaved: false, answersSaved: 0, profileVersion: null, sourcesAdded: 0 };

  db.transaction((tx) => {
    const current = getPreferences(tx as unknown as Db, userId);
    const avoid = [...(draft.preferences.companyExclude ?? current.companyExclude), ...draft.companyHints.avoid];
    savePreferences(tx as unknown as Db, { ...draft.preferences, companyExclude: [...new Set(avoid.map((a) => a.trim()).filter(Boolean))] }, userId);
    result.preferencesSaved = true;

    for (const a of draft.screeningAnswers) {
      if (!a.answer.trim()) continue;
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

  updateInterview(db, interviewId, { status: "applied", draft });
  return result;
}
