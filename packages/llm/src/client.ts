import { generateObject, generateText, streamObject, streamText, type ModelMessage } from "ai";
import type { z } from "zod";
import { createConnection, getDb, listConnections, schema, updateConnection, type Db, type LlmConnection } from "@jh/db";
import { LOCAL_USER_ID, logger } from "@jh/shared";
import { isProviderId, type Tier } from "./providers";
import { buildModel, resolveRuntime, resolveSelection, type BuiltModel, type Runtime } from "./runtime";
import { refreshModels } from "./models";

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

/**
 * Existing .env provider settings keep working: when no connections exist yet and
 * JH_LLM_PROVIDER is set, a read-only "From .env" connection is created.
 */
export function ensureEnvConnection(db: Db): void {
  const envProvider = process.env.JH_LLM_PROVIDER;
  if (!envProvider || !isProviderId(envProvider)) return;
  if (listConnections(db).length) return;
  // Only when credentials are actually configured; an untouched .env template shouldn't create one.
  const e = process.env;
  const hasCredentials: Record<string, boolean> = {
    "gemini-oauth": !!(e.JH_LLM_TOKEN_CMD || e.JH_LLM_TOKEN_FILE || e.JH_LLM_ACCESS_TOKEN),
    "chatgpt-oauth": !!(e.JH_LLM_TOKEN_CMD || e.JH_LLM_TOKEN_FILE || e.JH_LLM_ACCESS_TOKEN),
    gemini: !!e.GEMINI_API_KEY,
    openai: !!e.OPENAI_API_KEY,
    anthropic: !!e.ANTHROPIC_API_KEY,
  };
  if (!hasCredentials[envProvider]) return;
  createConnection(db, { userId: LOCAL_USER_ID, kind: "env", sdk: "env", label: `From .env (${envProvider})`, authType: "env", status: "untested", concurrency: envProvider.endsWith("-oauth") ? 2 : 4 });
}

export interface ClientConfig {
  provider: string;
  connectionId: string | null;
  smartModel: string;
  fastModel: string;
  smartEffort: string | null;
  fastEffort: string | null;
  concurrency: number;
}

export class LlmClient {
  private sem = new Semaphore(2);
  private runtime: Runtime | null = null;

  constructor(private readonly db: Db) {
    this.reload();
  }

  get config(): ClientConfig {
    const r = this.runtime;
    return {
      provider: r?.connection.label ?? "none",
      connectionId: r?.connection.id ?? null,
      smartModel: r?.main.model ?? "",
      fastModel: r?.fast.model ?? "",
      smartEffort: r?.main.effort ?? null,
      fastEffort: r?.fast.effort ?? null,
      concurrency: r?.connection.concurrency ?? 2,
    };
  }

  /** Re-read the active connection and its saved selections. Called before each worker task. */
  reload(): void {
    try {
      ensureEnvConnection(this.db);
      this.runtime = resolveRuntime(this.db);
    } catch (err) {
      log.warn(`AI connection is not ready: ${(err as Error).message}`);
      this.runtime = null;
    }
    this.sem.setLimit(this.runtime?.connection.concurrency ?? 2);
  }

  private async model(tier: Tier): Promise<BuiltModel & { conn: LlmConnection }> {
    this.reload();
    if (!this.runtime) throw new Error("No AI connection is set up. Add one on the Settings page.");
    const sel = tier === "smart" ? this.runtime.main : this.runtime.fast;
    return { ...(await buildModel(this.db, this.runtime.connection, sel, tier)), conn: this.runtime.connection };
  }

  private record(ctx: CallContext, conn: LlmConnection | null, built: BuiltModel | null, started: number, usage: any, error?: unknown): void {
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    const cached = usage?.cachedInputTokens ?? 0;
    const info = built?.info;
    const subscription = conn?.authType === "oauth" && conn.sdk === "openai-chatgpt";
    const cost =
      !subscription && info?.costIn != null && info.costOut != null
        ? (Math.max(0, input - cached) * info.costIn + cached * (info.costCachedIn ?? info.costIn) + output * info.costOut) / 1_000_000
        : null;
    try {
      this.db
        .insert(schema.llmCalls)
        .values({
          userId: ctx.userId ?? LOCAL_USER_ID,
          task: ctx.task,
          provider: conn?.label ?? "none",
          model: built ? `${built.modelId}${this.effortLabel(built)}` : "unknown",
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: cached,
          costUsd: cost,
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

  private effortLabel(built: BuiltModel): string {
    const r = this.runtime;
    if (!r) return "";
    const sel = r.main.model === built.modelId ? r.main : r.fast;
    return sel.effort ? ` (${sel.effort})` : "";
  }

  /** Structured output validated against a zod schema. */
  async object<S extends z.ZodType>(ctx: CallContext, schemaDef: S, input: Input): Promise<z.infer<S>> {
    return this.sem.run(async () => {
      const started = Date.now();
      let built: (BuiltModel & { conn: LlmConnection }) | null = null;
      try {
        built = await this.model(ctx.tier ?? "smart");
        const common = {
          model: built.model,
          schema: schemaDef,
          maxOutputTokens: ctx.maxOutputTokens,
          temperature: built.info?.reasoning ? undefined : ctx.temperature,
          abortSignal: ctx.abortSignal,
          maxRetries: 3,
          providerOptions: built.providerOptions,
          ...input,
        };
        if (built.streaming) {
          let streamError: unknown;
          const res = streamObject({ ...(common as any), onError: ({ error }: { error: unknown }) => (streamError = error) });
          const obj = await res.object.catch((e: unknown) => {
            throw streamError ?? e;
          });
          this.record(ctx, built.conn, built, started, await res.usage.catch(() => undefined));
          return obj as z.infer<S>;
        }
        const res = await generateObject(common as any);
        this.record(ctx, built.conn, built, started, res.usage);
        return res.object as z.infer<S>;
      } catch (err) {
        this.record(ctx, built?.conn ?? this.runtime?.connection ?? null, built, started, undefined, err);
        throw err;
      }
    });
  }

  async text(ctx: CallContext, input: Input): Promise<string> {
    return this.sem.run(async () => {
      const started = Date.now();
      let built: (BuiltModel & { conn: LlmConnection }) | null = null;
      try {
        built = await this.model(ctx.tier ?? "smart");
        return await this.runText(built, ctx, input, started);
      } catch (err) {
        this.record(ctx, built?.conn ?? this.runtime?.connection ?? null, built, started, undefined, err);
        throw err;
      }
    });
  }

  private async runText(built: BuiltModel & { conn: LlmConnection }, ctx: CallContext, input: Input, started: number): Promise<string> {
    const common = {
      model: built.model,
      maxOutputTokens: ctx.maxOutputTokens,
      temperature: built.info?.reasoning ? undefined : ctx.temperature,
      abortSignal: ctx.abortSignal,
      maxRetries: 2,
      providerOptions: built.providerOptions,
      ...input,
    };
    if (built.streaming) {
      const res = streamText(common as any);
      const text = await res.text;
      this.record(ctx, built.conn, built, started, await res.usage.catch(() => undefined));
      return text;
    }
    const res = await generateText(common as any);
    this.record(ctx, built.conn, built, started, res.usage);
    return res.text;
  }

  /**
   * Test any connection (not only the active one): refresh its model list, then send a tiny prompt
   * to its fast model. Updates the connection's status.
   */
  async testConnection(conn: LlmConnection): Promise<{ ok: boolean; model: string; reply?: string; error?: string; ms: number; modelsError?: string | null }> {
    const started = Date.now();
    let modelsError: string | null = null;
    let model = "";
    try {
      if (conn.sdk !== "env") {
        const r = await refreshModels(this.db, conn);
        modelsError = r.error;
      }
      const fresh = listConnections(this.db).find((c) => c.id === conn.id)!;
      const sel = resolveSelection(fresh, "fast");
      model = sel.model;
      const built = { ...(await buildModel(this.db, fresh, sel, "fast")), conn: fresh };
      const reply = await this.runText(built, { task: "connection_test", maxOutputTokens: 512 }, { prompt: "Reply with the single word: pong" }, started);
      updateConnection(this.db, conn.id, { status: "ok", lastError: null, lastTestedAt: new Date().toISOString() });
      return { ok: true, model, reply: reply.trim(), ms: Date.now() - started, modelsError };
    } catch (err) {
      const error = (err as Error).message;
      const current = listConnections(this.db).find((c) => c.id === conn.id);
      updateConnection(this.db, conn.id, { status: current?.status === "needs_signin" ? "needs_signin" : "error", lastError: error.slice(0, 1000), lastTestedAt: new Date().toISOString() });
      this.record({ task: "connection_test" }, conn, null, started, undefined, err);
      return { ok: false, model, error, ms: Date.now() - started, modelsError };
    }
  }

  /** Round trip on the active connection (used by the worker control API). */
  async ping(): Promise<{ ok: boolean; provider: string; model: string; reply?: string; error?: string; ms: number }> {
    this.reload();
    if (!this.runtime) return { ok: false, provider: "none", model: "", error: "No AI connection is set up", ms: 0 };
    const r = await this.testConnection(this.runtime.connection);
    return { ok: r.ok, provider: this.runtime.connection.label, model: r.model, reply: r.reply, error: r.error, ms: r.ms };
  }
}

const g = globalThis as unknown as { __jhLlm?: LlmClient };

export function getLlm(db: Db = getDb()): LlmClient {
  g.__jhLlm ??= new LlmClient(db);
  return g.__jhLlm;
}
