import type { ConnectionSdk, EffortKind } from "@jh/db";
import type { CatalogModel } from "./catalog";

export interface EffortInfo {
  effortKind: EffortKind;
  efforts: string[];
  defaultEffort: string | null;
}

const BUDGET_LEVELS = ["off", "low", "medium", "high"];
const BUDGET_TOKENS: Record<string, number> = { low: 2048, medium: 8192, high: 24576 };

export const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  off: "Off",
  on: "On",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  dynamic: "Dynamic",
};

function pickDefault(efforts: string[]): string | null {
  for (const e of ["medium", "high", "low", "on", "dynamic"]) if (efforts.includes(e)) return e;
  return efforts.find((e) => e !== "off" && e !== "none") ?? efforts[0] ?? null;
}

/**
 * Which reasoning controls a model supports. Uses models.dev reasoning_options when present,
 * otherwise sensible per-SDK defaults for reasoning models, otherwise none.
 */
export function effortInfo(sdk: ConnectionSdk, modelId: string, meta?: CatalogModel): EffortInfo {
  const opts = meta?.reasoning_options ?? [];
  const effortOpt = opts.find((o) => o.type === "effort" && o.values?.length);
  const hasToggle = opts.some((o) => o.type === "toggle");
  const hasBudget = opts.some((o) => o.type === "budget_tokens");

  if (effortOpt) {
    const values = [...effortOpt.values!];
    if (hasToggle && !values.includes("none") && !values.includes("off")) values.unshift("off");
    return { effortKind: "effort", efforts: values, defaultEffort: pickDefault(values) };
  }
  if (hasBudget) return { effortKind: "budget", efforts: BUDGET_LEVELS, defaultEffort: "medium" };
  if (hasToggle) return { effortKind: "toggle", efforts: ["off", "on"], defaultEffort: "on" };

  const reasoning = meta?.reasoning ?? (sdk === "openai" || sdk === "openai-chatgpt" ? /^(o\d|gpt-5|gpt-6)/.test(modelId) : false);
  if (!reasoning) return { effortKind: "none", efforts: [], defaultEffort: null };
  switch (sdk) {
    case "openai":
    case "openai-chatgpt":
      return { effortKind: "effort", efforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium" };
    case "google":
      return { effortKind: "budget", efforts: [...BUDGET_LEVELS, "dynamic"], defaultEffort: "dynamic" };
    case "anthropic":
      return { effortKind: "budget", efforts: BUDGET_LEVELS, defaultEffort: "medium" };
    default:
      return { effortKind: "effort", efforts: ["low", "medium", "high"], defaultEffort: "medium" };
  }
}

/**
 * Translate a chosen effort into AI SDK providerOptions for the connection's SDK.
 * Returns undefined when there is nothing to send.
 */
export function providerOptionsFor(sdk: ConnectionSdk, kind: EffortKind, effort: string | null, compatibleName = "compatible"): Record<string, Record<string, unknown>> | undefined {
  if (!effort || kind === "none") return undefined;
  switch (sdk) {
    case "openai":
    case "openai-chatgpt":
      if (kind === "toggle") return effort === "off" ? { openai: { reasoningEffort: "none" } } : undefined;
      if (kind === "budget") return { openai: { reasoningEffort: effort === "off" ? "none" : effort } };
      return { openai: { reasoningEffort: effort === "off" ? "none" : effort } };
    case "google": {
      if (effort === "off") return { google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } };
      if (effort === "on" || effort === "dynamic") return { google: { thinkingConfig: { thinkingBudget: -1, includeThoughts: false } } };
      if (kind === "effort") {
        const level = effort === "max" || effort === "xhigh" ? "high" : effort === "none" ? "minimal" : effort;
        return { google: { thinkingConfig: { thinkingLevel: level, includeThoughts: false } } };
      }
      return { google: { thinkingConfig: { thinkingBudget: BUDGET_TOKENS[effort] ?? -1, includeThoughts: false } } };
    }
    case "anthropic": {
      if (effort === "off" || effort === "none") return { anthropic: { thinking: { type: "disabled" } } };
      if (kind === "effort") return { anthropic: { effort } };
      if (kind === "toggle") return { anthropic: { thinking: { type: "enabled", budgetTokens: BUDGET_TOKENS.medium } } };
      return { anthropic: { thinking: { type: "enabled", budgetTokens: BUDGET_TOKENS[effort] ?? BUDGET_TOKENS.medium } } };
    }
    case "openai-compatible":
      if (kind === "toggle" || effort === "off" || effort === "on") return undefined;
      return { [compatibleName]: { reasoningEffort: effort } };
    default:
      return undefined;
  }
}
