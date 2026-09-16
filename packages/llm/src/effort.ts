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
  auto: "Automatic (by task)",
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

/* ============================ Automatic effort =========================== */

export const AUTO_EFFORT = "auto";
export type EffortIntent = "low" | "medium" | "high";

/**
 * How much reasoning each task deserves when effort is Automatic.
 * - low: copying or classifying text that is already on the page
 * - medium: short writing grounded in given facts
 * - high: work where quality or truthfulness decides the outcome
 */
export const TASK_EFFORT: Record<string, EffortIntent> = {
  extract_profile: "low",
  extract_requirements: "low",
  careerpage_links: "low",
  vision_form_check: "low",
  connection_test: "low",
  ping: "low",
  builder_bullets: "medium",
  builder_summary: "medium",
  form_answers: "medium",
  cover_letter: "medium",
  tailor: "high",
  audit: "high",
  audit_resume: "high",
  audit_cover: "high",
  audit_resume_edit: "high",
  audit_cover_edit: "high",
};

/** Plain-language descriptions of AI tasks, for status displays. */
export const TASK_LABELS: Record<string, string> = {
  extract_profile: "Reading your resume",
  extract_requirements: "Analyzing a job posting",
  careerpage_links: "Reading a career page",
  vision_form_check: "Checking a filled-in application",
  connection_test: "Testing the AI connection",
  ping: "Testing the AI connection",
  builder_bullets: "Drafting resume bullets",
  builder_summary: "Drafting your summary",
  form_answers: "Drafting application answers",
  cover_letter: "Writing a cover letter",
  tailor: "Tailoring a resume",
  audit: "Fact-checking",
  audit_resume: "Fact-checking a tailored resume",
  audit_cover: "Fact-checking a cover letter",
  audit_resume_edit: "Fact-checking your resume edits",
  audit_cover_edit: "Fact-checking your cover letter edits",
};

export const WORKER_TASK_LABELS: Record<string, string> = {
  discover_all: "Starting job discovery",
  discover_source: "Finding new jobs",
  process_job: "Scoring jobs",
  tailor: "Tailoring an application",
  apply: "Filling out an application",
};

export function effortForTask(task: string): EffortIntent {
  return TASK_EFFORT[task] ?? "medium";
}

const SCALE = ["none", "off", "minimal", "low", "medium", "on", "high", "xhigh", "max", "ultra"];
const TARGET: Record<EffortIntent, string[]> = {
  // Preferred levels in order; the first one the model supports wins.
  low: ["low", "minimal", "medium", "on"],
  medium: ["medium", "low", "high", "on"],
  high: ["high", "xhigh", "medium", "on"],
};

/** Map a task's intent onto the effort levels a specific model actually offers. */
export function pickEffort(efforts: string[], intent: EffortIntent): string | null {
  if (!efforts.length) return null;
  for (const e of TARGET[intent]) if (efforts.includes(e)) return e;
  // Unusual scales: pick by position (low = bottom third, high = top third), never "off"/"none".
  const usable = efforts.filter((e) => e !== "off" && e !== "none").sort((a, b) => SCALE.indexOf(a) - SCALE.indexOf(b));
  if (!usable.length) return efforts[0]!;
  const i = intent === "low" ? 0 : intent === "medium" ? Math.floor((usable.length - 1) / 2) : Math.ceil((usable.length - 1) * 0.67);
  return usable[i]!;
}

export const TASK_EFFORT_SUMMARY = "Automatic uses low effort to read resumes and postings, medium to write cover letters and answers, and high to tailor resumes and fact-check them.";

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
