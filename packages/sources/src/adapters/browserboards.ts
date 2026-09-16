import { getContext, withBrowserLock, type Page } from "@jh/browser";
import { logger, randomBetween, sleep, type RawJob } from "@jh/shared";
import { detectAts } from "../ats";
import { fetchAtsJob } from "../resolve";
import type { SourceAdapter, SourceContext } from "../types";

const log = logger("browserboards");

/*
 * LinkedIn and Indeed prohibit automated applications and aggressive scraping. These adapters are
 * deliberately conservative: DISCOVERY ONLY (never apply, never message, never touch profiles),
 * one search per run, a couple of result pages, a small cap on detail pages, and human-like pauses.
 * They run inside the user's own signed-in browser profile, visibly by default.
 */

export interface BrowserBoardConfig {
  keywords: string;
  location: string;
  maxResultPages: number;
  maxDetailPages: number;
  postedWithinDays: number;
}

const pause = (min = 3500, max = 8500) => sleep(randomBetween(min, max));

function commonValidate(c: Record<string, unknown>): BrowserBoardConfig {
  const keywords = String(c.keywords ?? "").trim();
  if (!keywords) throw new Error("Keywords are required");
  return {
    keywords,
    location: String(c.location ?? "").trim(),
    maxResultPages: Math.min(3, Math.max(1, Number(c.maxResultPages) || 1)),
    maxDetailPages: Math.min(25, Math.max(0, Number(c.maxDetailPages) || 10)),
    postedWithinDays: Math.min(30, Math.max(1, Number(c.postedWithinDays) || 7)),
  };
}

async function blockedReason(page: Page): Promise<string | null> {
  const url = page.url();
  if (/\/(login|signin|checkpoint|authwall|uas\/login)/i.test(url)) return "Sign-in required. Use 'Open browser to sign in' on the Sources page.";
  const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000).toLowerCase();
  if (/verify you are human|are you a robot|unusual activity|security check|captcha|additional verification required/.test(text)) {
    return "The site is showing a human verification check. Complete it in the browser window, then run again later.";
  }
  return null;
}

async function externalApplyUrl(page: Page): Promise<string | null> {
  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href)).catch(() => [] as string[]);
  for (const h of hrefs) {
    let target = h;
    try {
      const u = new URL(h);
      target = u.searchParams.get("url") ?? u.searchParams.get("dest") ?? h;
    } catch {
      continue;
    }
    const ats = detectAts(target).ats;
    if (ats === "greenhouse" || ats === "lever" || ats === "ashby" || ats === "workday") return target;
  }
  return null;
}

/* ================================ LinkedIn ================================ */

async function linkedinDiscover(cfg: BrowserBoardConfig, ctx: SourceContext): Promise<RawJob[]> {
  const context = await getContext({ headless: ctx.prefs.headlessBrowser });
  const page = await context.newPage();
  const jobs: RawJob[] = [];
  try {
    const cards = new Map<string, { title: string; company: string; location: string; url: string }>();
    for (let p = 0; p < cfg.maxResultPages; p++) {
      const q = new URLSearchParams({ keywords: cfg.keywords, f_TPR: `r${cfg.postedWithinDays * 86400}`, start: String(p * 25) });
      if (cfg.location) q.set("location", cfg.location);
      ctx.progress(`LinkedIn search page ${p + 1}: ${cfg.keywords}`);
      await page.goto(`https://www.linkedin.com/jobs/search/?${q}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await pause();
      const blocked = await blockedReason(page);
      if (blocked) throw new Error(blocked);
      // Scroll the results list so lazy cards render.
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, randomBetween(500, 900));
        await sleep(randomBetween(500, 1100));
      }
      const found = await page.$$eval('a[href*="/jobs/view/"]', (as) =>
        as.map((a) => {
          const card = a.closest("li") ?? a.parentElement;
          const lines = (card?.textContent ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
          return { href: (a as HTMLAnchorElement).href, title: (a.textContent ?? "").trim().split("\n")[0]?.trim() ?? "", lines };
        }),
      );
      for (const f of found) {
        const id = f.href.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1];
        if (!id || cards.has(id)) continue;
        const rest = f.lines.filter((l) => l !== f.title && !/^(promoted|easy apply|viewed|actively reviewing|with verification)$/i.test(l));
        cards.set(id, { title: f.title || rest[0] || "", company: rest[0] ?? "", location: rest[1] ?? "", url: `https://www.linkedin.com/jobs/view/${id}/` });
      }
      if (found.length < 10) break;
      await pause();
    }

    let details = 0;
    for (const [id, c] of cards) {
      let description = "";
      let applyUrl = c.url;
      if (details < cfg.maxDetailPages) {
        details++;
        await pause(4000, 9000);
        await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        const blocked = await blockedReason(page);
        if (blocked) {
          ctx.progress(`Stopping LinkedIn detail fetch: ${blocked}`);
          details = cfg.maxDetailPages;
        } else {
          description = await page
            .locator("#job-details, .jobs-description__content, .jobs-box__html-content, article")
            .first()
            .innerText({ timeout: 8000 })
            .catch(() => "");
          applyUrl = (await externalApplyUrl(page)) ?? c.url;
        }
      }
      const viaAts = applyUrl !== c.url ? await fetchAtsJob(applyUrl, c.company) : null;
      jobs.push(
        viaAts ?? {
          externalId: `linkedin:${id}`,
          title: c.title,
          company: c.company,
          location: c.location,
          remote: /remote/i.test(c.location) ? true : null,
          salaryMin: null,
          salaryMax: null,
          descriptionText: description,
          applyUrl,
          postingUrl: c.url,
          postedAt: null,
          atsType: detectAts(applyUrl).ats,
        },
      );
    }
  } finally {
    await page.close().catch(() => undefined);
  }
  return jobs;
}

export const linkedin: SourceAdapter<BrowserBoardConfig> = {
  type: "linkedin",
  label: "LinkedIn search (discover only)",
  description:
    "Reads LinkedIn job search results in your signed-in browser. Never applies on LinkedIn. LinkedIn restricts automation, so this runs slowly with strict caps. Use at your own risk.",
  usesBrowser: true,
  configFields: [
    { key: "keywords", label: "Keywords", placeholder: "product manager fintech", required: true },
    { key: "location", label: "Location", placeholder: "United States" },
    { key: "maxDetailPages", label: "Max postings to open", placeholder: "10" },
    { key: "postedWithinDays", label: "Posted within days", placeholder: "7" },
  ],
  validate: commonValidate,
  discover: (cfg, ctx) => withBrowserLock(async () => ({ jobs: await linkedinDiscover(cfg, ctx) })),
};

/* ================================= Indeed ================================= */

async function indeedDiscover(cfg: BrowserBoardConfig, ctx: SourceContext): Promise<RawJob[]> {
  const context = await getContext({ headless: ctx.prefs.headlessBrowser });
  const page = await context.newPage();
  const jobs: RawJob[] = [];
  try {
    const cards = new Map<string, { title: string; company: string; location: string }>();
    for (let p = 0; p < cfg.maxResultPages; p++) {
      const q = new URLSearchParams({ q: cfg.keywords, fromage: String(cfg.postedWithinDays), start: String(p * 10) });
      if (cfg.location) q.set("l", cfg.location);
      ctx.progress(`Indeed search page ${p + 1}: ${cfg.keywords}`);
      await page.goto(`https://www.indeed.com/jobs?${q}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await pause();
      const blocked = await blockedReason(page);
      if (blocked) throw new Error(blocked);
      const found = await page.$$eval("[data-jk]", (els) =>
        els.map((el) => {
          const root = el.closest(".job_seen_beacon, .result, li") ?? el;
          const q = (sel: string) => (root.querySelector(sel)?.textContent ?? "").trim();
          return {
            jk: el.getAttribute("data-jk") ?? "",
            title: q("h2.jobTitle span[title]") || q("h2.jobTitle") || q("h2"),
            company: q('[data-testid="company-name"]') || q(".companyName"),
            location: q('[data-testid="text-location"]') || q(".companyLocation"),
          };
        }),
      );
      for (const f of found) if (f.jk && !cards.has(f.jk)) cards.set(f.jk, f);
      if (found.length < 10) break;
      await pause();
    }

    let details = 0;
    for (const [jk, c] of cards) {
      const url = `https://www.indeed.com/viewjob?jk=${jk}`;
      let description = "";
      let applyUrl = url;
      if (details < cfg.maxDetailPages) {
        details++;
        await pause(4000, 9000);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        const blocked = await blockedReason(page);
        if (blocked) {
          ctx.progress(`Stopping Indeed detail fetch: ${blocked}`);
          details = cfg.maxDetailPages;
        } else {
          description = await page.locator("#jobDescriptionText").innerText({ timeout: 8000 }).catch(() => "");
          applyUrl = (await externalApplyUrl(page)) ?? url;
        }
      }
      const viaAts = applyUrl !== url ? await fetchAtsJob(applyUrl, c.company) : null;
      jobs.push(
        viaAts ?? {
          externalId: `indeed:${jk}`,
          title: c.title,
          company: c.company,
          location: c.location,
          remote: /remote/i.test(c.location) ? true : null,
          salaryMin: null,
          salaryMax: null,
          descriptionText: description,
          applyUrl,
          postingUrl: url,
          postedAt: null,
          atsType: detectAts(applyUrl).ats,
        },
      );
    }
  } catch (err) {
    log.warn(`indeed discovery stopped: ${(err as Error).message}`);
    if (!jobs.length) throw err;
  } finally {
    await page.close().catch(() => undefined);
  }
  return jobs;
}

export const indeed: SourceAdapter<BrowserBoardConfig> = {
  type: "indeed",
  label: "Indeed search (discover only)",
  description:
    "Reads Indeed search results in your signed-in browser. Never applies on Indeed. Indeed restricts automation and shows verification checks, so this runs slowly with strict caps. Use at your own risk.",
  usesBrowser: true,
  configFields: linkedin.configFields,
  validate: commonValidate,
  discover: (cfg, ctx) => withBrowserLock(async () => ({ jobs: await indeedDiscover(cfg, ctx) })),
};
