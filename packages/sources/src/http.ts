import robotsParser from "robots-parser";
import { sleep } from "@jh/shared";

export const USER_AGENT = "JobHunterPersonal/0.1 (personal job search assistant; single user)";

const lastHit = new Map<string, number>();
const robotsCache = new Map<string, Promise<ReturnType<typeof robotsParser> | null>>();

/** Polite fetch: one request per second per host, retries on 429/5xx, timeout. */
export async function politeFetch(url: string, init: RequestInit & { minIntervalMs?: number; timeoutMs?: number } = {}): Promise<Response> {
  const host = new URL(url).host;
  const minInterval = init.minIntervalMs ?? 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = (lastHit.get(host) ?? 0) + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, {
        ...init,
        signal: init.signal ?? ctrl.signal,
        headers: { "user-agent": USER_AGENT, accept: "application/json, text/html;q=0.9, */*;q=0.8", ...(init.headers ?? {}) },
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
        await sleep(retryAfter * 1000);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(2 ** attempt * 1000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Request failed after retries: ${url}`);
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await politeFetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export async function robotsAllowed(url: string): Promise<boolean> {
  const u = new URL(url);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  if (!robotsCache.has(robotsUrl)) {
    robotsCache.set(
      robotsUrl,
      politeFetch(robotsUrl, { timeoutMs: 10_000 })
        .then(async (r) => (r.ok ? robotsParser(robotsUrl, await r.text()) : null))
        .catch(() => null),
    );
  }
  const robots = await robotsCache.get(robotsUrl)!;
  return robots ? robots.isAllowed(url, USER_AGENT) !== false : true;
}
