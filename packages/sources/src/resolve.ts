import { logger, type RawJob } from "@jh/shared";
import { detectAts } from "./ats";
import { getJson, politeFetch } from "./http";
import { mapGreenhouseJob } from "./adapters/greenhouse";
import { mapLeverPosting } from "./adapters/lever";
import { mapAshbyJob } from "./adapters/ashby";
import { ashbyApi, greenhouseApi, leverApi } from "./endpoints";

const log = logger("resolve");

/** Follow redirects to find where a link really lands. */
export async function finalUrl(url: string): Promise<string> {
  try {
    const res = await politeFetch(url, { redirect: "follow", timeoutMs: 20_000, headers: { accept: "text/html" } });
    const landed = res.url || url;
    // Aggregators often hop via a meta refresh or a JS redirect page.
    if (res.ok && res.headers.get("content-type")?.includes("html")) {
      const html = (await res.text()).slice(0, 200_000);
      const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=([^"'>\s]+)/i)?.[1];
      const js = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/)?.[1];
      const next = meta ?? js;
      if (next && /^https?:/i.test(next) && detectAts(next).ats !== "other") return next;
    }
    return landed;
  } catch (err) {
    log.debug(`could not resolve ${url}: ${(err as Error).message}`);
    return url;
  }
}

/**
 * Given any URL that points at a Greenhouse, Lever, or Ashby posting, fetch the full posting
 * from the official API. Returns null for other hosts or when the posting cannot be found.
 */
export async function fetchAtsJob(url: string, companyName?: string): Promise<RawJob | null> {
  const d = detectAts(url);
  try {
    if (d.ats === "greenhouse" && d.board && d.jobId) {
      const j = await getJson<any>(`${greenhouseApi()}/boards/${d.board}/jobs/${d.jobId}`);
      return mapGreenhouseJob(j, { boardToken: d.board, companyName });
    }
    if (d.ats === "lever" && d.board && d.jobId) {
      const p = await getJson<any>(`${leverApi()}/postings/${d.board}/${d.jobId}?mode=json`);
      return mapLeverPosting(p, { company: d.board, companyName });
    }
    if (d.ats === "ashby" && d.board && d.jobId) {
      const data = await getJson<{ jobs: any[] }>(`${ashbyApi()}/job-board/${d.board}?includeCompensation=true`);
      const j = data.jobs.find((x) => x.id === d.jobId);
      return j ? mapAshbyJob(j, { org: d.board, companyName }) : null;
    }
  } catch (err) {
    log.debug(`ATS lookup failed for ${url}: ${(err as Error).message}`);
  }
  return null;
}
