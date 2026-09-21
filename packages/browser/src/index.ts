import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { dataPath, logger } from "@prowl/shared";

const log = logger("browser");

/**
 * One persistent browser profile for everything that acts as the user on the web:
 * LinkedIn/Indeed discovery and the applier. It keeps logins (cookies) between runs and
 * runs on the user's own machine and residential IP. Only one process may open it at a time,
 * so only the worker uses this module.
 */

export interface SessionOptions {
  headless?: boolean;
}

let contextPromise: Promise<BrowserContext> | undefined;
let currentHeadless: boolean | undefined;

export function profileDir(): string {
  const dir = dataPath("browser-profile", ".keep").replace(/[\\/]\.keep$/, "");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function launch(headless: boolean): Promise<BrowserContext> {
  const channel = process.env.PROWL_BROWSER_CHANNEL === "chromium" ? undefined : "chrome";
  const base = {
    headless,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    acceptDownloads: true,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    return await chromium.launchPersistentContext(profileDir(), { ...base, channel });
  } catch (err) {
    if (channel) {
      log.warn(`Google Chrome not available (${(err as Error).message.split("\n")[0]}); using bundled Chromium`);
      return chromium.launchPersistentContext(profileDir(), base);
    }
    throw err;
  }
}

/** Get (or start) the shared browser context. Restarts it when headless mode changes. */
export async function getContext(opts: SessionOptions = {}): Promise<BrowserContext> {
  const headless = opts.headless ?? false;
  if (contextPromise && currentHeadless !== headless) await closeContext();
  if (!contextPromise) {
    currentHeadless = headless;
    contextPromise = launch(headless).then((ctx) => {
      ctx.on("close", () => {
        contextPromise = undefined;
      });
      return ctx;
    });
    contextPromise.catch(() => (contextPromise = undefined));
  }
  return contextPromise;
}

export async function closeContext(): Promise<void> {
  const p = contextPromise;
  contextPromise = undefined;
  if (p) await (await p.catch(() => undefined))?.close().catch(() => undefined);
}

export async function newPage(opts: SessionOptions = {}): Promise<Page> {
  const ctx = await getContext(opts);
  return ctx.newPage();
}

/** Serialize browser work so discovery and applications never drive the profile at the same time. */
let chain: Promise<unknown> = Promise.resolve();
export function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Open a visible window on the given sites so the user can sign in once. */
export async function openForLogin(urls: string[]): Promise<void> {
  const ctx = await getContext({ headless: false });
  for (const url of urls) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => log.warn(`could not open ${url}: ${e.message}`));
  }
}

export type { BrowserContext, Page };
