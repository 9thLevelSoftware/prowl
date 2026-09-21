import { WORKER_PORT } from "@prowl/shared";

/**
 * Worker control-API hardening (PR 3 / D-08).
 * Pure helpers so unit tests never boot the worker or launch Chrome.
 */

/** Only these web origins may talk to the control API / subscribe to events. */
export const CONTROL_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"] as const;

/**
 * Known `/browser/login` site keys → login URLs.
 * Unmapped tokens (including raw URLs) are rejected — never navigated.
 */
export const LOGIN_SITE_URLS: Record<string, string> = {
  linkedin: "https://www.linkedin.com/login",
  indeed: "https://secure.indeed.com/auth",
  workday: "https://www.myworkday.com",
  google: "https://accounts.google.com",
};

export type ResolveLoginSites =
  | { ok: true; keys: string[]; urls: string[] }
  | { ok: false; error: string };

/** Map a `sites` query value to known keys only. Rejects raw URLs and unknown tokens. */
export function resolveLoginSites(sitesParam: string | null | undefined): ResolveLoginSites {
  const raw = (sitesParam ?? "linkedin,indeed")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!raw.length) return { ok: false, error: "sites must name known login keys" };
  const keys: string[] = [];
  const urls: string[] = [];
  for (const key of raw) {
    const url = LOGIN_SITE_URLS[key];
    if (!url) return { ok: false, error: `unknown login site: ${key}` };
    keys.push(key);
    urls.push(url);
  }
  return { ok: true, keys, urls };
}

/** Host must be the loopback worker (DNS-rebinding defense). */
export function isAllowedControlHost(host: string | string[] | undefined, workerPort = WORKER_PORT): boolean {
  const h = (Array.isArray(host) ? host[0] : host)?.trim().toLowerCase();
  if (!h) return false;
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === `127.0.0.1:${workerPort}` ||
    h === `localhost:${workerPort}`
  );
}

/**
 * Origin policy for control POSTs:
 * - missing Origin is allowed (loopback server actions via Node fetch do not send it)
 * - present Origin must be a known web origin
 */
export function isAllowedControlOrigin(origin: string | string[] | undefined): boolean {
  const o = Array.isArray(origin) ? origin[0] : origin?.trim();
  if (!o) return true;
  return (CONTROL_ALLOWED_ORIGINS as readonly string[]).includes(o);
}

export type ControlPostCheck = { ok: true } | { ok: false; error: string };

/** CSRF/rebinding gate for control-API POSTs. */
export function checkControlPost(
  req: { origin?: string | string[] | undefined; host?: string | string[] | undefined },
  workerPort = WORKER_PORT,
): ControlPostCheck {
  if (!isAllowedControlHost(req.host, workerPort)) return { ok: false, error: "forbidden host" };
  if (!isAllowedControlOrigin(req.origin)) return { ok: false, error: "forbidden origin" };
  return { ok: true };
}

/** CORS value for responses: echo a known web origin, never `*`. */
export function controlCorsOrigin(origin: string | string[] | undefined): string | undefined {
  const o = Array.isArray(origin) ? origin[0] : origin?.trim();
  if (!o) return undefined;
  return (CONTROL_ALLOWED_ORIGINS as readonly string[]).includes(o) ? o : undefined;
}
