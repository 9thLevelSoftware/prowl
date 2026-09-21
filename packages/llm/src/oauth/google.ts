import { decodeJwt } from "./pkce";

/*
 * Official Gemini API OAuth (ai.google.dev/gemini-api/docs/oauth) with the user's own
 * "Desktop app" OAuth client. Desktop clients accept any loopback port.
 */

export const googleAuthUrl = () => process.env.PROWL_GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
export const googleTokenUrl = () => process.env.PROWL_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
export const GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generative-language.retriever",
  "openid",
  "email",
];

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  email: string | null;
}

export function googleAuthorizeUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: GEMINI_SCOPES.join(" "),
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${googleAuthUrl()}?${q}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(googleTokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status}): ${json.error_description ?? json.error ?? "unknown error"}`);
  return json;
}

const toTokens = (j: Record<string, any>, previousRefresh: string | null): GoogleTokens => ({
  accessToken: j.access_token,
  refreshToken: j.refresh_token ?? previousRefresh,
  expiresAt: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString(),
  email: (decodeJwt(j.id_token).email as string | undefined) ?? null,
});

export async function googleExchangeCode(p: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string }): Promise<GoogleTokens> {
  const j = await tokenRequest({
    grant_type: "authorization_code",
    code: p.code,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri,
  });
  return toTokens(j, null);
}

export async function googleRefresh(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<GoogleTokens> {
  const j = await tokenRequest({ grant_type: "refresh_token", client_id: p.clientId, client_secret: p.clientSecret, refresh_token: p.refreshToken });
  return toTokens(j, p.refreshToken);
}
