import { describe, expect, it } from "vitest";
import {
  CONTROL_ALLOWED_ORIGINS,
  LOGIN_SITE_URLS,
  checkControlPost,
  controlCorsOrigin,
  isAllowedControlHost,
  isAllowedControlOrigin,
  resolveLoginSites,
} from "../src/control";

const WEB = "http://localhost:3000";
const WORKER_HOST = "127.0.0.1:3031";

describe("resolveLoginSites allowlist", () => {
  it("maps known keys to fixed login URLs", () => {
    const r = resolveLoginSites("linkedin,indeed");
    expect(r).toEqual({
      ok: true,
      keys: ["linkedin", "indeed"],
      urls: [LOGIN_SITE_URLS.linkedin, LOGIN_SITE_URLS.indeed],
    });
  });

  it("defaults to linkedin,indeed when sites is omitted", () => {
    const r = resolveLoginSites(null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.keys).toEqual(["linkedin", "indeed"]);
  });

  it("rejects raw URLs — never treated as navigable sites", () => {
    for (const sites of [
      "https://attacker.example",
      "http://evil.test/login",
      "https://www.linkedin.com/login",
      "linkedin,https://attacker.example",
      "//evil.example",
    ]) {
      const r = resolveLoginSites(sites);
      expect(r.ok, sites).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/unknown login site/);
    }
  });

  it("rejects unknown tokens and empty site lists", () => {
    expect(resolveLoginSites("facebook").ok).toBe(false);
    expect(resolveLoginSites("").ok).toBe(false);
    expect(resolveLoginSites(" , ").ok).toBe(false);
  });

  it("accepts workday and google keys case-insensitively with whitespace", () => {
    const r = resolveLoginSites(" LinkedIn , Workday ");
    expect(r).toEqual({
      ok: true,
      keys: ["linkedin", "workday"],
      urls: [LOGIN_SITE_URLS.linkedin, LOGIN_SITE_URLS.workday],
    });
  });
});

describe("control POST Origin/Host gate", () => {
  it("allows loopback host with no Origin (web server actions via Node fetch)", () => {
    expect(checkControlPost({ host: WORKER_HOST })).toEqual({ ok: true });
    expect(checkControlPost({ host: WORKER_HOST, origin: undefined })).toEqual({ ok: true });
  });

  it("allows known web origins", () => {
    for (const origin of CONTROL_ALLOWED_ORIGINS) {
      expect(checkControlPost({ host: WORKER_HOST, origin })).toEqual({ ok: true });
      expect(checkControlPost({ host: "localhost:3031", origin })).toEqual({ ok: true });
    }
  });

  it("rejects unexpected Origin (cross-origin POST)", () => {
    for (const origin of ["http://attacker.example", "https://localhost:3000", "null", "http://127.0.0.1:3001", "http://evil.test:3000"]) {
      const r = checkControlPost({ host: WORKER_HOST, origin });
      expect(r.ok, origin).toBe(false);
      if (!r.ok) expect(r.error).toBe("forbidden origin");
    }
  });

  it("rejects unexpected Host (DNS rebinding / wrong port)", () => {
    for (const host of ["attacker.example", "evil.test:3031", "127.0.0.1:9999", "localhost:80", undefined, ""]) {
      const r = checkControlPost({ host, origin: WEB });
      expect(r.ok, String(host)).toBe(false);
      if (!r.ok) expect(r.error).toBe("forbidden host");
    }
  });

  it("rejects when both Origin and Host are bad", () => {
    const r = checkControlPost({ host: "attacker.example", origin: "http://attacker.example" });
    expect(r.ok).toBe(false);
  });
});

describe("host/origin predicates", () => {
  it("isAllowedControlHost accepts loopback worker hosts", () => {
    expect(isAllowedControlHost("127.0.0.1:3031")).toBe(true);
    expect(isAllowedControlHost("localhost:3031")).toBe(true);
    expect(isAllowedControlHost("127.0.0.1")).toBe(true);
    expect(isAllowedControlHost("LOCALHOST")).toBe(true);
  });

  it("isAllowedControlOrigin allows missing, rejects unknown", () => {
    expect(isAllowedControlOrigin(undefined)).toBe(true);
    expect(isAllowedControlOrigin("")).toBe(true);
    expect(isAllowedControlOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedControlOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isAllowedControlOrigin("http://evil.example")).toBe(false);
  });
});

describe("CORS is never *", () => {
  it("controlCorsOrigin echoes only known web origins", () => {
    expect(controlCorsOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(controlCorsOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(controlCorsOrigin("http://attacker.example")).toBeUndefined();
    expect(controlCorsOrigin("*")).toBeUndefined();
    expect(controlCorsOrigin(undefined)).toBeUndefined();
  });

  it("allowed origin list does not include wildcard", () => {
    expect(CONTROL_ALLOWED_ORIGINS).not.toContain("*");
    expect([...CONTROL_ALLOWED_ORIGINS].every((o) => o.startsWith("http://127.0.0.1:3000") || o.startsWith("http://localhost:3000"))).toBe(true);
  });
});
