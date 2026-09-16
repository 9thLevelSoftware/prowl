import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, dataPath, logger } from "@jh/shared";
import type { ConnectionSdk } from "@jh/db";

const log = logger("catalog");

/*
 * Provider and model catalog from models.dev: base URLs, model ids, context sizes, prices, and
 * reasoning/effort options for 200+ providers. A cached copy is refreshed daily; the bundled
 * snapshot (packages/llm/catalog-snapshot.json.gz) is used offline.
 */

export interface CatalogModel {
  id: string;
  name: string;
  reasoning?: boolean;
  reasoning_options?: { type: "effort" | "toggle" | "budget_tokens"; values?: string[] }[];
  context?: number;
  cost?: { input?: number; output?: number; cache_read?: number };
  tool_call?: boolean;
  release_date?: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  api?: string;
  env?: string[];
  npm?: string;
  doc?: string;
  models: Record<string, CatalogModel>;
}

export type Catalog = Record<string, CatalogProvider>;

const SOURCE_URL = "https://models.dev/api.json";
const MAX_AGE_MS = 24 * 3600_000;

let memory: { catalog: Catalog; loadedAt: number } | undefined;
let refreshing: Promise<void> | undefined;

function snapshotPath(): string {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog-snapshot.json.gz");
    if (fs.existsSync(p)) return p;
  } catch {
    /* bundled contexts */
  }
  return path.join(REPO_ROOT, "packages", "llm", "catalog-snapshot.json.gz");
}

const cachePath = () => dataPath("catalog", "models-dev.json");

export function trimCatalog(j: Record<string, any>): Catalog {
  const out: Catalog = {};
  for (const [id, p] of Object.entries(j)) {
    out[id] = { id, name: p.name, api: p.api, env: p.env, npm: p.npm, doc: p.doc, models: {} };
    for (const [mid, m] of Object.entries<any>(p.models ?? {})) {
      out[id]!.models[mid] = {
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        reasoning_options: m.reasoning_options,
        context: m.limit?.context ?? m.context,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output, cache_read: m.cost.cache_read } : undefined,
        tool_call: m.tool_call,
        release_date: m.release_date,
      };
    }
  }
  return out;
}

function readSnapshot(): Catalog {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(snapshotPath())).toString("utf8")) as Catalog;
}

async function refreshCache(): Promise<void> {
  const ctrl = AbortSignal.timeout(20_000);
  const res = await fetch(SOURCE_URL, { signal: ctrl });
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
  const catalog = trimCatalog((await res.json()) as Record<string, unknown>);
  fs.writeFileSync(cachePath(), JSON.stringify(catalog));
  memory = { catalog, loadedAt: Date.now() };
  log.info(`catalog refreshed: ${Object.keys(catalog).length} providers`);
}

/** Load the catalog. Never throws: falls back to the cache, then to the bundled snapshot. */
export function getCatalog(): Catalog {
  if (memory && Date.now() - memory.loadedAt < MAX_AGE_MS) return memory.catalog;
  let catalog: Catalog | undefined;
  let fresh = false;
  try {
    const stat = fs.statSync(cachePath());
    catalog = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as Catalog;
    fresh = Date.now() - stat.mtimeMs < MAX_AGE_MS;
  } catch {
    catalog = undefined;
  }
  catalog ??= readSnapshot();
  memory = { catalog, loadedAt: fresh ? Date.now() : 0 };
  if (!fresh && process.env.JH_CATALOG_OFFLINE !== "1") {
    refreshing ??= refreshCache()
      .catch((err) => log.warn(`catalog refresh failed, using cached copy: ${(err as Error).message}`))
      .finally(() => (refreshing = undefined));
  }
  return catalog;
}

/* =========================== Provider support ============================ */

/** Providers whose dedicated AI SDK package speaks an OpenAI-compatible API at a known URL. */
const COMPATIBLE_BASE_URLS: Record<string, string> = {
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
  "@openrouter/ai-sdk-provider": "https://openrouter.ai/api/v1",
};

export interface ProviderSupport {
  supported: boolean;
  sdk: ConnectionSdk;
  baseUrl: string | null;
  reason?: string;
}

export function providerSupport(p: Pick<CatalogProvider, "id" | "npm" | "api">): ProviderSupport {
  switch (p.npm) {
    case "@ai-sdk/openai":
      return { supported: true, sdk: "openai", baseUrl: p.api ?? "https://api.openai.com/v1" };
    case "@ai-sdk/anthropic":
      return { supported: true, sdk: "anthropic", baseUrl: p.api ?? "https://api.anthropic.com/v1" };
    case "@ai-sdk/google":
      return { supported: true, sdk: "google", baseUrl: p.api ?? "https://generativelanguage.googleapis.com/v1beta" };
    case "@ai-sdk/openai-compatible":
      return p.api
        ? { supported: true, sdk: "openai-compatible", baseUrl: p.api }
        : { supported: false, sdk: "openai-compatible", baseUrl: null, reason: "No API address listed" };
  }
  const known = p.npm ? COMPATIBLE_BASE_URLS[p.npm] : undefined;
  if (known || p.api) return { supported: true, sdk: "openai-compatible", baseUrl: p.api ?? known! };
  return { supported: false, sdk: "openai-compatible", baseUrl: null, reason: "Needs cloud-specific sign-in (not supported yet)" };
}

export interface ProviderSummary {
  id: string;
  name: string;
  modelCount: number;
  supported: boolean;
  reason?: string;
  sdk: ConnectionSdk;
  baseUrl: string | null;
  keyHint: string | null;
  doc: string | null;
  local: boolean;
}

export function listProviders(): ProviderSummary[] {
  return Object.values(getCatalog())
    .map((p) => {
      const s = providerSupport(p);
      return {
        id: p.id,
        name: p.name,
        modelCount: Object.keys(p.models).length,
        supported: s.supported,
        reason: s.reason,
        sdk: s.sdk,
        baseUrl: s.baseUrl,
        keyHint: p.env?.find((e) => /KEY|TOKEN/.test(e)) ?? p.env?.[0] ?? null,
        doc: p.doc ?? null,
        local: !!s.baseUrl && /localhost|127\.0\.0\.1/.test(s.baseUrl),
      };
    })
    .sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name));
}

/** Find model metadata by id, tolerating "models/" and "provider/" prefixes. */
export function findCatalogModel(providerId: string | null | undefined, modelId: string): CatalogModel | undefined {
  const catalog = getCatalog();
  const bare = modelId.replace(/^models\//, "");
  const tail = bare.includes("/") ? bare.split("/").pop()! : bare;
  if (providerId) {
    const models = catalog[providerId]?.models ?? {};
    const hit = models[modelId] ?? models[bare] ?? models[tail];
    if (hit) return hit;
  }
  // Fall back to the first-party catalogs, which carry the best reasoning metadata.
  for (const pid of ["openai", "anthropic", "google"]) {
    const hit = catalog[pid]?.models[tail];
    if (hit) return hit;
  }
  return undefined;
}
