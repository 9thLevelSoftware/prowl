import { NoObjectGeneratedError, generateObject, generateText, streamObject, streamText, type ModelMessage } from "ai";
import { openai as openaiProvider } from "@ai-sdk/openai";
import type { z } from "zod";
import { clearOrphanActivity, createConnection, endActivity, getDb, listConnections, schema, startActivity, updateConnection, type Db, type LlmConnection } from "@jh/db";
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

/** Upper bound for one AI call, so a stuck provider can never leave the UI waiting forever. */
export const CALL_TIMEOUT_MS = Number(process.env.JH_LLM_TIMEOUT_MS ?? 15 * 60_000);

export function processKind(): "web" | "worker" | "other" {
  if (process.env.JH_PROCESS === "worker") return "worker";
  if (process.env.NEXT_RUNTIME) return "web";
  return "other";
}

function callSignal(ctx: { abortSignal?: AbortSignal }): AbortSignal {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  return ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout;
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
    try {
      clearOrphanActivity(db, processKind());
    } catch {
      /* table may not exist yet */
    }
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

  private async model(tier: Tier, task: string): Promise<BuiltModel & { conn: LlmConnection }> {
    this.reload();
    if (!this.runtime) throw new Error("No AI connection is set up. Add one on the Settings page.");
    const sel = tier === "smart" ? this.runtime.main : this.runtime.fast;
    return { ...(await buildModel(this.db, this.runtime.connection, sel, tier, task)), conn: this.runtime.connection };
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
          model: built ? `${built.modelId}${built.effort ? ` (${built.effort})` : ""}` : "unknown",
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

  /** Mark a call as in progress so the UI can show what the AI is doing. Never throws. */
  private begin(ctx: CallContext, built: BuiltModel & { conn: LlmConnection }): string | null {
    try {
      return startActivity(this.db, {
        userId: ctx.userId ?? LOCAL_USER_ID,
        task: ctx.task,
        model: built.modelId,
        effort: built.effort,
        connectionLabel: built.conn.label,
        process: processKind(),
        jobId: ctx.jobId ?? null,
        applicationId: ctx.applicationId ?? null,
      });
    } catch {
      return null;
    }
  }

  private end(id: string | null): void {
    if (!id) return;
    try {
      endActivity(this.db, id);
    } catch {
      /* table may not exist yet during a migration */
    }
  }

  /** Structured output validated against a zod schema. */
  async object<S extends z.ZodType>(ctx: CallContext, schemaDef: S, input: Input): Promise<z.infer<S>> {
    return this.sem.run(async () => {
      const started = Date.now();
      let built: (BuiltModel & { conn: LlmConnection }) | null = null;
      let activity: string | null = null;
      try {
        built = await this.model(ctx.tier ?? "smart", ctx.task);
        activity = this.begin(ctx, built);
        const common = {
          model: built.model,
          schema: schemaDef,
          maxOutputTokens: ctx.maxOutputTokens,
          temperature: built.info?.reasoning ? undefined : ctx.temperature,
          abortSignal: callSignal(ctx),
          maxRetries: 3,
          providerOptions: built.providerOptions,
          ...input,
        };
        const attempt = async () => {
          if (built!.streaming) {
            let streamError: unknown;
            const res = streamObject({ ...(common as any), onError: ({ error }: { error: unknown }) => (streamError = error) });
            const obj = await res.object.catch((e: unknown) => {
              throw streamError ?? e;
            });
            return { object: obj, usage: await res.usage.catch(() => undefined) };
          }
          const res = await generateObject(common as any);
          return { object: res.object, usage: res.usage };
        };
        let result;
        try {
          result = await attempt();
        } catch (err) {
          // The API retries cover transport failures only. A reply that doesn't match the schema
          // (a missing field, a malformed value) is usually fixed by sampling once more.
          if (!NoObjectGeneratedError.isInstance(err)) throw err;
          log.warn(`${ctx.task}: the model's reply didn't match the expected format, retrying once (${err.cause instanceof Error ? err.cause.message.split("\n")[0] : err.message})`);
          result = await attempt();
        }
        this.record(ctx, built.conn, built, started, result.usage);
        return result.object as z.infer<S>;
      } catch (err) {
        this.record(ctx, built?.conn ?? this.runtime?.connection ?? null, built, started, undefined, err);
        throw err;
      } finally {
        this.end(activity);
      }
    });
  }

  async text(ctx: CallContext, input: Input): Promise<string> {
    return this.sem.run(async () => {
      const started = Date.now();
      let built: (BuiltModel & { conn: LlmConnection }) | null = null;
      let activity: string | null = null;
      try {
        built = await this.model(ctx.tier ?? "smart", ctx.task);
        activity = this.begin(ctx, built);
        return await this.runText(built, ctx, input, started);
      } catch (err) {
        this.record(ctx, built?.conn ?? this.runtime?.connection ?? null, built, started, undefined, err);
        throw err;
      } finally {
        this.end(activity);
      }
    });
  }

  private async runText(built: BuiltModel & { conn: LlmConnection }, ctx: CallContext, input: Input, started: number): Promise<string> {
    const common = {
      model: built.model,
      maxOutputTokens: ctx.maxOutputTokens,
      temperature: built.info?.reasoning ? undefined : ctx.temperature,
      abortSignal: callSignal(ctx),
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

  /** Whether the active connection offers a built-in web search tool on its fast model. */
  canSearchWeb(): boolean {
    this.reload();
    const r = this.runtime;
    if (!r || (r.connection.sdk !== "openai-chatgpt" && r.connection.sdk !== "openai")) return false;
    // Model lists saved before search support was tracked have no flag. Both OpenAI backends support the tool for reasoning models.
    const flag = r.fast.info?.webSearch;
    return flag ?? (r.fast.info?.reasoning ?? true);
  }

  /**
   * Run a prompt with the provider's built-in web search tool. Returns the answer text and every URL
   * found in it or in its cited sources. Callers must verify URLs; search results are leads, not facts.
   */
  async searchWeb(ctx: CallContext, prompt: string): Promise<{ available: boolean; text: string; urls: string[] }> {
    if (!this.canSearchWeb()) return { available: false, text: "", urls: [] };
    return this.sem.run(async () => {
      const started = Date.now();
      let built: (BuiltModel & { conn: LlmConnection }) | null = null;
      let activity: string | null = null;
      try {
        built = await this.model("fast", ctx.task);
        activity = this.begin(ctx, built);
        const res = await generateText({
          model: built.model,
          prompt,
          tools: { web_search: openaiProvider.tools.webSearch({}) } as any,
          providerOptions: built.providerOptions as any,
          abortSignal: callSignal(ctx),
          maxRetries: 2,
        });
        this.record(ctx, built.conn, built, started, res.usage);
        const urls = new Set<string>();
        for (const m of res.text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) urls.add(m[0].replace(/[.,;:]+$/, ""));
        for (const src of (res.sources ?? []) as { sourceType?: string; url?: string }[]) if (src.url) urls.add(src.url);
        return { available: true, text: res.text, urls: [...urls] };
      } catch (err) {
        this.record(ctx, built?.conn ?? this.runtime?.connection ?? null, built, started, undefined, err);
        throw err;
      } finally {
        this.end(activity);
      }
    });
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
      const built = { ...(await buildModel(this.db, fresh, sel, "fast", "connection_test")), conn: fresh };
      const activity = this.begin({ task: "connection_test" }, built);
      const reply = await this.runText(built, { task: "connection_test", maxOutputTokens: 512 }, { prompt: "Reply with the single word: pong" }, started).finally(() => this.end(activity));
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
  // The instance lives on globalThis to survive Next.js hot reloads, but it must be rebuilt when
  // this module is reloaded; otherwise the web server keeps running the old client code.
  if (!(g.__jhLlm instanceof LlmClient)) g.__jhLlm = new LlmClient(db);
  return g.__jhLlm;
}
