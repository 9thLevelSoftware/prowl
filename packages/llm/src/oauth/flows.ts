import crypto from "node:crypto";
import { createConnection, getConnection, updateConnection, tryLockRefresh, unlockRefresh, type Db, type LlmConnection } from "@jh/db";
import { LOCAL_USER_ID, logger, sleep } from "@jh/shared";
import { getSecret, setSecret } from "../secrets";
import { pkcePair, randomState } from "./pkce";
import { startLoopback, type LoopbackServer } from "./loopback";
import { OPENAI_CALLBACK_PATH, OPENAI_CALLBACK_PORT, openaiAccount, openaiAuthorizeUrl, openaiExchangeCode, openaiRefresh } from "./openai";
import { googleAuthorizeUrl, googleExchangeCode, googleRefresh } from "./google";

const log = logger("oauth");

export interface FlowState {
  id: string;
  provider: "openai" | "google";
  connectionId: string;
  status: "pending" | "done" | "error";
  error?: string;
  startedAt: number;
}

const g = globalThis as unknown as { __jhFlows?: Map<string, FlowState & { server?: LoopbackServer }> };
const flows = (g.__jhFlows ??= new Map());

export function getFlow(id: string): FlowState | undefined {
  const f = flows.get(id);
  if (!f) return undefined;
  const { server: _server, ...rest } = f;
  return rest;
}

function register(provider: FlowState["provider"], connectionId: string): FlowState & { server?: LoopbackServer } {
  // Only one sign-in per provider at a time: ChatGPT's callback port is fixed.
  for (const f of flows.values()) {
    if (f.provider === provider && f.status === "pending") {
      f.server?.close();
      f.status = "error";
      f.error = "Replaced by a newer sign-in";
    }
  }
  const flow: FlowState & { server?: LoopbackServer } = { id: crypto.randomUUID(), provider, connectionId, status: "pending", startedAt: Date.now() };
  flows.set(flow.id, flow);
  return flow;
}

function track(flow: FlowState & { server?: LoopbackServer }) {
  flow.server!.result.then(
    () => {
      flow.status = "done";
    },
    (err: Error) => {
      flow.status = "error";
      flow.error = err.message;
      log.warn(`${flow.provider} sign-in failed: ${err.message}`);
    },
  );
}

/* ================================ ChatGPT =============================== */

/**
 * Start "Sign in with ChatGPT". With a connectionId the existing connection is re-authenticated;
 * otherwise a new connection is created only once sign-in succeeds, so an abandoned sign-in
 * leaves nothing behind.
 */
export async function startOpenAiSignIn(db: Db, opts: { connectionId?: string; userId?: string } = {}): Promise<{ flowId: string; authorizeUrl: string; connectionId: string | null }> {
  const existing = opts.connectionId ? getConnection(db, opts.connectionId) : undefined;
  if (opts.connectionId && !existing) throw new Error("Connection not found");
  const flow = register("openai", existing?.id ?? "");
  const { verifier, challenge } = pkcePair();
  const state = randomState();
  flow.server = await startLoopback({
    host: "localhost",
    port: OPENAI_CALLBACK_PORT,
    path: OPENAI_CALLBACK_PATH,
    state,
    onCode: async (code) => {
      const tokens = await openaiExchangeCode(code, verifier, flow.server!.redirectUri);
      const conn =
        existing ??
        createConnection(db, { userId: opts.userId ?? LOCAL_USER_ID, kind: "openai-chatgpt", sdk: "openai-chatgpt", catalogProviderId: "openai", label: "ChatGPT", authType: "oauth", status: "needs_signin", concurrency: 2 });
      flow.connectionId = conn.id;
      await saveOpenAiTokens(db, conn.id, tokens);
    },
  }).catch((err) => {
    flow.status = "error";
    flow.error = (err as Error).message;
    throw err;
  });
  track(flow);
  return { flowId: flow.id, authorizeUrl: openaiAuthorizeUrl({ redirectUri: flow.server.redirectUri, challenge, state }), connectionId: existing?.id ?? null };
}

async function saveOpenAiTokens(db: Db, connectionId: string, t: Awaited<ReturnType<typeof openaiExchangeCode>>) {
  await setSecret(connectionId, "access_token", t.accessToken);
  await setSecret(connectionId, "refresh_token", t.refreshToken);
  if (t.idToken) await setSecret(connectionId, "id_token", t.idToken);
  const acct = t.idToken ? openaiAccount(t.idToken) : null;
  const current = getConnection(db, connectionId);
  updateConnection(db, connectionId, {
    accountLabel: acct?.email ? `${acct.email}${acct.plan ? ` · ${acct.plan[0]!.toUpperCase()}${acct.plan.slice(1)}` : ""}` : current?.accountLabel,
    accountId: acct?.accountId ?? current?.accountId,
    tokenExpiresAt: t.expiresAt,
    status: "ok",
    lastError: null,
  });
}

/* ================================ Google ================================ */

export interface GoogleClientDetails {
  clientId: string;
  clientSecret: string;
  project: string;
  label?: string;
}

/**
 * Start Google sign-in for Gemini. Pass an existing connection id to re-authenticate it, or new
 * OAuth client details to create a connection once sign-in succeeds.
 */
export async function startGoogleSignIn(
  db: Db,
  target: string | GoogleClientDetails,
  userId = LOCAL_USER_ID,
): Promise<{ flowId: string; authorizeUrl: string; connectionId: string | null }> {
  const existing = typeof target === "string" ? getConnection(db, target) : undefined;
  if (typeof target === "string" && !existing) throw new Error("Connection not found");
  const clientId = existing?.googleClientId ?? (target as GoogleClientDetails).clientId;
  const clientSecret = existing ? await getSecret(existing.id, "client_secret") : (target as GoogleClientDetails).clientSecret;
  if (!clientId) throw new Error("Enter your OAuth client ID first");
  if (!clientSecret) throw new Error("Enter your OAuth client secret first");

  const flow = register("google", existing?.id ?? "");
  const { verifier, challenge } = pkcePair();
  const state = randomState();
  flow.server = await startLoopback({
    host: "127.0.0.1",
    port: 0,
    path: "/callback",
    state,
    onCode: async (code) => {
      const t = await googleExchangeCode({ clientId, clientSecret, code, verifier, redirectUri: flow.server!.redirectUri });
      let conn = existing;
      if (!conn) {
        const d = target as GoogleClientDetails;
        conn = createConnection(db, {
          userId,
          kind: "gemini-oauth",
          sdk: "google",
          catalogProviderId: "google",
          label: d.label?.trim() || "Gemini (Google sign-in)",
          authType: "oauth",
          googleClientId: clientId,
          googleProject: d.project,
          status: "needs_signin",
          concurrency: 2,
        });
        await setSecret(conn.id, "client_secret", clientSecret);
      }
      flow.connectionId = conn.id;
      await setSecret(conn.id, "access_token", t.accessToken);
      if (t.refreshToken) await setSecret(conn.id, "refresh_token", t.refreshToken);
      updateConnection(db, conn.id, { accountLabel: t.email ?? conn.accountLabel, tokenExpiresAt: t.expiresAt, status: "ok", lastError: null });
    },
  });
  track(flow);
  return { flowId: flow.id, authorizeUrl: googleAuthorizeUrl({ clientId, redirectUri: flow.server.redirectUri, challenge, state }), connectionId: existing?.id ?? null };
}

/* ============================== Token access ============================ */

export class SignInRequiredError extends Error {}

/**
 * A valid access token for an OAuth connection. Refreshes 2 minutes before expiry (or when
 * forced after a 401), serialized across processes with a DB lock because refresh tokens rotate.
 */
export async function getAccessToken(db: Db, connectionId: string, opts: { force?: boolean } = {}): Promise<string> {
  const fresh = (c: LlmConnection | undefined) => !!c?.tokenExpiresAt && new Date(c.tokenExpiresAt).getTime() - Date.now() > 120_000;
  let conn = getConnection(db, connectionId);
  if (!conn) throw new Error("Connection not found");
  if (!opts.force && fresh(conn)) {
    const token = await getSecret(conn.id, "access_token");
    if (token) return token;
  }

  const before = conn.tokenExpiresAt;
  if (!tryLockRefresh(db, conn.id)) {
    // Another process is refreshing. Wait for it to finish, then use its token.
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      conn = getConnection(db, connectionId);
      if (conn?.tokenExpiresAt !== before && fresh(conn)) {
        const token = await getSecret(connectionId, "access_token");
        if (token) return token;
      }
    }
    throw new Error("Timed out waiting for a token refresh");
  }
  try {
    const refreshToken = await getSecret(conn.id, "refresh_token");
    if (!refreshToken) throw new SignInRequiredError("Sign in again to continue");
    if (conn.sdk === "openai-chatgpt") {
      const t = await openaiRefresh(refreshToken);
      await saveOpenAiTokens(db, conn.id, t);
      return t.accessToken;
    }
    if (conn.sdk === "google") {
      const clientSecret = await getSecret(conn.id, "client_secret");
      if (!conn.googleClientId || !clientSecret) throw new SignInRequiredError("OAuth client details are missing");
      const t = await googleRefresh({ clientId: conn.googleClientId, clientSecret, refreshToken });
      await setSecret(conn.id, "access_token", t.accessToken);
      if (t.refreshToken) await setSecret(conn.id, "refresh_token", t.refreshToken);
      updateConnection(db, conn.id, { tokenExpiresAt: t.expiresAt, status: "ok", lastError: null });
      return t.accessToken;
    }
    throw new Error(`Connection ${conn.label} does not use sign-in`);
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof SignInRequiredError || /invalid_grant|refresh_token|expired|revoked/i.test(msg)) {
      updateConnection(db, connectionId, { status: "needs_signin", lastError: `Sign-in expired: ${msg}` });
      throw new SignInRequiredError(`Sign-in for this connection has expired. Sign in again on the Settings page. (${msg})`);
    }
    throw err;
  } finally {
    unlockRefresh(db, connectionId);
  }
}
