import { updateConnection, type Db, type LlmConnection, type ModelInfo } from "@jh/db";
import { logger } from "@jh/shared";
import { findCatalogModel, getCatalog, providerSupport } from "./catalog";
import { effortInfo } from "./effort";
import { getSecret } from "./secrets";
import { getAccessToken } from "./oauth/flows";
import { CHATGPT_BASE_URL } from "./oauth/openai";

const log = logger("models");

interface LiveModel {
  id: string;
  name?: string;
  context?: number;
  efforts?: string[];
  defaultEffort?: string | null;
  thinking?: boolean;
}

export function connectionBaseUrl(conn: Pick<LlmConnection, "sdk" | "baseUrl" | "catalogProviderId">): string {
  if (conn.baseUrl) return conn.baseUrl.replace(/\/+$/, "");
  if (conn.sdk === "openai-chatgpt") return CHATGPT_BASE_URL;
  const p = conn.catalogProviderId ? getCatalog()[conn.catalogProviderId] : undefined;
  const s = p ? providerSupport(p) : null;
  const fallback: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
  };
  return (s?.baseUrl ?? fallback[conn.sdk] ?? "").replace(/\/+$/, "");
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j.error?.message ?? j.error_description ?? j.detail ?? j.message ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(`${res.status} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return JSON.parse(text);
}

const NON_CHAT = /(embed|embedding|whisper|tts|transcribe|audio|realtime|dall-e|image|imagen|moderation|search|aqa|veo|lyria|computer-use|davinci|babbage)/i;

async function fetchLive(db: Db, conn: LlmConnection): Promise<LiveModel[]> {
  const base = connectionBaseUrl(conn);
  switch (conn.sdk) {
    case "openai-chatgpt": {
      const token = await getAccessToken(db, conn.id);
      const headers = { authorization: `Bearer ${token}`, ...(conn.accountId ? { "chatgpt-account-id": conn.accountId } : {}), originator: "codex_cli_rs" };
      // The backend gates the list by client version: an outdated version gets only hidden internal
      // models. Try a recent Codex version first, then a far-future one, and keep the first
      // response that has selectable models.
      const versions = [process.env.JH_CODEX_CLIENT_VERSION, "0.154.0", "99.0.0"].filter((v): v is string => !!v);
      let list: any[] = [];
      for (const v of versions) {
        const j = await getJson(`${base}/models?client_version=${encodeURIComponent(v)}`, headers);
        list = (j.models ?? j.data ?? []).filter((m: any) => m.visibility !== "hide" && m.visibility !== "hidden");
        if (list.length) break;
      }
      return list
        .map((m) => ({
          id: m.slug ?? m.id,
          name: m.display_name ?? m.slug ?? m.id,
          context: m.context_window ?? undefined,
          efforts: (m.supported_reasoning_levels ?? m.supported_reasoning_efforts ?? []).map((l: any) => (typeof l === "string" ? l : l.effort)).filter(Boolean),
          defaultEffort: m.default_reasoning_level ?? m.default_reasoning_effort ?? null,
        }));
    }
    case "openai": {
      const key = await getSecret(conn.id, "api_key");
      const j = await getJson(`${base}/models`, { authorization: `Bearer ${key}` });
      return (j.data ?? []).map((m: any) => ({ id: m.id })).filter((m: LiveModel) => /^(gpt|o\d|chatgpt)/.test(m.id) && !NON_CHAT.test(m.id));
    }
    case "anthropic": {
      const key = await getSecret(conn.id, "api_key");
      const j = await getJson(`${base}/models?limit=1000`, { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" });
      return (j.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name }));
    }
    case "google": {
      const headers: Record<string, string> = {};
      let q = "pageSize=1000";
      if (conn.kind === "gemini-oauth") {
        headers.authorization = `Bearer ${await getAccessToken(db, conn.id)}`;
        if (conn.googleProject) headers["x-goog-user-project"] = conn.googleProject;
      } else {
        q += `&key=${encodeURIComponent((await getSecret(conn.id, "api_key")) ?? "")}`;
      }
      const j = await getJson(`${base}/models?${q}`, headers);
      return (j.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent") && !NON_CHAT.test(m.name))
        .map((m: any) => ({ id: String(m.name).replace(/^models\//, ""), name: m.displayName, context: m.inputTokenLimit, thinking: !!m.thinking }));
    }
    case "openai-compatible": {
      const key = await getSecret(conn.id, "api_key");
      const j = await getJson(`${base}/models`, key ? { authorization: `Bearer ${key}` } : {});
      const list: any[] = Array.isArray(j) ? j : (j.data ?? j.models ?? []);
      return list.map((m) => ({ id: m.id ?? m.name, name: m.name && m.name !== m.id ? m.name : undefined, context: m.context_length ?? m.context_window })).filter((m) => m.id && !NON_CHAT.test(m.id));
    }
    default:
      return [];
  }
}

export function toModelInfo(conn: Pick<LlmConnection, "sdk" | "catalogProviderId">, m: LiveModel, source: ModelInfo["source"]): ModelInfo {
  const meta = findCatalogModel(conn.catalogProviderId, m.id);
  let effort = effortInfo(conn.sdk, m.id, meta);
  if (m.efforts?.length) {
    const d = m.defaultEffort && m.efforts.includes(m.defaultEffort) ? m.defaultEffort : effort.defaultEffort && m.efforts.includes(effort.defaultEffort) ? effort.defaultEffort : m.efforts[0]!;
    effort = { effortKind: "effort", efforts: m.efforts, defaultEffort: d };
  } else if (m.thinking && effort.effortKind === "none") {
    effort = effortInfo(conn.sdk, m.id, { id: m.id, name: m.id, reasoning: true });
  }
  return {
    id: m.id,
    name: m.name ?? meta?.name ?? m.id,
    contextWindow: m.context ?? meta?.context ?? null,
    reasoning: effort.effortKind !== "none",
    ...effort,
    costIn: meta?.cost?.input ?? null,
    costOut: meta?.cost?.output ?? null,
    costCachedIn: meta?.cost?.cache_read ?? null,
    source,
  };
}

function catalogModels(conn: LlmConnection): ModelInfo[] {
  const pid = conn.catalogProviderId ?? (conn.sdk === "openai-chatgpt" ? "openai" : null);
  const models = pid ? Object.values(getCatalog()[pid]?.models ?? {}) : [];
  const filtered = (conn.sdk === "openai-chatgpt" ? models.filter((m) => m.reasoning && /^gpt-/.test(m.id)) : models).filter((m) => !NON_CHAT.test(m.id));
  return filtered.map((m) => toModelInfo(conn, { id: m.id, name: m.name, context: m.context }, "catalog"));
}

function sortModels(list: ModelInfo[], conn: LlmConnection): ModelInfo[] {
  const release = (id: string) => findCatalogModel(conn.catalogProviderId, id)?.release_date ?? "";
  return [...list].sort((a, b) => release(b.id).localeCompare(release(a.id)) || a.name.localeCompare(b.name));
}

/**
 * Fetch the connection's available models from the provider, enrich them with catalog metadata,
 * and cache the result on the connection. Falls back to the catalog when the live list fails.
 */
export async function refreshModels(db: Db, conn: LlmConnection): Promise<{ models: ModelInfo[]; error: string | null }> {
  if (conn.sdk === "env") return { models: [], error: null };
  try {
    const live = await fetchLive(db, conn);
    const seen = new Set<string>();
    const models = sortModels(
      live.filter((m) => !seen.has(m.id) && seen.add(m.id)).map((m) => toModelInfo(conn, m, "live")),
      conn,
    );
    if (!models.length) throw new Error("The provider returned no chat models");
    updateConnection(db, conn.id, { modelsCache: models, modelsFetchedAt: new Date().toISOString(), modelsError: null });
    return { models, error: null };
  } catch (err) {
    const error = (err as Error).message;
    log.warn(`model list failed for ${conn.label}: ${error}`);
    const models = sortModels(catalogModels(conn), conn);
    updateConnection(db, conn.id, { modelsCache: models, modelsFetchedAt: new Date().toISOString(), modelsError: error });
    return { models, error };
  }
}
