import { htmlToText, type RawJob } from "@jh/shared";
import { getJson } from "../http";
import type { SourceAdapter } from "../types";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at: string;
  first_published?: string;
  company_name?: string;
  location?: { name: string };
  content?: string;
  metadata?: { name: string; value: unknown }[] | null;
}

export interface GreenhouseConfig {
  boardToken: string;
  companyName?: string;
}

/**
 * The embed URL always serves Greenhouse's own application form. The board URL and absolute_url
 * redirect to the company's custom career site for many employers (e.g. Stripe).
 */
export function greenhouseApplyUrl(boardToken: string, jobId: string | number): string {
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(boardToken)}&token=${encodeURIComponent(String(jobId))}`;
}

export function mapGreenhouseJob(j: GhJob, cfg: GreenhouseConfig): RawJob {
  const location = j.location?.name ?? "";
  return {
    externalId: `gh:${cfg.boardToken}:${j.id}`,
    title: j.title,
    company: cfg.companyName || j.company_name || cfg.boardToken,
    location,
    remote: /remote/i.test(location) ? true : null,
    salaryMin: null,
    salaryMax: null,
    descriptionText: htmlToText(j.content ?? ""),
    applyUrl: greenhouseApplyUrl(cfg.boardToken, j.id),
    postingUrl: j.absolute_url,
    postedAt: j.first_published ?? j.updated_at ?? null,
    atsType: "greenhouse",
  };
}

export const greenhouse: SourceAdapter<GreenhouseConfig> = {
  type: "greenhouse",
  label: "Greenhouse board",
  description: "A company's public Greenhouse job board. Free official API, and applications can be submitted automatically.",
  usesBrowser: false,
  configFields: [
    { key: "boardToken", label: "Board token", placeholder: "stripe", required: true, help: "The slug in boards.greenhouse.io/<token>" },
    { key: "companyName", label: "Company name", placeholder: "Stripe" },
  ],
  validate(c) {
    const boardToken = String(c.boardToken ?? "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(boardToken)) throw new Error("Board token must be the slug from boards.greenhouse.io/<token>");
    return { boardToken, companyName: c.companyName ? String(c.companyName) : undefined };
  },
  async discover(cfg, ctx) {
    ctx.progress(`Fetching Greenhouse board ${cfg.boardToken}`);
    const data = await getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(cfg.boardToken)}/jobs?content=true`);
    return { jobs: data.jobs.map((j) => mapGreenhouseJob(j, cfg)) };
  },
};
