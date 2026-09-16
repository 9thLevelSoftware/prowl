import { htmlToText, type RawJob } from "@jh/shared";
import { detectAts } from "../ats";
import { getJson } from "../http";
import { fetchAtsJob, finalUrl } from "../resolve";
import type { SourceAdapter } from "../types";

interface AdzunaResult {
  id: string;
  title: string;
  description: string;
  redirect_url: string;
  created: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string;
}

export interface AdzunaConfig {
  what: string;
  where: string;
  country: string;
  maxDaysOld: number;
  pages: number;
  /** How many results to follow to their real posting (to find an appliable ATS and the full description). */
  resolveLimit: number;
}

export const adzuna: SourceAdapter<AdzunaConfig> = {
  type: "adzuna",
  label: "Adzuna search",
  description:
    "Broad job search across many boards through Adzuna's official API. Needs a free app id and key. Results that lead to Greenhouse, Lever, or Ashby become appliable; the rest are listed with a link.",
  usesBrowser: false,
  configFields: [
    { key: "what", label: "Keywords", placeholder: "senior backend engineer", required: true },
    { key: "where", label: "Location", placeholder: "Austin, TX (blank for anywhere)" },
    { key: "country", label: "Country code", placeholder: "us" },
    { key: "maxDaysOld", label: "Max days old", placeholder: "7" },
    { key: "pages", label: "Pages (50 results each)", placeholder: "2" },
  ],
  validate(c) {
    const what = String(c.what ?? "").trim();
    if (!what) throw new Error("Keywords are required");
    return {
      what,
      where: String(c.where ?? "").trim(),
      country: String(c.country || process.env.ADZUNA_COUNTRY || "us").toLowerCase(),
      maxDaysOld: Math.max(1, Number(c.maxDaysOld) || 7),
      pages: Math.min(10, Math.max(1, Number(c.pages) || 2)),
      resolveLimit: Math.min(100, Math.max(0, Number(c.resolveLimit ?? 40))),
    };
  },
  async discover(cfg, ctx) {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) throw new Error("ADZUNA_APP_ID and ADZUNA_APP_KEY must be set in .env (free at developer.adzuna.com)");

    const results: AdzunaResult[] = [];
    for (let page = 1; page <= cfg.pages; page++) {
      const q = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        what: cfg.what,
        results_per_page: "50",
        max_days_old: String(cfg.maxDaysOld),
        "content-type": "application/json",
      });
      if (cfg.where) q.set("where", cfg.where);
      ctx.progress(`Adzuna page ${page}: "${cfg.what}"${cfg.where ? ` in ${cfg.where}` : ""}`);
      const data = await getJson<{ results: AdzunaResult[] }>(`https://api.adzuna.com/v1/api/jobs/${cfg.country}/search/${page}?${q}`);
      results.push(...data.results);
      if (data.results.length < 50) break;
    }

    const jobs: RawJob[] = [];
    let resolved = 0;
    for (const r of results) {
      const company = r.company?.display_name ?? "Unknown company";
      let job: RawJob = {
        externalId: `adzuna:${r.id}`,
        title: htmlToText(r.title),
        company,
        location: r.location?.display_name ?? "",
        remote: /remote/i.test(`${r.title} ${r.location?.display_name}`) ? true : null,
        salaryMin: r.salary_is_predicted === "1" ? null : (r.salary_min ?? null),
        salaryMax: r.salary_is_predicted === "1" ? null : (r.salary_max ?? null),
        descriptionText: htmlToText(r.description),
        applyUrl: r.redirect_url,
        postingUrl: r.redirect_url,
        postedAt: r.created,
        atsType: "other",
      };
      // Adzuna descriptions are truncated snippets. Follow the link to find the real posting.
      if (resolved < cfg.resolveLimit) {
        resolved++;
        const landed = await finalUrl(r.redirect_url);
        const full = await fetchAtsJob(landed, company);
        if (full) job = { ...full, salaryMin: full.salaryMin ?? job.salaryMin, salaryMax: full.salaryMax ?? job.salaryMax };
        else job = { ...job, applyUrl: landed, postingUrl: landed, atsType: detectAts(landed).ats };
      }
      jobs.push(job);
    }
    return { jobs, notes: [`${results.length} results, ${resolved} followed to their source`] };
  },
};
