"use server";

import { revalidatePath } from "next/cache";
import { enqueue, eq, getInterview, schema as s, setSetting } from "@jh/db";
import { getLlm, setSecret } from "@jh/llm";
import {
  abandonInterview,
  addSuggestionAsSource,
  answerInterview,
  applyInterview,
  finishInterview,
  InterviewDraft,
  saveReviewDraft,
  startInterview,
} from "@jh/core";
import { FIRECRAWL_SECRET_ID, FIRECRAWL_SETTINGS_KEY, Firecrawl, firecrawlSettings, type FirecrawlCapabilities } from "@jh/sources";
import { db, USER } from "../server";
import type { ActionResult } from "./profile";

const fail = (err: unknown): { ok: false; error: string } => ({ ok: false, error: (err as Error).message ?? String(err) });
const refresh = () => revalidatePath("/", "layout");

function queueSourceBuild(interviewId: string | null) {
  enqueue(db(), "build_sources", interviewId ? { interviewId } : {}, { dedupKey: "build_sources", priority: 30, userId: USER, maxAttempts: 1 });
}

/* ================================ Interview =============================== */

export async function startInterviewAction(): Promise<ActionResult<{ interviewId: string }>> {
  try {
    const iv = await startInterview(db(), getLlm(db()), USER);
    refresh();
    return { ok: true, data: { interviewId: iv.id } };
  } catch (err) {
    return fail(err);
  }
}

export async function answerInterviewAction(interviewId: string, text: string): Promise<ActionResult<{ readyToFinish: boolean; rejected: string[] }>> {
  try {
    const r = await answerInterview(db(), getLlm(db()), interviewId, text);
    refresh();
    return { ok: true, data: { readyToFinish: r.readyToFinish, rejected: r.rejected } };
  } catch (err) {
    return fail(err);
  }
}

/** Summarize the interview, move it to review, and start finding sources in the background. */
export async function finishInterviewAction(interviewId: string): Promise<ActionResult> {
  try {
    await finishInterview(db(), getLlm(db()), interviewId);
    queueSourceBuild(interviewId);
    refresh();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function startOverAction(interviewId: string): Promise<ActionResult> {
  try {
    abandonInterview(db(), interviewId);
    refresh();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function saveReviewDraftAction(interviewId: string, draft: unknown): Promise<ActionResult> {
  try {
    saveReviewDraft(db(), interviewId, InterviewDraft.parse(draft));
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function applyInterviewAction(interviewId: string, draft: unknown, additionIds: string[], suggestionIds: string[]): Promise<ActionResult> {
  try {
    const r = await applyInterview(db(), interviewId, { draft: InterviewDraft.parse(draft), additionIds, suggestionIds }, USER);
    refresh();
    const parts = [
      "Preferences saved",
      r.answersSaved ? `${r.answersSaved} screening answer${r.answersSaved === 1 ? "" : "s"} saved` : null,
      r.profileVersion ? `profile updated to version ${r.profileVersion}` : null,
      r.sourcesAdded ? `${r.sourcesAdded} source${r.sourcesAdded === 1 ? "" : "s"} added and searching now` : null,
    ].filter(Boolean);
    return { ok: true, message: `${parts.join(", ")}.` };
  } catch (err) {
    return fail(err);
  }
}

/* ============================ Source suggestions ========================== */

export async function findMoreSourcesAction(interviewId?: string): Promise<ActionResult> {
  const iv = interviewId ? getInterview(db(), interviewId) : undefined;
  queueSourceBuild(iv?.status === "review" ? iv.id : null);
  refresh();
  return { ok: true, message: "Looking for employers and job boards. Results appear here as they're verified." };
}

export async function addSuggestionAction(id: string): Promise<ActionResult> {
  try {
    const added = addSuggestionAsSource(db(), id, USER);
    refresh();
    return added ? { ok: true, message: "Added. The first search is running." } : { ok: false, error: "Already added" };
  } catch (err) {
    return fail(err);
  }
}

export async function dismissSuggestionAction(id: string): Promise<ActionResult> {
  db().update(s.sourceSuggestions).set({ status: "dismissed" }).where(eq(s.sourceSuggestions.id, id)).run();
  refresh();
  return { ok: true };
}

/* ================================ Web tools =============================== */

export async function saveFirecrawlAction(input: { enabled: boolean; baseUrl: string; apiKey: string }): Promise<ActionResult> {
  try {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    if (input.enabled) new URL(baseUrl);
    const current = firecrawlSettings(db());
    if (input.apiKey.trim()) await setSecret(FIRECRAWL_SECRET_ID, "api_key", input.apiKey.trim());
    setSetting(db(), FIRECRAWL_SETTINGS_KEY, { enabled: input.enabled, baseUrl, hasApiKey: current.hasApiKey || !!input.apiKey.trim() });
    refresh();
    return { ok: true, message: "Saved" };
  } catch (err) {
    return fail(err);
  }
}

export async function testFirecrawlAction(): Promise<ActionResult<FirecrawlCapabilities>> {
  try {
    const settings = firecrawlSettings(db());
    const fc = await Firecrawl.fromSettings(db());
    if (!fc) return { ok: false, error: settings.enabled ? "Enter the server address first" : "Turn Firecrawl on first" };
    const caps = await fc.capabilities();
    if (!caps.reachable) return { ok: false, error: `Couldn't reach Firecrawl at ${settings.baseUrl}. ${caps.error ?? ""}`.trim() };
    const have = [caps.scrape && "page scraping", caps.map && "site maps", caps.search && "web search"].filter(Boolean).join(", ");
    return {
      ok: true,
      data: caps,
      message: `Connected (${caps.version ?? "unknown version"}): ${have || "no features responded"}.${caps.search ? "" : " Search needs a search backend (for example SearXNG) configured on the server."}`,
    };
  } catch (err) {
    return fail(err);
  }
}
