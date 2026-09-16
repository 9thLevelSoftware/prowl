import { decodeJwt } from "./pkce";

/*
 * ChatGPT sign-in, the same OAuth flow Codex uses (learn.chatgpt.com/docs/auth).
 * The client's registered redirect is http://localhost:1455/auth/callback.
 */

export const OPENAI_CLIENT_ID = process.env.JH_OPENAI_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
export const openaiAuthBase = () => process.env.JH_OPENAI_AUTH_BASE ?? "https://auth.openai.com";
export const OPENAI_CALLBACK_PORT = Number(process.env.JH_OPENAI_OAUTH_PORT ?? 1455);
export const OPENAI_CALLBACK_PATH = "/auth/callback";
export const CHATGPT_BASE_URL = process.env.JH_CHATGPT_BASE_URL ?? "https://chatgpt.com/backend-api/codex";

export interface OpenAiTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export function openaiAuthorizeUrl(p: { redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: p.redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });
  return `${openaiAuthBase()}/oauth/authorize?${q}`;
}

function expiry(accessToken: string, expiresIn?: number): string {
  const exp = decodeJwt(accessToken).exp as number | undefined;
  const ms = exp ? exp * 1000 : Date.now() + (expiresIn ?? 3600) * 1000;
  return new Date(ms).toISOString();
}

async function tokenRequest(body: Record<string, string>, form: boolean): Promise<Record<string, any>> {
  const res = await fetch(`${openaiAuthBase()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`OpenAI sign-in failed (${res.status}): ${json.error_description ?? json.error?.message ?? json.error ?? "unknown error"}`);
  return json;
}

export async function openaiExchangeCode(code: string, verifier: string, redirectUri: string): Promise<OpenAiTokens> {
  const j = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: OPENAI_CLIENT_ID, code_verifier: verifier }, true);
  return { idToken: j.id_token, accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: expiry(j.access_token, j.expires_in) };
}

export async function openaiRefresh(refreshToken: string): Promise<OpenAiTokens> {
  const j = await tokenRequest({ client_id: OPENAI_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }, false);
  return {
    idToken: j.id_token,
    accessToken: j.access_token,
    // Refresh tokens rotate; keep the old one only if a new one wasn't issued.
    refreshToken: j.refresh_token ?? refreshToken,
    expiresAt: expiry(j.access_token, j.expires_in),
  };
}

export function openaiAccount(idToken: string): { email: string | null; accountId: string | null; plan: string | null } {
  const c = decodeJwt(idToken);
  const auth = (c["https://api.openai.com/auth"] ?? {}) as Record<string, any>;
  return { email: c.email ?? null, accountId: auth.chatgpt_account_id ?? null, plan: auth.chatgpt_plan_type ?? null };
}
