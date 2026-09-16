import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { z } from "zod";
import { htmlToText, logger, type RawJob } from "@jh/shared";
import { detectAts, findEmbeddedBoards } from "../ats";
import { politeFetch, robotsAllowed } from "../http";
import { fetchAtsJob } from "../resolve";
import type { SourceAdapter, SourceContext } from "../types";
import { greenhouse } from "./greenhouse";
import { lever } from "./lever";
import { ashby } from "./ashby";

const log = logger("careerpage");

export interface CareerPageConfig {
  url: string;
  companyName: string;
  maxJobPages: number;
}

async function fetchHtml(url: string): Promise<{ html: string; url: string } | null> {
  if (!(await robotsAllowed(url))) {
    log.info(`robots.txt disallows ${url}`);
    return null;
  }
  try {
    const res = await politeFetch(url, { headers: { accept: "text/html" }, timeoutMs: 25_000 });
    if (!res.ok || !res.headers.get("content-type")?.includes("html")) return null;
    return { html: await res.text(), url: res.url || url };
  } catch {
    return null;
  }
}

/** Many career pages build their job list with JavaScript. Render once with a throwaway headless browser. */
async function renderHtml(url: string): Promise<string | null> {
  const browser = await chromium.launch({ headless: true }).catch(() => null);
  if (!browser) return null;
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => undefined);
    const frames = await Promise.all(page.frames().map((f) => f.content().catch(() => "")));
    return frames.join("\n");
  } finally {
    await browser.close();
  }
}

function candidateUrls(input: string): string[] {
  const u = new URL(/^https?:/i.test(input) ? input : `https://${input}`);
  const origin = `${u.protocol}//${u.host}`;
  const list = [u.toString()];
  if (u.pathname === "/" || !u.pathname) list.push(`${origin}/careers`, `${origin}/jobs`, `${origin}/company/careers`, `${origin}/about/careers`);
  return [...new Set(list)];
}

const JobLinksOut = z.object({
  jobs: z.array(z.object({ title: z.string(), url: z.string(), location: z.string() })),
});

export const careerpage: SourceAdapter<CareerPageConfig> = {
  type: "careerpage",
  label: "Company career page",
  description:
    "Crawl a company's careers page. If it embeds Greenhouse, Lever, or Ashby, that board is added as its own source automatically. Otherwise job links are extracted from the page.",
  usesBrowser: false,
  configFields: [
    { key: "url", label: "Careers URL or domain", placeholder: "https://example.com/careers", required: true },
    { key: "companyName", label: "Company name", placeholder: "Example Inc", required: true },
  ],
  validate(c) {
    const url = String(c.url ?? "").trim();
    const companyName = String(c.companyName ?? "").trim();
    if (!url) throw new Error("URL is required");
    if (!companyName) throw new Error("Company name is required");
    new URL(/^https?:/i.test(url) ? url : `https://${url}`);
    return { url, companyName, maxJobPages: Math.min(60, Math.max(1, Number(c.maxJobPages) || 25)) };
  },
  async discover(cfg, ctx: SourceContext) {
    const pages: { html: string; url: string }[] = [];
    for (const url of candidateUrls(cfg.url)) {
      const page = await fetchHtml(url);
      if (page) pages.push(page);
    }
    // One hop into links that look like the jobs listing.
    const hops = new Set<string>();
    for (const p of pages) {
      const $ = cheerio.load(p.html);
      $("a[href]").each((_, a) => {
        const href = $(a).attr("href") ?? "";
        const text = $(a).text().toLowerCase();
        if (/(open (roles|positions)|view (all )?jobs|job openings|see openings|careers|join us)/.test(text) || /\/(jobs|careers|openings)(\/|$|\?)/i.test(href)) {
          try {
            hops.add(new URL(href, p.url).toString());
          } catch {
            /* ignore bad links */
          }
        }
      });
    }
    for (const url of [...hops].slice(0, 5)) {
      if (pages.some((p) => p.url === url)) continue;
      const page = await fetchHtml(url);
      if (page) pages.push(page);
    }

    let boards = pages.flatMap((p) => findEmbeddedBoards(p.html));
    if (!boards.length && pages[0]) {
      ctx.progress(`No board in static HTML for ${cfg.companyName}; rendering page`);
      const target = pages[pages.length - 1]!.url;
      const rendered = ctx.firecrawl ? await ctx.firecrawl.scrape(target).then((r) => r.rawHtml, () => renderHtml(target)) : await renderHtml(target);
      if (rendered) {
        boards = findEmbeddedBoards(rendered);
        pages.push({ html: rendered, url: pages[pages.length - 1]!.url });
      }
    }
    const unique = [...new Map(boards.map((b) => [`${b.type}:${b.token}`, b])).values()];

    if (unique.length) {
      ctx.progress(`Found ${unique.map((b) => `${b.type}/${b.token}`).join(", ")} on ${cfg.companyName}'s career page`);
      const jobs: RawJob[] = [];
      for (const b of unique) {
        try {
          if (b.type === "greenhouse") jobs.push(...(await greenhouse.discover({ boardToken: b.token, companyName: cfg.companyName }, ctx)).jobs);
          if (b.type === "lever") jobs.push(...(await lever.discover({ company: b.token, companyName: cfg.companyName }, ctx)).jobs);
          if (b.type === "ashby") jobs.push(...(await ashby.discover({ org: b.token, companyName: cfg.companyName }, ctx)).jobs);
        } catch (err) {
          ctx.progress(`Board ${b.type}/${b.token} failed: ${(err as Error).message}`);
        }
      }
      return {
        jobs,
        discoveredSources: unique.map((b) => ({
          type: b.type,
          name: `${cfg.companyName} (${b.type})`,
          config: b.type === "greenhouse" ? { boardToken: b.token, companyName: cfg.companyName } : b.type === "lever" ? { company: b.token, companyName: cfg.companyName } : { org: b.token, companyName: cfg.companyName },
        })),
      };
    }

    if (!ctx.llm) return { jobs: [], notes: ["No embedded ATS found and no LLM available for link extraction"] };
    if (!pages.length) return { jobs: [], notes: ["Could not load the career page (blocked, robots.txt, or offline)"] };

    // Generic page: ask the model which links are individual job postings.
    const anchors = pages.flatMap((p) => {
      const $ = cheerio.load(p.html);
      return $("a[href]")
        .map((_, a) => {
          try {
            return `${$(a).text().replace(/\s+/g, " ").trim().slice(0, 120)} -> ${new URL($(a).attr("href")!, p.url).toString()}`;
          } catch {
            return "";
          }
        })
        .get()
        .filter((x) => x.length > 5);
    });
    const listing = [...new Set(anchors)].slice(0, 600).join("\n");
    const out = await ctx.llm.object({ task: "careerpage_links", tier: "fast" }, JobLinksOut, {
      system: "From a list of links on a company careers page, return only links to individual job postings. Use the link text as the title. Location is empty when not shown.",
      prompt: `Company: ${cfg.companyName}\nLinks (text -> url):\n${listing}`,
    });

    const jobs: RawJob[] = [];
    for (const l of out.jobs.slice(0, cfg.maxJobPages)) {
      const viaAts = await fetchAtsJob(l.url, cfg.companyName);
      if (viaAts) {
        jobs.push(viaAts);
        continue;
      }
      const page = await fetchHtml(l.url);
      if (!page) continue;
      const $ = cheerio.load(page.html);
      $("script,style,nav,footer,header").remove();
      const text = htmlToText($("main").html() ?? $("body").html() ?? "").slice(0, 20_000);
      jobs.push({
        externalId: `career:${l.url}`,
        title: l.title,
        company: cfg.companyName,
        location: l.location,
        remote: /remote/i.test(`${l.title} ${l.location}`) ? true : null,
        salaryMin: null,
        salaryMax: null,
        descriptionText: text,
        applyUrl: l.url,
        postingUrl: l.url,
        postedAt: null,
        atsType: detectAts(l.url).ats,
      });
    }
    return { jobs };
  },
};
