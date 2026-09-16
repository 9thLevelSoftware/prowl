import crypto from "node:crypto";

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function decodeJwt(token: string | undefined | null): Record<string, any> {
  const part = token?.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}
