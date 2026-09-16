import { getSetting, type Db } from "@jh/db";
import { getSecret } from "@jh/llm";
import { logger } from "@jh/shared";

const log = logger("firecrawl");

/*
 * Client for Firecrawl (self-hosted or cloud). Self-hosted servers expose /v1 or /v2 routes and
 * usually run without an API key. Search only works when the server has a search backend
 * configured (for example SearXNG), so capabilities are probed rather than assumed.
 */

export const FIRECRAWL_SETTINGS_KEY = "webtools.firecrawl";
export const FIRECRAWL_SECRET_ID = "webtools-firecrawl";

export interface FirecrawlSettings {
  enabled: boolean;
  baseUrl: string;
  hasApiKey: boolean;
}

export interface FirecrawlCapabilities {
  reachable: boolean;
  version: "v2" | "v1" | null;
  scrape: boolean;
  map: boolean;
  search: boolean;
  error: string | null;
}

export function firecrawlSettings(db: Db): FirecrawlSettings {
  return getSetting<FirecrawlSettings>(db, FIRECRAWL_SETTINGS_KEY, { enabled: false, baseUrl: "http://localhost:3002", hasApiKey: false });
}

export class Firecrawl {
  private version: "v2" | "v1" | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string | null,
  ) {}

  static async fromSettings(db: Db): Promise<Firecrawl | null> {
    const s = firecrawlSettings(db);
    if (!s.enabled || !s.baseUrl) return null;
    const key = s.hasApiKey ? await getSecret(FIRECRAWL_SECRET_ID, "api_key") : null;
    return new Firecrawl(s.baseUrl.replace(/\/+$/, ""), key);
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<{ status: number; json: T | null }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, json };
  }

  /** Prefer v2, fall back to v1, remembered after the first successful call. */
  private async call<T extends { success?: boolean; error?: string }>(endpoint: string, body: unknown, timeoutMs?: number): Promise<T> {
    const order: ("v2" | "v1")[] = this.version ? [this.version] : ["v2", "v1"];
    let lastError = "";
    for (const v of order) {
      const { status, json } = await this.post<T>(`/${v}/${endpoint}`, body, timeoutMs);
      if (status === 404) {
        lastError = `/${v}/${endpoint} not found`;
        continue;
      }
      if (status >= 400 || !json || json.success === false) {
        throw new Error(`Firecrawl ${endpoint} failed (${status}): ${json?.error ?? "no response"}`);
      }
      this.version = v;
      return json;
    }
    throw new Error(`Firecrawl ${endpoint} unavailable: ${lastError}`);
  }

  async scrape(url: string, formats: ("rawHtml" | "markdown" | "links")[] = ["rawHtml", "links"]): Promise<{ rawHtml: string; markdown: string; links: string[] }> {
    const j = await this.call<{ success?: boolean; error?: string; data?: { rawHtml?: string; markdown?: string; links?: string[] } }>("scrape", { url, formats, onlyMainContent: false, timeout: 45_000 }, 60_000);
    return { rawHtml: j.data?.rawHtml ?? "", markdown: j.data?.markdown ?? "", links: j.data?.links ?? [] };
  }

  async map(url: string, search?: string): Promise<string[]> {
    const j = await this.call<{ success?: boolean; error?: string; links?: (string | { url: string })[] }>("map", { url, search, limit: 500 }, 60_000);
    return (j.links ?? []).map((l) => (typeof l === "string" ? l : l.url)).filter(Boolean);
  }

  async search(query: string, limit = 10): Promise<{ url: string; title: string; description: string }[]> {
    const j = await this.call<{ success?: boolean; error?: string; data?: any }>("search", { query, limit }, 90_000);
    // v2 returns { data: { web: [...] } }, v1 returns { data: [...] }.
    const list: any[] = Array.isArray(j.data) ? j.data : (j.data?.web ?? []);
    return list.map((r) => ({ url: r.url, title: r.title ?? "", description: r.description ?? "" })).filter((r) => r.url);
  }

  async capabilities(): Promise<FirecrawlCapabilities> {
    const caps: FirecrawlCapabilities = { reachable: false, version: null, scrape: false, map: false, search: false, error: null };
    try {
      await this.scrape("https://example.com", ["markdown"]);
      caps.reachable = true;
      caps.scrape = true;
    } catch (err) {
      caps.error = (err as Error).message;
      caps.reachable = !/fetch failed|ECONNREFUSED|abort|timed out/i.test(caps.error);
      if (!caps.reachable) return caps;
    }
    caps.version = this.version;
    try {
      caps.map = (await this.map("https://example.com")).length >= 0;
    } catch (err) {
      log.debug(`map unavailable: ${(err as Error).message}`);
    }
    try {
      caps.search = (await this.search("careers", 1)).length > 0;
    } catch (err) {
      log.debug(`search unavailable: ${(err as Error).message}`);
    }
    return caps;
  }
}
