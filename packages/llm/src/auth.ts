import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * Bearer-token sources for OAuth-based providers. Credentials are never stored by this app;
 * we read whatever a trusted CLI login (or a user-supplied command) already produced.
 *
 * Resolution order: JH_LLM_ACCESS_TOKEN -> JH_LLM_TOKEN_CMD -> JH_LLM_TOKEN_FILE.
 */

export interface BearerToken {
  accessToken: string;
  /** Epoch ms; undefined when unknown. */
  expiresAt?: number;
  /** ChatGPT account id, needed by the ChatGPT backend. */
  accountId?: string;
}

export class TokenUnavailableError extends Error {}

let cached: BearerToken | undefined;

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function jwtExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Understands the common shapes: Codex CLI auth.json, Gemini CLI oauth_creds.json, gcloud-style, or a bare token. */
export function parseTokenFile(raw: string): BearerToken {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { accessToken: trimmed, expiresAt: jwtExpiry(trimmed) };
  const j = JSON.parse(trimmed) as Record<string, any>;
  const tokens = (j.tokens ?? j.token ?? j) as Record<string, any>;
  const accessToken: string | undefined = tokens.access_token ?? tokens.accessToken ?? j.access_token;
  if (!accessToken) throw new TokenUnavailableError("Token file has no access_token field");
  const expiryRaw = tokens.expiry_date ?? tokens.expires_at ?? j.expiry_date ?? j.expiry;
  let expiresAt: number | undefined;
  if (typeof expiryRaw === "number") expiresAt = expiryRaw < 1e12 ? expiryRaw * 1000 : expiryRaw;
  else if (typeof expiryRaw === "string") expiresAt = Date.parse(expiryRaw) || undefined;
  expiresAt ??= jwtExpiry(accessToken);
  return { accessToken, expiresAt, accountId: tokens.account_id ?? j.account_id };
}

function isFresh(t: BearerToken | undefined): t is BearerToken {
  if (!t) return false;
  if (!t.expiresAt) return true;
  return t.expiresAt - Date.now() > 60_000;
}

export function getBearerToken(opts: { forceRefresh?: boolean } = {}): BearerToken {
  if (!opts.forceRefresh && isFresh(cached)) return cached;

  const direct = process.env.JH_LLM_ACCESS_TOKEN?.trim();
  if (direct) {
    cached = { accessToken: direct, expiresAt: jwtExpiry(direct) };
    return cached;
  }

  const cmd = process.env.JH_LLM_TOKEN_CMD?.trim();
  if (cmd) {
    let out: string;
    try {
      out = execSync(cmd, { encoding: "utf8", timeout: 30_000, windowsHide: true }).trim();
    } catch (err) {
      throw new TokenUnavailableError(`JH_LLM_TOKEN_CMD failed: ${(err as Error).message}`);
    }
    const parsed = parseTokenFile(out);
    // Command output rarely carries an expiry; assume 45 minutes so we re-run it well before a 1h token lapses.
    cached = { ...parsed, expiresAt: parsed.expiresAt ?? Date.now() + 45 * 60_000 };
    return cached;
  }

  const file = process.env.JH_LLM_TOKEN_FILE?.trim();
  if (file) {
    const p = expandHome(file);
    if (!fs.existsSync(p)) throw new TokenUnavailableError(`JH_LLM_TOKEN_FILE not found: ${p}`);
    const parsed = parseTokenFile(fs.readFileSync(p, "utf8"));
    if (!isFresh(parsed)) {
      throw new TokenUnavailableError(
        `The access token in ${p} has expired. Re-run the CLI that wrote it (for example \`codex login\` or \`gemini\`) to refresh it, or set JH_LLM_TOKEN_CMD to a command that prints a fresh token.`,
      );
    }
    cached = parsed;
    return cached;
  }

  throw new TokenUnavailableError(
    "No OAuth credentials configured. Set JH_LLM_TOKEN_CMD, JH_LLM_TOKEN_FILE, or JH_LLM_ACCESS_TOKEN (see .env.example).",
  );
}

export function clearTokenCache(): void {
  cached = undefined;
}

type FetchLike = typeof globalThis.fetch;

/**
 * Wrap fetch to inject a bearer token, retrying once with a refreshed token on 401.
 * `mutate` can rewrite headers/body for providers with non-standard requirements.
 */
export function bearerFetch(mutate?: (init: { headers: Headers; body: unknown; token: BearerToken }) => { body?: unknown }): FetchLike {
  const doFetch = async (input: Parameters<FetchLike>[0], init: RequestInit | undefined, refresh: boolean): Promise<Response> => {
    const token = getBearerToken({ forceRefresh: refresh });
    const headers = new Headers(init?.headers);
    headers.delete("x-goog-api-key");
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${token.accessToken}`);
    let body = init?.body;
    if (mutate) {
      const res = mutate({ headers, body, token });
      if (res.body !== undefined) body = res.body as BodyInit;
    }
    return globalThis.fetch(input, { ...init, headers, body: body as BodyInit | null | undefined });
  };
  return (async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
    const res = await doFetch(input, init, false);
    if (res.status !== 401) return res;
    clearTokenCache();
    return doFetch(input, init, true);
  }) as FetchLike;
}
