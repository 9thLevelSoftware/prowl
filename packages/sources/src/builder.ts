import { z } from "zod";
import { and, eq, existingSourceKeys, inArray, schema as s, upsertSuggestion, type Db } from "@jh/db";
import type { LlmClient } from "@jh/llm";
import { APPLIABLE_ATS, LOCAL_USER_ID, logger, normalizeText, type Preferences, type ProfileData, type RawJob, type SourceType } from "@jh/shared";
import { detectAts, findEmbeddedBoards } from "./ats";
import { politeFetch } from "./http";
import { prefilter, titleMatchStrength } from "./filter";
import { ashbyApi, greenhouseApi, leverApi } from "./endpoints";
import { mapAshbyJob } from "./adapters/ashby";
import { mapGreenhouseJob } from "./adapters/greenhouse";
import { mapLeverPosting } from "./adapters/lever";
import type { Firecrawl } from "./web/firecrawl";
import type { WebSearch } from "./web/search";

const log = logger("builder");

export type BoardType = "greenhouse" | "lever" | "ashby";

export interface CompanyHints {
  pursue: string[];
  avoid: string[];
  industries: string[];
  stageOrSize: string[];
}

export interface BuilderInput {
  userId?: string;
  runId: string;
  profile: ProfileData;
  prefs: Preferences;
  hints: CompanyHints;
  llm: LlmClient;
  webSearch: WebSearch;
  firecrawl: Firecrawl | null;
  progress: (message: string) => void;
  /** How many employers to ask the AI for. */
  aiCompanies?: number;
}

export interface BuilderResult {
  candidates: number;
  verified: number;
  unconfirmed: number;
  notFound: number;
  searches: number;
  webSearchProvider: string;
}

export interface Candidate {
  origin: "ai" | "web_search" | "learned";
  name: string;
  domain: string;
  why: string;
  slugGuesses: string[];
  /** Known board from a URL; skips slug guessing. */
  board?: { type: BoardType; token: string };
}

interface BoardCheck {
  exists: boolean;
  jobs: RawJob[];
  /** Company name the ATS reports (Greenhouse only). */
  name: string | null;
  /** Free text that can confirm identity (board description, job descriptions). */
  text: string;
}

/* ============================== Name matching ============================= */

const SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|group|holdings|technologies|technology|labs|hq|ai|io|the)\b/g;

export function normalizeCompany(name: string): string {
  return normalizeText(name).replace(SUFFIXES, " ").replace(/[^a-z0-9]+/g, "").trim();
}

export function namesMatch(a: string, b: string): boolean {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // Prefix matches ("Stripe" vs "Stripe Payments") only for distinctive names; short ones like "Nova" collide too often.
  return short.length >= 6 && long.startsWith(short);
}

export function domainRoot(domain: string): string {
  const host = domain.replace(/^https?:\/\//, "").split("/")[0]!.toLowerCase().replace(/^www\./, "");
  const parts = host.split(".");
  return parts.length >= 2 ? parts[parts.length - 2]! : host;
}

/** Plausible ATS slugs for a company, most likely first. */
export function slugVariants(name: string, domain: string, guesses: string[] = []): string[] {
  const words = normalizeText(name).replace(SUFFIXES, " ").split(/\s+/).filter(Boolean);
  const raw = normalizeText(name).split(/\s+/).filter(Boolean);
  const out = [
    ...guesses.map((g) => g.toLowerCase().trim()),
    words.join(""),
    domain ? domainRoot(domain) : "",
    words.join("-"),
    raw.join(""),
    raw.join("-"),
    words[0] && words.length > 1 ? words[0] : "",
  ];
  return [...new Set(out.filter((v) => /^[a-z0-9][a-z0-9._-]{1,60}$/.test(v)))].slice(0, 6);
}

/* ============================== Board checks ============================== */

async function getJsonStatus(url: string): Promise<{ status: number; json: any }> {
  try {
    const res = await politeFetch(url, { minIntervalMs: 250, timeoutMs: 20_000 });
    return { status: res.status, json: res.ok ? await res.json().catch(() => null) : null };
  } catch {
    return { status: 0, json: null };
  }
}

export async function checkBoard(type: BoardType, token: string): Promise<BoardCheck> {
  const t = encodeURIComponent(token);
  if (type === "greenhouse") {
    const jobs = await getJsonStatus(`${greenhouseApi()}/boards/${t}/jobs?content=true`);
    if (jobs.status !== 200 || !jobs.json) return { exists: false, jobs: [], name: null, text: "" };
    const board = await getJsonStatus(`${greenhouseApi()}/boards/${t}`);
    return {
      exists: true,
      jobs: (jobs.json.jobs ?? []).map((j: any) => mapGreenhouseJob(j, { boardToken: token })),
      name: board.json?.name ?? jobs.json.jobs?.[0]?.company_name ?? null,
      text: String(board.json?.content ?? ""),
    };
  }
  if (type === "lever") {
    const r = await getJsonStatus(`${leverApi()}/postings/${t}?mode=json`);
    if (r.status !== 200 || !Array.isArray(r.json)) return { exists: false, jobs: [], name: null, text: "" };
    const jobs = r.json.map((p: any) => mapLeverPosting(p, { company: token }));
    return { exists: true, jobs, name: null, text: jobs.slice(0, 5).map((j: RawJob) => j.descriptionText.slice(0, 3000)).join("\n") };
  }
  const r = await getJsonStatus(`${ashbyApi()}/job-board/${t}?includeCompensation=true`);
  if (r.status !== 200 || !r.json?.jobs) return { exists: false, jobs: [], name: null, text: "" };
  const jobs = (r.json.jobs as any[]).filter((j) => j.isListed !== false).map((j) => mapAshbyJob(j, { org: token }));
  return { exists: true, jobs, name: null, text: jobs.slice(0, 5).map((j: RawJob) => j.descriptionText.slice(0, 3000)).join("\n") };
}

/**
 * Decide whether a board really belongs to the candidate company. Guessed slugs collide
 * (for example a generic word used by an unrelated company), so unconfirmed matches are never
 * pre-selected.
 */
export function confirmIdentity(c: Pick<Candidate, "name" | "domain" | "origin">, token: string, check: BoardCheck, viaUrl: boolean): boolean {
  if (check.name && namesMatch(check.name, c.name)) return true;
  if (c.domain && check.text.toLowerCase().includes(domainRoot(c.domain) + ".")) return true;
  const slug = normalizeCompany(token);
  if (slug && (slug === normalizeCompany(c.name) || (c.domain && slug === normalizeCompany(domainRoot(c.domain))))) {
    // Exact slug match. Greenhouse also reports a name, so require that to agree when present.
    return !check.name || namesMatch(check.name, c.name);
  }
  if (viaUrl && (c.origin === "web_search" || c.origin === "learned")) return true;
  const mentions = (check.text.match(new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi")) ?? []).length;
  return mentions >= 2;
}

function boardConfig(type: BoardType, token: string, company: string): Record<string, unknown> {
  if (type === "greenhouse") return { boardToken: token, companyName: company };
  if (type === "lever") return { company: token, companyName: company };
  return { org: token, companyName: company };
}

const NAME_SUFFIXES = ["technologies", "technology", "software", "systems", "labs", "health", "financial", "capital", "security", "robotics", "analytics", "solutions", "group", "games", "bank", "inc", "hq", "ai", "io", "app"];

/** "canarytechnologies" becomes "Canary Technologies". Lever and Ashby don't return a company name. */
export function prettyToken(token: string): string {
  let text = token.replace(/[-_.]+/g, " ").trim().toLowerCase();
  if (!text.includes(" ")) {
    const suffix = NAME_SUFFIXES.find((x) => text.endsWith(x) && text.length - x.length >= 3);
    if (suffix) text = `${text.slice(0, -suffix.length)} ${suffix}`;
  }
  return text
    .split(" ")
    .filter(Boolean)
    .map((w) => (["ai", "hq", "io"].includes(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/* ================================ Candidates ============================== */

const SuggestOut = z.object({
  companies: z.array(
    z.object({
      name: z.string(),
      domain: z.string().describe("Primary website domain, e.g. stripe.com"),
      why: z.string().describe("One sentence on why this employer fits the candidate"),
      slugGuesses: z.array(z.string()).describe("Likely job board slugs, e.g. 'stripe' for boards.greenhouse.io/stripe"),
    }),
  ),
});

async function aiCandidates(input: BuilderInput, exclude: string[]): Promise<Candidate[]> {
  const p = input.profile;
  const recent = p.work.slice(0, 4).map((w) => `${w.title} at ${w.company}`).join("; ");
  const out = await input.llm.object({ task: "source_suggest", tier: "smart", maxOutputTokens: 12_000 }, SuggestOut, {
    system: `You recommend employers for a job seeker to watch. Suggest real companies that are likely to hire for the candidate's target roles and fit their preferences.
Prefer employers that publish jobs on Greenhouse, Lever, or Ashby, but include other strong fits too.
Do not suggest companies the candidate wants to avoid, their current employer, or companies already being watched.
Mix well-known and lesser-known employers. Do not invent companies.`,
    prompt: `Candidate background: ${recent}
Headline: ${p.headline}
Target titles: ${input.prefs.targetTitles.join(", ") || "(not set)"}
Seniority: ${input.prefs.seniority.join(", ") || "(not set)"}
Locations: ${input.prefs.locations.join(", ") || "(any)"}; remote policy: ${input.prefs.remotePolicy}
Industries to pursue: ${[...input.prefs.industriesInclude, ...input.hints.industries].join(", ") || "(open)"}
Industries to avoid: ${input.prefs.industriesExclude.join(", ") || "(none)"}
Company stage/size preferences: ${input.hints.stageOrSize.join(", ") || "(open)"}
Companies the candidate named as interesting: ${input.hints.pursue.join(", ") || "(none)"}
Do not include: ${exclude.join(", ") || "(none)"}

Return ${input.aiCompanies ?? 30} companies. Include every company the candidate named as interesting.`,
  });
  return out.companies.map((c) => ({ origin: "ai" as const, name: c.name.trim(), domain: c.domain.trim(), why: c.why.trim(), slugGuesses: c.slugGuesses }));
}

async function webCandidates(input: BuilderInput): Promise<Candidate[]> {
  if (input.webSearch.provider === "none") return [];
  const titles = input.prefs.targetTitles.slice(0, 3);
  const where = input.prefs.remotePolicy === "remote_only" ? "remote" : (input.prefs.locations[0] ?? "");
  const found = new Map<string, Candidate>();
  for (const title of titles) {
    const query = `"${title}" ${where} (site:job-boards.greenhouse.io OR site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com)`;
    input.progress(`Searching the web for ${title} roles`);
    try {
      const urls = await input.webSearch.findUrls(query, "Find current job postings on company job boards for a job seeker.");
      for (const url of urls) {
        const d = detectAts(url);
        if (!d.board || !(APPLIABLE_ATS as readonly string[]).includes(d.ats)) continue;
        const key = `${d.ats}:${d.board.toLowerCase()}`;
        if (!found.has(key)) found.set(key, { origin: "web_search", name: prettyToken(d.board), domain: "", why: `Has open ${title} roles found by web search`, slugGuesses: [], board: { type: d.ats as BoardType, token: d.board } });
      }
    } catch (err) {
      log.warn(`web search failed for "${title}": ${(err as Error).message}`);
    }
  }
  return [...found.values()];
}

/** Boards behind jobs already found through other sources (Adzuna, LinkedIn, career pages). */
export function learnedCandidates(db: Db, userId = LOCAL_USER_ID): Candidate[] {
  const rows = db
    .select({ applyUrl: s.jobs.applyUrl, company: s.jobs.company })
    .from(s.jobs)
    .where(and(eq(s.jobs.userId, userId), inArray(s.jobs.atsType, ["greenhouse", "lever", "ashby"])))
    .all();
  const out = new Map<string, Candidate>();
  for (const r of rows) {
    const d = detectAts(r.applyUrl);
    if (!d.board) continue;
    const key = `${d.ats}:${d.board.toLowerCase()}`;
    if (!out.has(key)) out.set(key, { origin: "learned", name: r.company || prettyToken(d.board), domain: "", why: "A job from this employer was already found through another source", slugGuesses: [], board: { type: d.ats as BoardType, token: d.board } });
  }
  return [...out.values()];
}

/* ================================ Resolution ============================== */

async function careersPageBoards(domain: string, firecrawl: Firecrawl | null): Promise<{ type: BoardType; token: string }[]> {
  const origin = `https://${domain.replace(/^https?:\/\//, "").split("/")[0]}`;
  const pages = [`${origin}/careers`, `${origin}/jobs`, origin];
  for (const url of pages) {
    try {
      let html = "";
      if (firecrawl) html = (await firecrawl.scrape(url)).rawHtml;
      else {
        const res = await politeFetch(url, { timeoutMs: 15_000, headers: { accept: "text/html" } });
        if (res.ok) html = await res.text();
      }
      const boards = findEmbeddedBoards(html);
      if (boards.length) return boards;
    } catch {
      /* try the next page */
    }
  }
  return [];
}

interface Resolved {
  status: "verified" | "unconfirmed" | "not_found";
  type: SourceType;
  token: string | null;
  company: string;
  jobs: RawJob[];
  note: string | null;
}

export async function resolveCandidate(c: Candidate, firecrawl: Firecrawl | null): Promise<Resolved> {
  const tryBoard = async (type: BoardType, token: string, viaUrl: boolean): Promise<Resolved | null> => {
    const check = await checkBoard(type, token);
    if (!check.exists) return null;
    const company = check.name ?? (c.origin === "ai" ? c.name : prettyToken(token));
    const confirmed = confirmIdentity(c, token, check, viaUrl);
    return {
      status: confirmed ? "verified" : "unconfirmed",
      type,
      token,
      company,
      jobs: check.jobs,
      note: confirmed ? null : `A ${type} board named "${token}" exists${check.name ? ` for "${check.name}"` : ""}, but it couldn't be confirmed as ${c.name}.`,
    };
  };

  if (c.board) return (await tryBoard(c.board.type, c.board.token, true)) ?? { status: "not_found", type: "careerpage", token: null, company: c.name, jobs: [], note: "The board from the search result no longer exists." };

  let fallback: Resolved | null = null;
  for (const slug of slugVariants(c.name, c.domain, c.slugGuesses)) {
    for (const type of ["greenhouse", "ashby", "lever"] as BoardType[]) {
      const r = await tryBoard(type, slug, false);
      if (r?.status === "verified") return r;
      if (r && !fallback) fallback = r;
    }
  }
  if (c.domain) {
    for (const b of await careersPageBoards(c.domain, firecrawl)) {
      if (!(["greenhouse", "lever", "ashby"] as string[]).includes(b.type)) continue;
      // Found on the company's own careers page, so it is theirs.
      const check = await checkBoard(b.type, b.token);
      if (check.exists) return { status: "verified", type: b.type, token: b.token, company: c.name, jobs: check.jobs, note: null };
    }
  }
  return fallback ?? { status: "not_found", type: "careerpage", token: null, company: c.name, jobs: [], note: "No Greenhouse, Lever, or Ashby board found. It can still be watched through its careers page." };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

/* ================================== Build ================================= */

export async function buildSources(db: Db, input: BuilderInput): Promise<BuilderResult> {
  const userId = input.userId ?? LOCAL_USER_ID;
  const existing = existingSourceKeys(db, userId);
  const avoid = [...input.prefs.companyExclude, ...input.hints.avoid];
  const isAvoided = (name: string) => avoid.some((a) => namesMatch(a, name));
  const current = input.profile.work.find((w) => /present|current/i.test(w.endDate) || !w.endDate)?.company;

  input.progress("Collecting employers");
  const learned = learnedCandidates(db, userId);
  const web = await webCandidates(input);
  let ai: Candidate[] = [];
  try {
    input.progress("Asking the AI for employers that fit you");
    ai = await aiCandidates(input, [...avoid, ...(current ? [current] : [])]);
  } catch (err) {
    log.warn(`AI suggestions failed: ${(err as Error).message}`);
    input.progress(`AI suggestions failed: ${(err as Error).message}`);
  }

  // De-duplicate across origins: a known board wins over a name-only guess.
  const seen = new Set<string>();
  const candidates = [...learned, ...web, ...ai].filter((c) => {
    if (isAvoided(c.name) || (current && namesMatch(current, c.name))) return false;
    const key = c.board ? `${c.board.type}:${c.board.token.toLowerCase()}` : `name:${normalizeCompany(c.name)}`;
    if (c.board && existing.has(key)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const result: BuilderResult = { candidates: candidates.length, verified: 0, unconfirmed: 0, notFound: 0, searches: 0, webSearchProvider: input.webSearch.provider };
  let done = 0;
  await pool(candidates, 4, async (c) => {
    const r = await resolveCandidate(c, input.firecrawl).catch((err) => {
      log.warn(`could not resolve ${c.name}: ${(err as Error).message}`);
      return null;
    });
    done++;
    if (done % 5 === 0 || done === candidates.length) input.progress(`Checked ${done} of ${candidates.length} employers`);
    if (!r) return;
    const key = r.token ? `${r.type}:${r.token.toLowerCase()}` : `careerpage:${normalizeCompany(c.name)}`;
    if (existing.has(key)) return;
    // Closest titles first, so the samples show the best reasons to add this board.
    const matching = prefilter(r.jobs, input.prefs).sort((x, y) => titleMatchStrength(y.title, input.prefs) - titleMatchStrength(x.title, input.prefs));
    upsertSuggestion(db, {
      userId,
      runId: input.runId,
      origin: c.origin,
      company: r.company,
      domain: c.domain,
      why: c.why,
      type: r.type,
      config: r.token ? boardConfig(r.type as BoardType, r.token, r.company) : { url: c.domain || c.name, companyName: c.name },
      key,
      status: r.status,
      jobsOpen: r.token ? r.jobs.length : null,
      jobsMatching: r.token ? matching.length : null,
      sampleTitles: [...new Set(matching.map((j) => j.title.trim()))].slice(0, 3),
      note: r.note,
    });
    if (r.status === "verified") result.verified++;
    else if (r.status === "unconfirmed") result.unconfirmed++;
    else result.notFound++;
  });

  result.searches = addSearchSuggestions(db, input, userId, existing);
  input.progress(`Done: ${result.verified} verified boards, ${result.unconfirmed} unconfirmed, ${result.notFound} without a known board, ${result.searches} searches`);
  return result;
}

/** Adzuna searches (when keys exist) and discover-only LinkedIn/Indeed searches from target titles. */
export function addSearchSuggestions(db: Db, input: Pick<BuilderInput, "prefs" | "runId">, userId: string, existing: Set<string>): number {
  const titles = input.prefs.targetTitles.slice(0, 2);
  const places = input.prefs.remotePolicy === "remote_only" ? ["remote"] : input.prefs.locations.slice(0, 2).length ? input.prefs.locations.slice(0, 2) : [""];
  let n = 0;
  const add = (type: SourceType, config: Record<string, unknown>, key: string, company: string, why: string, note: string | null) => {
    if (existing.has(key)) return;
    upsertSuggestion(db, { userId, runId: input.runId, origin: "search", company, domain: "", why, type, config, key, status: "verified", note });
    n++;
  };
  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
    for (const title of titles) {
      for (const where of places.slice(0, 2)) {
        const w = where === "remote" ? "" : where;
        const what = where === "remote" ? `${title} remote` : title;
        add("adzuna", { what, where: w, maxDaysOld: 7, pages: 2 }, `adzuna:${what.toLowerCase()}|${w.toLowerCase()}`, `Adzuna: ${what}${w ? ` in ${w}` : ""}`, "Searches many job boards at once", null);
      }
    }
  }
  const top = titles[0];
  if (top) {
    const loc = places[0] === "remote" ? "" : (places[0] ?? "");
    for (const type of ["linkedin", "indeed"] as const) {
      add(type, { keywords: top, location: loc, maxDetailPages: 10, postedWithinDays: 7 }, `${type}:${top.toLowerCase()}|${loc.toLowerCase()}`, `${type === "linkedin" ? "LinkedIn" : "Indeed"}: ${top}`, "Reads search results in your signed-in browser", "Discover only. The site's terms restrict automation, so this runs slowly and never applies there.");
    }
  }
  return n;
}
