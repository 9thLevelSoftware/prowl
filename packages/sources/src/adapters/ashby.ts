import { htmlToText, type RawJob } from "@prowl/shared";
import { getJson } from "../http";
import type { SourceAdapter } from "../types";
import { ashbyApi } from "../endpoints";

interface AshbyJob {
  id: string;
  title: string;
  location: string;
  secondaryLocations?: { location: string }[];
  isRemote?: boolean;
  workplaceType?: string;
  isListed?: boolean;
  publishedAt?: string;
  jobUrl: string;
  applyUrl: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: {
    compensationTiers?: { components?: { compensationType: string; interval: string; minValue: number | null; maxValue: number | null }[] }[];
  };
}

export interface AshbyConfig {
  org: string;
  companyName?: string;
}

export function mapAshbyJob(j: AshbyJob, cfg: AshbyConfig): RawJob {
  const salary = j.compensation?.compensationTiers
    ?.flatMap((t) => t.components ?? [])
    .find((c) => c.compensationType === "Salary" && c.interval === "1 YEAR");
  const locations = [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean);
  return {
    externalId: `ashby:${cfg.org}:${j.id}`,
    title: j.title.trim(),
    company: cfg.companyName || cfg.org,
    location: locations.join("; "),
    remote: j.isRemote ?? null,
    salaryMin: salary?.minValue ?? null,
    salaryMax: salary?.maxValue ?? null,
    descriptionText: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ""),
    applyUrl: j.applyUrl || `${j.jobUrl}/application`,
    postingUrl: j.jobUrl,
    postedAt: j.publishedAt ?? null,
    atsType: "ashby",
  };
}

export const ashby: SourceAdapter<AshbyConfig> = {
  type: "ashby",
  label: "Ashby board",
  description: "A company's public Ashby job board. Free official API, and applications can be submitted automatically.",
  usesBrowser: false,
  configFields: [
    { key: "org", label: "Organization slug", placeholder: "ramp", required: true, help: "The slug in jobs.ashbyhq.com/<slug>" },
    { key: "companyName", label: "Company name", placeholder: "Ramp" },
  ],
  validate(c) {
    const org = String(c.org ?? "").trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(org)) throw new Error("Organization must be the slug from jobs.ashbyhq.com/<slug>");
    return { org, companyName: c.companyName ? String(c.companyName) : undefined };
  },
  async discover(cfg, ctx) {
    ctx.progress(`Fetching Ashby board ${cfg.org}`);
    const data = await getJson<{ jobs: AshbyJob[] }>(
      `${ashbyApi()}/job-board/${encodeURIComponent(cfg.org)}?includeCompensation=true`,
    );
    return { jobs: data.jobs.filter((j) => j.isListed !== false).map((j) => mapAshbyJob(j, cfg)) };
  },
};
