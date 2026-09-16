import { generateObject, generateText, streamObject, streamText, type ModelMessage } from "ai";
import type { z } from "zod";
import { getDb, getSetting, schema, type Db } from "@jh/db";
import { LOCAL_USER_ID, logger } from "@jh/shared";
import { createModel, estimateCost, resolveProviderConfig, type ProviderConfig, type Tier } from "./providers";

const log = logger("llm");

export interface CallContext {
  /** Short task label for the cost ledger, e.g. "tailor", "extract_requirements". */
  task: string;
  tier?: Tier;
  jobId?: string;
  applicationId?: string;
  userId?: string;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export type Input = { system?: string; prompt: string } | { system?: string; messages: ModelMessage[] };

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private limit: number) {}
  setLimit(n: number) {
    this.limit = Math.max(1, n);
    this.drain();
  }
  private drain() {
    while (this.active < this.limit && this.queue.length) {
      this.active++;
      this.queue.shift()!();
    }
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      this.drain();
    }
  }
}

export const LLM_SETTINGS_KEY = "llm";

export class LlmClient {
  private sem: Semaphore;
  constructor(
    private readonly db: Db,
    private cfg: ProviderConfig,
  ) {
    this.sem = new Semaphore(cfg.concurrency);
  }

  get config(): ProviderConfig {
    return this.cfg;
  }

  /** Re-read overrides saved from the Settings page. */
  reload(): void {
    const overrides = getSetting<Partial<ProviderConfig>>(this.db, LLM_SETTINGS_KEY, {});
    this.cfg = resolveProviderConfig(overrides);
    this.sem.setLimit(this.cfg.concurrency);
  }

  private streaming(): boolean {
    // The ChatGPT subscription backend only answers streamed requests.
    return this.cfg.provider === "chatgpt-oauth";
  }

  private modelId(tier: Tier): string {
    return tier === "smart" ? this.cfg.smartModel : this.cfg.fastModel;
  }

  private record(ctx: CallContext, model: string, started: number, usage: any, error?: unknown): void {
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    const cached = usage?.cachedInputTokens ?? 0;
    try {
      this.db
        .insert(schema.llmCalls)
        .values({
          userId: ctx.userId ?? LOCAL_USER_ID,
          task: ctx.task,
          provider: this.cfg.provider,
          model,
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: cached,
          costUsd: estimateCost(this.cfg, model, { input, output, cached }),
          durationMs: Date.now() - started,
          ok: !error,
          error: error ? String((error as Error).message ?? error).slice(0, 2000) : null,
          jobId: ctx.jobId ?? null,
          applicationId: ctx.applicationId ?? null,
        })
        .run();
    } catch (e) {
      log.warn("failed to record llm call", e);
    }
  }

  /** Structured output validated against a zod schema. */
  async object<S extends z.ZodType>(ctx: CallContext, schemaDef: S, input: Input): Promise<z.infer<S>> {
    const tier = ctx.tier ?? "smart";
    const model = this.modelId(tier);
    return this.sem.run(async () => {
      const started = Date.now();
      const common = {
        model: createModel(this.cfg, tier),
        schema: schemaDef,
        maxOutputTokens: ctx.maxOutputTokens,
        temperature: ctx.temperature,
        abortSignal: ctx.abortSignal,
        maxRetries: 3,
        ...input,
      } as const;
      try {
        if (this.streaming()) {
          let streamError: unknown;
          const res = streamObject({ ...(common as any), onError: ({ error }: { error: unknown }) => (streamError = error) });
          const obj = await res.object.catch((e: unknown) => {
            throw streamError ?? e;
          });
          this.record(ctx, model, started, await res.usage.catch(() => undefined));
          return obj as z.infer<S>;
        }
        const res = await generateObject(common as any);
        this.record(ctx, model, started, res.usage);
        return res.object as z.infer<S>;
      } catch (err) {
        this.record(ctx, model, started, undefined, err);
        throw err;
      }
    });
  }

  async text(ctx: CallContext, input: Input): Promise<string> {
    const tier = ctx.tier ?? "smart";
    const model = this.modelId(tier);
    return this.sem.run(async () => {
      const started = Date.now();
      const common = {
        model: createModel(this.cfg, tier),
        maxOutputTokens: ctx.maxOutputTokens,
        temperature: ctx.temperature,
        abortSignal: ctx.abortSignal,
        maxRetries: 3,
        ...input,
      };
      try {
        if (this.streaming()) {
          const res = streamText(common as any);
          const text = await res.text;
          this.record(ctx, model, started, await res.usage.catch(() => undefined));
          return text;
        }
        const res = await generateText(common as any);
        this.record(ctx, model, started, res.usage);
        return res.text;
      } catch (err) {
        this.record(ctx, model, started, undefined, err);
        throw err;
      }
    });
  }

  /** Minimal round trip used by the Settings page "Test connection" button. */
  async ping(): Promise<{ ok: boolean; provider: string; model: string; reply?: string; error?: string; ms: number }> {
    const started = Date.now();
    try {
      const reply = await this.text({ task: "ping", tier: "fast", maxOutputTokens: 64 }, { prompt: "Reply with the single word: pong" });
      return { ok: true, provider: this.cfg.provider, model: this.cfg.fastModel, reply: reply.trim(), ms: Date.now() - started };
    } catch (err) {
      return { ok: false, provider: this.cfg.provider, model: this.cfg.fastModel, error: (err as Error).message, ms: Date.now() - started };
    }
  }
}

const g = globalThis as unknown as { __jhLlm?: LlmClient };

export function getLlm(db: Db = getDb()): LlmClient {
  if (!g.__jhLlm) {
    const overrides = getSetting<Partial<ProviderConfig>>(db, LLM_SETTINGS_KEY, {});
    g.__jhLlm = new LlmClient(db, resolveProviderConfig(overrides));
  }
  return g.__jhLlm;
}
