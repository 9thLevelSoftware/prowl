import { eq, existingSourceKeys, getActiveProfile, getInterview, getPreferences, schema as s, updateInterview, upsertSuggestion, type Db, type QueueTask } from "@jh/db";
import type { LlmClient } from "@jh/llm";
import { InterviewDraft } from "@jh/core";
import { Preferences, logger, type RawJob } from "@jh/shared";
import { Firecrawl, buildSources, detectAts, getWebSearch } from "@jh/sources";
import { emit } from "./events";

const log = logger("sources");

/** Build source suggestions from the profile, preferences, and (optionally) an interview draft. */
export async function handleBuildSources(db: Db, llm: LlmClient, task: QueueTask): Promise<void> {
  const interviewId = task.payload.interviewId ? String(task.payload.interviewId) : null;
  const profile = getActiveProfile(db, task.userId);
  if (!profile) throw new Error("Add your resume first");
  const saved = getPreferences(db, task.userId);
  const iv = interviewId ? getInterview(db, interviewId) : undefined;
  const draft = iv ? InterviewDraft.parse(iv.draft) : null;
  // During review the interview's answers aren't saved yet, so use them on top of saved preferences.
  const prefs = Preferences.parse({ ...saved, ...(draft?.preferences ?? {}) });
  const hints = draft?.companyHints ?? { pursue: [], avoid: [], industries: [], stageOrSize: [] };

  const run = db.insert(s.pipelineRuns).values({ userId: task.userId, kind: "build_sources", message: "Finding job sources" }).returning().get();
  if (iv) updateInterview(db, iv.id, { sourceRunId: run.id });
  const progress = (message: string) => {
    log.info(message);
    emit({ type: "sources:progress", runId: run.id, interviewId, message });
    db.update(s.pipelineRuns).set({ message }).where(eq(s.pipelineRuns.id, run.id)).run();
  };

  try {
    const [webSearch, firecrawl] = await Promise.all([getWebSearch(db, llm), Firecrawl.fromSettings(db)]);
    progress(webSearch.provider === "none" ? "Web search isn't available; using AI suggestions and jobs already found" : `Using ${webSearch.provider === "native" ? "your AI connection's" : "Firecrawl"} web search`);
    const result = await buildSources(db, { userId: task.userId, runId: run.id, profile: profile.data, prefs, hints, llm, webSearch, firecrawl, progress });
    db.update(s.pipelineRuns)
      .set({ status: "done", finishedAt: new Date().toISOString(), stats: { ...result, webSearchProvider: undefined } as unknown as Record<string, number>, message: `${result.verified} boards verified, ${result.searches} searches suggested` })
      .where(eq(s.pipelineRuns.id, run.id))
      .run();
    emit({ type: "sources:done", runId: run.id, interviewId, result });
  } catch (err) {
    db.update(s.pipelineRuns).set({ status: "failed", finishedAt: new Date().toISOString(), message: (err as Error).message }).where(eq(s.pipelineRuns.id, run.id)).run();
    emit({ type: "sources:error", runId: run.id, interviewId, message: (err as Error).message });
    throw err;
  }
}

/** After a discovery run: boards behind newly found jobs become suggestions ("learned"). */
export function suggestLearnedBoards(db: Db, userId: string, sourceName: string, jobs: RawJob[]): number {
  const existing = existingSourceKeys(db, userId);
  let n = 0;
  const seen = new Set<string>();
  for (const j of jobs) {
    const d = detectAts(j.applyUrl);
    if (!d.board || !["greenhouse", "lever", "ashby"].includes(d.ats)) continue;
    const key = `${d.ats}:${d.board.toLowerCase()}`;
    if (existing.has(key) || seen.has(key)) continue;
    seen.add(key);
    const config = d.ats === "greenhouse" ? { boardToken: d.board, companyName: j.company } : d.ats === "lever" ? { company: d.board, companyName: j.company } : { org: d.board, companyName: j.company };
    upsertSuggestion(db, { userId, origin: "learned", company: j.company, domain: "", why: `A matching job was found through ${sourceName}`, type: d.ats as "greenhouse" | "lever" | "ashby", config, key, status: "verified", sampleTitles: [j.title], note: null });
    n++;
  }
  return n;
}
