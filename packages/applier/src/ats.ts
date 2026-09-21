import type { Page } from "playwright";
import type { AtsType } from "@prowl/shared";
import { sleep } from "@prowl/shared";
import { formFrames } from "./extract";

export interface AtsHooks {
  type: AtsType;
  /** Normalize a posting URL to the page that carries the application form. */
  applyUrl(url: string): string;
  /** Reveal the form (click "Apply", switch tabs, dismiss banners). */
  prepare(page: Page): Promise<void>;
  submit(page: Page): Promise<void>;
  /** Return confirmation text when the page shows a successful submission. */
  confirmation(page: Page): Promise<string | null>;
}

async function clickIfVisible(page: Page, names: RegExp[], timeout = 1500): Promise<boolean> {
  for (const frame of formFrames(page)) {
    for (const name of names) {
      const btn = frame.getByRole("button", { name }).or(frame.getByRole("link", { name })).first();
      if (await btn.isVisible({ timeout }).catch(() => false)) {
        await btn.click().catch(() => undefined);
        await sleep(1200);
        return true;
      }
    }
  }
  return false;
}

async function dismissCookieBanners(page: Page): Promise<void> {
  await clickIfVisible(page, [/^(reject all|deny|decline|only necessary|necessary only)$/i], 800);
}

const SUCCESS_TEXT =
  /(thank you for (applying|your application|your interest)|thanks for applying|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application|your application has been sent)/i;

async function genericConfirmation(page: Page, urlPattern?: RegExp): Promise<string | null> {
  if (urlPattern?.test(page.url())) {
    const t = await page.locator("body").innerText().catch(() => "");
    return t.slice(0, 1500) || page.url();
  }
  for (const frame of formFrames(page)) {
    const t = await frame.locator("body").innerText().catch(() => "");
    const m = t.match(SUCCESS_TEXT);
    if (m) {
      const i = Math.max(0, (m.index ?? 0) - 200);
      return t.slice(i, i + 800);
    }
  }
  return null;
}

async function clickSubmit(page: Page, names: RegExp[]): Promise<void> {
  for (const frame of formFrames(page)) {
    for (const name of names) {
      const btn = frame.getByRole("button", { name }).last();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => undefined);
        await btn.click();
        return;
      }
    }
    const typed = frame.locator("button[type=submit], input[type=submit]").last();
    if (await typed.isVisible({ timeout: 1000 }).catch(() => false)) {
      await typed.click();
      return;
    }
  }
  throw new Error("Could not find the submit button");
}

const SUBMIT_NAMES = [/^submit application$/i, /^submit$/i, /^apply$/i, /^send application$/i, /submit/i];

export const greenhouseHooks: AtsHooks = {
  type: "greenhouse",
  applyUrl(url) {
    const u = new URL(url);
    if (u.pathname.includes("/embed/job_app")) return url;
    const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    const jid = u.searchParams.get("gh_jid");
    if (m) return `https://job-boards.greenhouse.io/embed/job_app?for=${m[1]}&token=${m[2]}`;
    if (jid && u.searchParams.get("for")) return `https://job-boards.greenhouse.io/embed/job_app?for=${u.searchParams.get("for")}&token=${jid}`;
    return url;
  },
  async prepare(page) {
    await dismissCookieBanners(page);
    if (!(await page.locator("#first_name, #email").first().isVisible({ timeout: 3000 }).catch(() => false))) {
      await clickIfVisible(page, [/^apply( for this job| now)?$/i]);
    }
  },
  submit: (page) => clickSubmit(page, SUBMIT_NAMES),
  confirmation: (page) => genericConfirmation(page, /\/confirmation|application_confirmation/),
};

export const leverHooks: AtsHooks = {
  type: "lever",
  applyUrl(url) {
    const u = new URL(url);
    return u.pathname.endsWith("/apply") ? url : `${u.origin}${u.pathname.replace(/\/+$/, "")}/apply`;
  },
  async prepare(page) {
    await dismissCookieBanners(page);
  },
  submit: (page) => clickSubmit(page, SUBMIT_NAMES),
  confirmation: (page) => genericConfirmation(page, /\/thanks(\/|$|\?)/),
};

export const ashbyHooks: AtsHooks = {
  type: "ashby",
  applyUrl(url) {
    const u = new URL(url);
    return u.pathname.endsWith("/application") ? url : `${u.origin}${u.pathname.replace(/\/+$/, "")}/application`;
  },
  async prepare(page) {
    await dismissCookieBanners(page);
    if (!(await page.locator("#_systemfield_name, #_systemfield_email").first().isVisible({ timeout: 3000 }).catch(() => false))) {
      await clickIfVisible(page, [/^application$/i, /^apply( for this job)?$/i]);
    }
  },
  submit: (page) => clickSubmit(page, [/^submit application$/i, ...SUBMIT_NAMES]),
  confirmation: (page) => genericConfirmation(page),
};

/** Unknown forms: best-effort generic behavior. Always pauses for the user before submitting. */
export const genericHooks: AtsHooks = {
  type: "other",
  applyUrl: (url) => url,
  async prepare(page) {
    await dismissCookieBanners(page);
    await clickIfVisible(page, [/^apply( now| for this (job|position|role))?$/i, /^start application$/i]);
  },
  submit: (page) => clickSubmit(page, SUBMIT_NAMES),
  confirmation: (page) => genericConfirmation(page),
};

export function hooksFor(ats: AtsType): AtsHooks {
  switch (ats) {
    case "greenhouse":
      return greenhouseHooks;
    case "lever":
      return leverHooks;
    case "ashby":
      return ashbyHooks;
    default:
      return genericHooks;
  }
}

/** A human verification challenge is visible (not the invisible score-based kind). */
export async function captchaChallengeVisible(page: Page): Promise<boolean> {
  const sel = [
    'iframe[src*="hcaptcha.com"][src*="challenge"]',
    'iframe[title*="challenge" i][src*="recaptcha"]',
    'iframe[src*="recaptcha/api2/bframe"]',
    'iframe[src*="challenges.cloudflare.com"]',
    "#challenge-running",
  ].join(", ");
  const frames = page.locator(sel);
  const n = await frames.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const box = await frames.nth(i).boundingBox().catch(() => null);
    if (box && box.width > 50 && box.height > 50) return true;
  }
  return false;
}

/** Visible validation messages after an attempted submit. */
export async function validationErrors(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const frame of formFrames(page)) {
    const texts = await frame
      .locator('[role=alert], [aria-invalid=true] ~ *, .error, .error-message, [class*="error" i]:not(input):not(form):not(body)')
      .allInnerTexts()
      .catch(() => [] as string[]);
    for (const t of texts) {
      const s = t.replace(/\s+/g, " ").trim();
      if (s && s.length < 300 && /(required|invalid|please|must|error|can't be blank|cannot be blank)/i.test(s)) out.push(s);
    }
  }
  return [...new Set(out)].slice(0, 20);
}
