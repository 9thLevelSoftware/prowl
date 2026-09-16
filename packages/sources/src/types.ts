import type { Preferences, RawJob, SourceType } from "@jh/shared";
import type { LlmClient } from "@jh/llm";

export interface SourceContext {
  prefs: Preferences;
  /** Available to adapters that need model help (career page link extraction). */
  llm?: LlmClient;
  /** Emits progress lines to the run log. */
  progress: (msg: string) => void;
  signal?: AbortSignal;
}

export interface DiscoveryResult {
  jobs: RawJob[];
  /** New native ATS sources found while crawling (e.g. a career page that embeds Greenhouse). */
  discoveredSources?: { type: SourceType; name: string; config: Record<string, unknown> }[];
  notes?: string[];
}

export interface SourceAdapter<C = Record<string, unknown>> {
  type: SourceType;
  label: string;
  description: string;
  /** Whether this adapter needs the shared logged-in browser (worker-only, serialized). */
  usesBrowser: boolean;
  configFields: { key: string; label: string; placeholder?: string; required?: boolean; help?: string }[];
  validate(config: Record<string, unknown>): C;
  discover(config: C, ctx: SourceContext): Promise<DiscoveryResult>;
}
