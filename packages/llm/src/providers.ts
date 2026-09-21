import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { bearerFetch } from "./auth";

export const PROVIDERS = ["gemini-oauth", "chatgpt-oauth", "gemini", "openai", "anthropic"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type Tier = "smart" | "fast";

export interface ProviderConfig {
  provider: ProviderId;
  smartModel: string;
  fastModel: string;
  baseURL?: string;
  googleProject?: string;
  /** Max concurrent requests. Subscription OAuth plans have tight rate limits. */
  concurrency: number;
  /** True when billing is a flat subscription, so per-token cost is not tracked. */
  subscription: boolean;
}

const DEFAULT_MODELS: Record<ProviderId, { smart: string; fast: string }> = {
  "gemini-oauth": { smart: "gemini-2.5-pro", fast: "gemini-2.5-flash" },
  gemini: { smart: "gemini-2.5-pro", fast: "gemini-2.5-flash" },
  "chatgpt-oauth": { smart: "gpt-5", fast: "gpt-5" },
  openai: { smart: "gpt-5", fast: "gpt-5-mini" },
  anthropic: { smart: "claude-opus-5", fast: "claude-sonnet-5" },
};

export function isProviderId(v: string): v is ProviderId {
  return (PROVIDERS as readonly string[]).includes(v);
}

/** Resolve provider config from env with optional overrides (e.g. from the Settings page). */
export function resolveProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const envProvider = process.env.PROWL_LLM_PROVIDER ?? "gemini-oauth";
  const provider = overrides.provider ?? (isProviderId(envProvider) ? envProvider : "gemini-oauth");
  const defaults = DEFAULT_MODELS[provider];
  const oauth = provider.endsWith("-oauth");
  return {
    provider,
    smartModel: overrides.smartModel || process.env.PROWL_MODEL_SMART || defaults.smart,
    fastModel: overrides.fastModel || process.env.PROWL_MODEL_FAST || defaults.fast,
    baseURL: overrides.baseURL || process.env.PROWL_LLM_BASE_URL || undefined,
    googleProject: overrides.googleProject || process.env.PROWL_GOOGLE_PROJECT || undefined,
    concurrency: overrides.concurrency ?? (oauth ? 2 : 4),
    subscription: oauth,
  };
}

/**
 * The ChatGPT subscription backend speaks the Responses API but requires `store: false`,
 * `stream: true`, and top-level `instructions`. Rewrite AI SDK request bodies to match.
 */
function chatgptBodyRewrite(body: unknown): string | undefined {
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
    const text = sys
      .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("\n")))
      .join("\n\n");
    j.instructions = [j.instructions, text].filter(Boolean).join("\n\n");
    j.input = input.filter((m) => !sys.includes(m));
  }
  j.instructions ??= "You are a helpful assistant.";
  j.store = false;
  j.stream = true;
  delete j.max_output_tokens;
  return JSON.stringify(j);
}

export function createModel(cfg: ProviderConfig, tier: Tier): LanguageModel {
  const modelId = tier === "smart" ? cfg.smartModel : cfg.fastModel;
  switch (cfg.provider) {
    case "openai":
      return createOpenAI({ baseURL: cfg.baseURL }).responses(modelId);
    case "chatgpt-oauth": {
      const openai = createOpenAI({
        apiKey: "oauth",
        baseURL: cfg.baseURL ?? "https://chatgpt.com/backend-api/codex",
        fetch: bearerFetch(({ headers, body, token }) => {
          if (token.accountId) headers.set("chatgpt-account-id", token.accountId);
          headers.set("OpenAI-Beta", "responses=experimental");
          headers.set("originator", "codex_cli_rs");
          return { body: chatgptBodyRewrite(body) };
        }),
      });
      return openai.responses(modelId);
    }
    case "gemini":
      return createGoogleGenerativeAI({ baseURL: cfg.baseURL })(modelId);
    case "gemini-oauth": {
      const google = createGoogleGenerativeAI({
        apiKey: "oauth",
        baseURL: cfg.baseURL,
        fetch: bearerFetch(({ headers }) => {
          if (cfg.googleProject) headers.set("x-goog-user-project", cfg.googleProject);
          return {};
        }),
      });
      return google(modelId);
    }
    case "anthropic":
      return createAnthropic({ baseURL: cfg.baseURL })(modelId);
  }
}

/** Rough list prices (USD per 1M tokens) for API-key billing. Subscription providers are not costed. */
const PRICES: Record<string, { in: number; out: number; cachedIn?: number }> = {
  "gpt-5": { in: 1.25, out: 10, cachedIn: 0.125 },
  "gpt-5-mini": { in: 0.25, out: 2, cachedIn: 0.025 },
  "gemini-2.5-pro": { in: 1.25, out: 10, cachedIn: 0.31 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5, cachedIn: 0.075 },
  "claude-opus-5": { in: 5, out: 25, cachedIn: 0.5 },
  "claude-sonnet-5": { in: 2, out: 10, cachedIn: 0.2 },
};

export function estimateCost(cfg: ProviderConfig, model: string, usage: { input: number; output: number; cached: number }): number | null {
  if (cfg.subscription) return null;
  const p = PRICES[model];
  if (!p) return null;
  const uncached = Math.max(0, usage.input - usage.cached);
  return (uncached * p.in + usage.cached * (p.cachedIn ?? p.in) + usage.output * p.out) / 1_000_000;
}
