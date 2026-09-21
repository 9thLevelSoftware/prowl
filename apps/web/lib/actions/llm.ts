"use server";

import { revalidatePath } from "next/cache";
import {
  createConnection,
  deleteConnectionRow,
  getActiveConnection,
  getConnection,
  listConnections,
  saveSelection,
  setActiveConnection,
  updateConnection,
  type ConnectionSdk,
  type LlmConnection,
} from "@prowl/db";
import {
  deleteSecrets,
  getCatalog,
  getFlow,
  getLlm,
  maskKey,
  providerSupport,
  refreshModels,
  setSecret,
  startGoogleSignIn,
  startOpenAiSignIn,
} from "@prowl/llm";
import { db, USER, worker } from "../server";
import type { ActionResult } from "./profile";

const fail = (err: unknown): { ok: false; error: string } => ({ ok: false, error: (err as Error).message ?? String(err) });
const refresh = () => revalidatePath("/", "layout");

function makeActiveIfFirst(id: string) {
  const active = getActiveConnection(db(), USER);
  if (!active || active.id === id || listConnections(db(), USER).length === 1) setActiveConnection(db(), id, USER);
}

async function afterConnect(conn: LlmConnection): Promise<string> {
  const { models, error } = await refreshModels(db(), conn);
  updateConnection(db(), conn.id, { status: error ? "error" : "ok", lastError: error, lastTestedAt: new Date().toISOString() });
  makeActiveIfFirst(conn.id);
  return error ? `Connected, but the model list could not be loaded (${error}). Showing ${models.length} known models instead.` : `Connected. ${models.length} models available.`;
}

/* ============================ Create / update ============================ */

export async function createApiKeyConnectionAction(input: {
  providerId: string | null;
  label: string;
  apiKey: string;
  baseUrl: string;
  local?: boolean;
}): Promise<ActionResult<{ connectionId: string }>> {
  try {
    const provider = input.providerId ? getCatalog()[input.providerId] : undefined;
    let sdk: ConnectionSdk = "openai-compatible";
    let baseUrl = input.baseUrl.trim() || null;
    if (provider) {
      const support = providerSupport(provider);
      if (!support.supported) throw new Error(`${provider.name}: ${support.reason}`);
      sdk = support.sdk;
      baseUrl = baseUrl ?? support.baseUrl;
    }
    if (sdk === "openai-compatible" && !baseUrl) throw new Error("Enter the API base URL (for example https://api.example.com/v1)");
    if (baseUrl) new URL(baseUrl);
    const key = input.apiKey.trim();
    if (!key && !input.local) throw new Error("Enter an API key");

    const conn = createConnection(db(), {
      userId: USER,
      kind: provider ? "api-key" : "openai-compatible",
      sdk,
      catalogProviderId: provider?.id ?? null,
      label: input.label.trim() || provider?.name || new URL(baseUrl!).host,
      baseUrl,
      authType: key ? "api_key" : "none",
      keyHint: key ? maskKey(key) : null,
      concurrency: input.local ? 1 : 4,
    });
    if (key) await setSecret(conn.id, "api_key", key);
    const message = await afterConnect(conn);
    refresh();
    return { ok: true, message, data: { connectionId: conn.id } };
  } catch (err) {
    return fail(err);
  }
}

export async function startChatGptSignInAction(connectionId?: string): Promise<ActionResult<{ flowId: string; authorizeUrl: string; connectionId: string | null }>> {
  try {
    const data = await startOpenAiSignIn(db(), { connectionId, userId: USER });
    return { ok: true, data };
  } catch (err) {
    return fail(err);
  }
}

/** New Gemini sign-in: validates the OAuth client details; the connection is created once sign-in succeeds. */
export async function startGeminiSignInAction(input: { clientId: string; clientSecret: string; project: string; label?: string }): Promise<ActionResult<{ flowId: string; authorizeUrl: string; connectionId: string | null }>> {
  try {
    const clientId = input.clientId.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("The client ID should end in .apps.googleusercontent.com");
    if (!input.clientSecret.trim()) throw new Error("Enter the client secret");
    if (!input.project.trim()) throw new Error("Enter your Google Cloud project ID");
    const data = await startGoogleSignIn(db(), { clientId, clientSecret: input.clientSecret.trim(), project: input.project.trim(), label: input.label }, USER);
    return { ok: true, data };
  } catch (err) {
    return fail(err);
  }
}

/** Re-authenticate an existing Gemini sign-in connection. */
export async function startGoogleSignInAction(connectionId: string): Promise<ActionResult<{ flowId: string; authorizeUrl: string; connectionId: string | null }>> {
  try {
    return { ok: true, data: await startGoogleSignIn(db(), connectionId, USER) };
  } catch (err) {
    return fail(err);
  }
}

/** Polled by the UI while the user signs in. Loads models once the sign-in completes. */
export async function signInStatusAction(flowId: string): Promise<ActionResult<{ status: "pending" | "done" | "error"; connectionId: string | null }>> {
  const flow = getFlow(flowId);
  if (!flow) return { ok: false, error: "This sign-in has expired. Start again." };
  if (flow.status === "error") return { ok: false, error: flow.error ?? "Sign-in failed" };
  if (flow.status === "done") {
    const conn = getConnection(db(), flow.connectionId);
    const message = conn ? await afterConnect(conn) : undefined;
    refresh();
    return { ok: true, message, data: { status: "done", connectionId: flow.connectionId } };
  }
  return { ok: true, data: { status: "pending", connectionId: flow.connectionId } };
}

export async function updateConnectionAction(
  id: string,
  input: { label?: string; baseUrl?: string; apiKey?: string; googleProject?: string; concurrency?: number },
): Promise<ActionResult> {
  try {
    const conn = getConnection(db(), id);
    if (!conn) throw new Error("Connection not found");
    const patch: Parameters<typeof updateConnection>[2] = {};
    if (input.label !== undefined && input.label.trim()) patch.label = input.label.trim();
    if (input.baseUrl !== undefined && conn.authType !== "oauth" && conn.kind !== "env") {
      const b = input.baseUrl.trim();
      if (b) new URL(b);
      patch.baseUrl = b || null;
    }
    if (input.googleProject !== undefined && conn.kind === "gemini-oauth") patch.googleProject = input.googleProject.trim();
    if (input.concurrency !== undefined) patch.concurrency = Math.min(8, Math.max(1, Math.round(input.concurrency)));
    if (input.apiKey?.trim()) {
      await setSecret(conn.id, "api_key", input.apiKey.trim());
      patch.keyHint = maskKey(input.apiKey);
      patch.authType = "api_key";
    }
    const updated = updateConnection(db(), id, patch);
    const message = input.apiKey?.trim() || input.baseUrl !== undefined ? await afterConnect(updated) : "Saved";
    refresh();
    return { ok: true, message };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteConnectionAction(id: string): Promise<ActionResult> {
  try {
    await deleteSecrets(id);
    deleteConnectionRow(db(), id, USER);
    refresh();
    return { ok: true, message: "Connection removed" };
  } catch (err) {
    return fail(err);
  }
}

/* ============================ Models and use ============================= */

export async function setActiveConnectionAction(id: string): Promise<ActionResult> {
  try {
    setActiveConnection(db(), id, USER);
    getLlm(db()).reload();
    await worker("/schedule/reload", { method: "POST" }).catch(() => undefined);
    refresh();
    return { ok: true, message: "This connection is now used for all AI work" };
  } catch (err) {
    return fail(err);
  }
}

export async function refreshModelsAction(id: string): Promise<ActionResult> {
  try {
    const conn = getConnection(db(), id);
    if (!conn) throw new Error("Connection not found");
    const { models, error } = await refreshModels(db(), conn);
    refresh();
    // A failed live list is explained by the notice above the pickers, so don't repeat it here.
    return { ok: true, message: error ? undefined : `Loaded ${models.length} models` };
  } catch (err) {
    return fail(err);
  }
}

export async function saveSelectionAction(id: string, slot: "main" | "fast", model: string, effort: string | null): Promise<ActionResult> {
  try {
    saveSelection(db(), id, slot, model, effort);
    getLlm(db()).reload();
    refresh();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function testConnectionAction(id: string): Promise<ActionResult> {
  const conn = getConnection(db(), id);
  if (!conn) return { ok: false, error: "Connection not found" };
  const r = await getLlm(db()).testConnection(conn);
  refresh();
  return r.ok ? { ok: true, message: `Working: ${r.model} replied in ${(r.ms / 1000).toFixed(1)}s` } : { ok: false, error: r.error ?? "Test failed" };
}
