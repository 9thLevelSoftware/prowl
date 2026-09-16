import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { getActiveConnection, type Db, type EffortKind, type LlmConnection, type ModelInfo } from "@jh/db";
import { findCatalogModel } from "./catalog";
import { AUTO_EFFORT, effortForTask, effortInfo, pickEffort, providerOptionsFor } from "./effort";
import { connectionBaseUrl, toModelInfo } from "./models";
import { getSecret } from "./secrets";
import { getAccessToken } from "./oauth/flows";
import { createModel as createLegacyModel, resolveProviderConfig } from "./providers";
import type { Tier } from "./providers";

export interface ResolvedSelection {
  model: string;
  effort: string | null;
  effortKind: EffortKind;
  info: ModelInfo | null;
}

export interface Runtime {
  connection: LlmConnection;
  main: ResolvedSelection;
  fast: ResolvedSelection;
}

export function resolveSelection(conn: LlmConnection, slot: "main" | "fast"): ResolvedSelection {
  if (conn.sdk === "env") {
    const legacy = resolveProviderConfig();
    return { model: slot === "main" ? legacy.smartModel : legacy.fastModel, effort: null, effortKind: "none", info: null };
  }
  const cache = conn.modelsCache ?? [];
  const chosen = conn.selections[slot] ?? (slot === "fast" ? conn.selections.main : null);
  const modelId = chosen?.model ?? cache[0]?.id;
  if (!modelId) throw new Error(`Choose a model for "${conn.label}" on the Settings page`);
  const info = cache.find((m) => m.id === modelId) ?? toModelInfo(conn, { id: modelId }, "catalog");
  // Automatic (per task) unless the user picked a specific level this model supports.
  const effort = chosen?.effort && chosen.effort !== AUTO_EFFORT && info.efforts.includes(chosen.effort) ? chosen.effort : AUTO_EFFORT;
  return { model: modelId, effort: info.efforts.length ? effort : null, effortKind: info.effortKind, info };
}

export function resolveRuntime(db: Db): Runtime | null {
  const conn = getActiveConnection(db);
  if (!conn) return null;
  return { connection: conn, main: resolveSelection(conn, "main"), fast: resolveSelection(conn, "fast") };
}

type FetchLike = typeof globalThis.fetch;

/** Bearer-token fetch for OAuth connections: refreshes when near expiry and retries once on 401. */
function oauthFetch(db: Db, conn: LlmConnection, mutate?: (headers: Headers, body: unknown) => unknown): FetchLike {
  const go = async (input: Parameters<FetchLike>[0], init: RequestInit | undefined, force: boolean) => {
    const token = await getAccessToken(db, conn.id, { force });
    const headers = new Headers(init?.headers);
    headers.delete("x-goog-api-key");
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${token}`);
    const body = mutate ? (mutate(headers, init?.body) ?? init?.body) : init?.body;
    return globalThis.fetch(input, { ...init, headers, body: body as BodyInit | null | undefined });
  };
  return (async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
    const res = await go(input, init, false);
    return res.status === 401 ? go(input, init, true) : res;
  }) as FetchLike;
}

/**
 * The ChatGPT backend speaks the Responses API but requires `store: false`, `stream: true`,
 * top-level `instructions`, and takes reasoning effort as `reasoning.effort`.
 */
export function chatgptBodyRewrite(body: unknown, effort: string | null): string | undefined {
  if (typeof body !== "string") return undefined;
  let j: Record<string, any>;
  try {
    j = JSON.parse(body);
  } catch {
    return undefined;
  }
  const input: any[] = Array.isArray(j.input) ? j.input : [];
  const sys = input.filter((m) => m?.role === "system" || m?.role === "developer");
  if (sys.length) {
    const text = sys.map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("\n"))).join("\n\n");
    j.instructions = [j.instructions, text].filter(Boolean).join("\n\n");
    j.input = input.filter((m) => !sys.includes(m));
  }
  j.instructions ??= "You are a helpful assistant.";
  j.store = false;
  j.stream = true;
  if (effort) j.reasoning = { ...(j.reasoning ?? {}), effort, summary: j.reasoning?.summary ?? "auto" };
  delete j.max_output_tokens;
  delete j.temperature;
  return JSON.stringify(j);
}

/**
 * The ChatGPT backend only streams, and its final `response.completed` event arrives with an empty
 * `output` array: the actual output items come earlier as `response.output_item.done` events.
 * Rebuild a complete, non-streaming Responses API body from the stream.
 */
export async function collapseChatgptStream(res: Response): Promise<Response> {
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || type.includes("application/json")) return res;
  const text = await res.text();
  const items: unknown[] = [];
  let final: Record<string, any> | null = null;
  let failure: Record<string, any> | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (e.type === "response.output_item.done" && e.item) items.push(e.item);
    else if (e.type === "response.completed" || e.type === "response.incomplete") final = e.response;
    else if (e.type === "response.failed") failure = e.response?.error ?? { message: "The response failed" };
    else if (e.type === "error") failure = e.error ?? e;
  }
  if (failure || !final) {
    const message = failure?.message ?? (final ? "Unknown error" : "The ChatGPT stream ended without a completed response");
    return new Response(JSON.stringify({ error: { message, type: failure?.type ?? "server_error", code: failure?.code ?? null } }), {
      status: failure?.code === "rate_limit_exceeded" ? 429 : 500,
      headers: { "content-type": "application/json" },
    });
  }
  const body = { ...final, output: Array.isArray(final.output) && final.output.length ? final.output : items };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

export interface BuiltModel {
  model: LanguageModel;
  providerOptions: Record<string, Record<string, unknown>> | undefined;
  modelId: string;
  info: ModelInfo | null;
  streaming: boolean;
  /** The effort actually sent for this call (Automatic resolved to a concrete level). */
  effort: string | null;
}

/** Resolve "auto" to a concrete level for this task and model. */
export function effectiveEffort(sel: ResolvedSelection, task: string): string | null {
  if (sel.effort !== AUTO_EFFORT) return sel.effort;
  return pickEffort(sel.info?.efforts ?? [], effortForTask(task));
}

export async function buildModel(db: Db, conn: LlmConnection, sel: ResolvedSelection, tier: Tier, task = ""): Promise<BuiltModel> {
  const base = connectionBaseUrl(conn);
  const effort = effectiveEffort(sel, task);
  const po = providerOptionsFor(conn.sdk, sel.effortKind, effort);
  const out = (model: LanguageModel, streaming = false): BuiltModel => ({ model, providerOptions: po, modelId: sel.model, info: sel.info, streaming, effort });

  switch (conn.sdk) {
    case "env": {
      // Legacy configuration from .env (JH_LLM_PROVIDER and friends).
      const legacy = resolveProviderConfig();
      return out(createLegacyModel(legacy, tier), legacy.provider === "chatgpt-oauth");
    }
    case "openai":
      return out(createOpenAI({ apiKey: (await getSecret(conn.id, "api_key")) ?? "", baseURL: base }).responses(sel.model));
    case "openai-chatgpt": {
      const authed = oauthFetch(db, conn, (headers, body) => {
        if (conn.accountId) headers.set("chatgpt-account-id", conn.accountId);
        headers.set("OpenAI-Beta", "responses=experimental");
        headers.set("originator", "codex_cli_rs");
        return chatgptBodyRewrite(body, effort);
      });
      // The SDK sends non-streaming requests; the backend always streams. Collapse the stream back
      // into a regular Responses API body so the SDK's standard (non-streaming) parsing is used.
      const provider = createOpenAI({ apiKey: "oauth", baseURL: base, fetch: (async (input, init) => collapseChatgptStream(await authed(input, init))) as FetchLike });
      return out(provider.responses(sel.model), false);
    }
    case "anthropic":
      return out(createAnthropic({ apiKey: (await getSecret(conn.id, "api_key")) ?? "", baseURL: base })(sel.model));
    case "google":
      if (conn.kind === "gemini-oauth") {
        const provider = createGoogleGenerativeAI({
          apiKey: "oauth",
          baseURL: base,
          fetch: oauthFetch(db, conn, (headers) => {
            if (conn.googleProject) headers.set("x-goog-user-project", conn.googleProject);
            return undefined;
          }),
        });
        return out(provider(sel.model));
      }
      return out(createGoogleGenerativeAI({ apiKey: (await getSecret(conn.id, "api_key")) ?? "", baseURL: base })(sel.model));
    case "openai-compatible": {
      const apiKey = await getSecret(conn.id, "api_key");
      const provider = createOpenAICompatible({ name: "compatible", baseURL: base, apiKey: apiKey ?? undefined });
      return out(provider(sel.model));
    }
  }
}

/** Effort metadata for a model id without a live list (used by tests and the legacy path). */
export function describeModel(conn: Pick<LlmConnection, "sdk" | "catalogProviderId">, modelId: string) {
  return effortInfo(conn.sdk, modelId, findCatalogModel(conn.catalogProviderId, modelId));
}
