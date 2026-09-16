import { htmlToText, type RawJob } from "@jh/shared";
import { getJson } from "../http";
import type { SourceAdapter } from "../types";
import { leverApi } from "../endpoints";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl: string;
  createdAt: number;
  categories?: { location?: string; commitment?: string; team?: string; allLocations?: string[] };
  workplaceType?: string;
  descriptionPlain?: string;
  description?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export interface LeverConfig {
  company: string;
  companyName?: string;
  region?: "global" | "eu";
}

export function mapLeverPosting(p: LeverPosting, cfg: LeverConfig): RawJob {
  const location = p.categories?.allLocations?.join("; ") || p.categories?.location || "";
  const lists = (p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n\n");
  const salary = p.salaryRange?.interval?.includes("year") ? p.salaryRange : undefined;
  return {
    externalId: `lever:${cfg.company}:${p.id}`,
    title: p.text,
    company: cfg.companyName || cfg.company,
    location,
    remote: p.workplaceType ? p.workplaceType === "remote" : /remote/i.test(location) ? true : null,
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    descriptionText: [p.descriptionPlain ?? htmlToText(p.description ?? ""), lists, p.additionalPlain ?? ""].filter(Boolean).join("\n\n"),
    applyUrl: p.applyUrl || `${p.hostedUrl}/apply`,
    postingUrl: p.hostedUrl,
    postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    atsType: "lever",
  };
}

export const lever: SourceAdapter<LeverConfig> = {
  type: "lever",
  label: "Lever board",
  description: "A company's public Lever postings. Free official API, and applications can be submitted automatically.",
  usesBrowser: false,
  configFields: [
    { key: "company", label: "Company slug", placeholder: "palantir", required: true, help: "The slug in jobs.lever.co/<slug>" },
    { key: "companyName", label: "Company name", placeholder: "Palantir" },
  ],
  validate(c) {
    const company = String(c.company ?? "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(company)) throw new Error("Company must be the slug from jobs.lever.co/<slug>");
    return { company, companyName: c.companyName ? String(c.companyName) : undefined, region: c.region === "eu" ? "eu" : "global" };
  },
  async discover(cfg, ctx) {
    ctx.progress(`Fetching Lever postings for ${cfg.company}`);
    const data = await getJson<LeverPosting[]>(`${leverApi(cfg.region)}/postings/${encodeURIComponent(cfg.company)}?mode=json`);
    return { jobs: data.map((p) => mapLeverPosting(p, cfg)) };
  },
};
