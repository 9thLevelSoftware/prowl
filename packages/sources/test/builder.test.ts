import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Preferences, ProfileData } from "@jh/shared";

/* Mock Greenhouse, Lever, Ashby, a company careers page, and a Firecrawl server. */
const gh: Record<string, { name: string; content: string; jobs: { id: number; title: string }[] }> = {
  acmepay: { name: "AcmePay", content: '<a href="https://acmepay.com">AcmePay</a>', jobs: [{ id: 1, title: "Senior Backend Engineer" }, { id: 2, title: "Legal Counsel" }] },
  nova: { name: "Nova Rentals", content: "Car rentals", jobs: [{ id: 3, title: "Backend Engineer" }] },
};
const lever: Record<string, { text: string; descriptionPlain: string }[]> = {
  ledgerly: [{ text: "Staff Backend Engineer", descriptionPlain: "Ledgerly builds accounting APIs. At Ledgerly we value craft." }],
};
const ashby: Record<string, { title: string }[]> = { orbit: [{ title: "Platform Engineer" }] };
let careersHits = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  let m = url.pathname.match(/^\/gh\/boards\/([^/]+)(\/jobs)?$/);
  if (m) {
    const b = gh[m[1]!];
    if (!b) return json(404, { error: "not found" });
    if (!m[2]) return json(200, { name: b.name, content: b.content });
    return json(200, { jobs: b.jobs.map((j) => ({ id: j.id, title: j.title, absolute_url: `https://x/${j.id}`, updated_at: "2026-01-01", location: { name: "Remote" }, content: "desc" })) });
  }
  m = url.pathname.match(/^\/lever\/postings\/([^/]+)$/);
  if (m) {
    const b = lever[m[1]!];
    if (!b) return json(404, { ok: false, error: "Document not found" });
    return json(200, b.map((p, i) => ({ id: `l${i}`, text: p.text, hostedUrl: `https://jobs.lever.co/${m![1]}/l${i}`, applyUrl: `https://jobs.lever.co/${m![1]}/l${i}/apply`, createdAt: 1, descriptionPlain: p.descriptionPlain, categories: { location: "Remote" } })));
  }
  m = url.pathname.match(/^\/ashby\/job-board\/([^/]+)$/);
  if (m) {
    const b = ashby[m[1]!];
    if (!b) return json(404, "Not Found");
    return json(200, { apiVersion: 1, jobs: b.map((j, i) => ({ id: `a${i}`, title: j.title, location: "Remote", isListed: true, jobUrl: `https://jobs.ashbyhq.com/${m![1]}/a${i}`, applyUrl: `https://jobs.ashbyhq.com/${m![1]}/a${i}/application`, descriptionPlain: "desc" })) });
  }
  if (url.pathname === "/v2/scrape") return json(404, { error: "no v2" });
  if (url.pathname === "/v1/scrape") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      careersHits++;
      const target = String(JSON.parse(raw || "{}").url ?? "");
      const html = target.includes("novalabs.dev") ? '<script src="https://boards.greenhouse.io/embed/job_board/js?for=nova"></script>' : "<h1>Careers</h1>";
      json(200, { success: true, data: { rawHtml: html, markdown: "Example", links: [] } });
    });
    return;
  }
  if (url.pathname === "/v1/map") return json(200, { success: true, links: ["https://example.com/a"] });
  if (url.pathname === "/v1/search") return json(200, { success: true, data: [{ url: "https://jobs.ashbyhq.com/orbit/a0", title: "Platform Engineer", description: "" }] });
  res.writeHead(404).end();
});

let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JH_GREENHOUSE_API = `${base}/gh`;
  process.env.JH_LEVER_API = `${base}/lever`;
  process.env.JH_ASHBY_API = `${base}/ashby`;
  process.env.JH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jh-builder-"));
  delete process.env.ADZUNA_APP_ID;
});
afterAll(() => server.close());

const profile = ProfileData.parse({ work: [{ id: "w1", company: "Paylane", title: "Senior Software Engineer", startDate: "2020", endDate: "present", bullets: [] }] });
const prefs = Preferences.parse({ targetTitles: ["Backend Engineer"], locations: ["Austin"], companyExclude: ["Blocked Co"] });

describe("slugs and identity", () => {
  it("builds slug variants and matches company names", async () => {
    const b = await import("../src/builder");
    expect(b.slugVariants("Acme Pay, Inc.", "acmepay.com", ["acme-pay"])[0]).toBe("acme-pay");
    expect(b.namesMatch("Stripe", "Stripe Payments")).toBe(true);
    expect(b.slugVariants("Acme Pay, Inc.", "acmepay.com")).toContain("acmepay");
    expect(b.namesMatch("AcmePay Inc.", "Acme Pay")).toBe(true);
    expect(b.namesMatch("Nova Rentals", "Nova Labs")).toBe(false);
    expect(b.domainRoot("https://www.ledgerly.io/careers")).toBe("ledgerly");
  });
});

describe("buildSources", () => {
  it("verifies boards, flags wrong-company slug collisions, finds careers-page embeds, and learns boards", async () => {
    const { openDb, runMigrations, listSuggestions, schema: s } = await import("@jh/db");
    const b = await import("../src/builder");
    const { Firecrawl } = await import("../src/web/firecrawl");
    const db = openDb(path.join(process.env.JH_DATA_DIR!, "b.sqlite"));
    runMigrations(db);
    // A job already found through another source points at a Lever board.
    db.insert(s.jobs).values({ sourceType: "adzuna", externalId: "x", dedupKey: "x", title: "Staff Backend Engineer", company: "Ledgerly", applyUrl: "https://jobs.lever.co/ledgerly/l0/apply", atsType: "lever" }).run();

    const llm = {
      async object() {
        return {
          companies: [
            { name: "AcmePay", domain: "acmepay.com", why: "Payments", slugGuesses: [] },
            { name: "Nova Labs", domain: "novalabs.dev", why: "Infra", slugGuesses: ["nova"] },
            { name: "Blocked Co", domain: "blocked.co", why: "x", slugGuesses: [] },
            { name: "Paylane", domain: "paylane.com", why: "current employer", slugGuesses: [] },
            { name: "Ghost Corp", domain: "ghost.example", why: "none", slugGuesses: [] },
          ],
        };
      },
    };
    const webSearch = { provider: "firecrawl" as const, findUrls: async () => ["https://jobs.ashbyhq.com/orbit/a0", "https://example.com/not-a-board"] };
    const progress: string[] = [];
    const result = await b.buildSources(db, { runId: "run1", profile, prefs, hints: { pursue: [], avoid: [], industries: [], stageOrSize: [] }, llm: llm as any, webSearch, firecrawl: new Firecrawl(base, null), progress: (m) => progress.push(m) });

    const rows = listSuggestions(db, ["verified", "unconfirmed", "not_found"]);
    const by = Object.fromEntries(rows.map((r) => [r.company, r]));
    // Verified via Greenhouse name match; 1 of 2 jobs matches the title filter.
    expect(by.AcmePay).toMatchObject({ status: "verified", type: "greenhouse", jobsOpen: 2, jobsMatching: 1, sampleTitles: ["Senior Backend Engineer"] });
    // Guessing "nova" hits a Greenhouse board named "Nova Rentals", which is not confirmed as Nova Labs.
    // Nova Labs' own careers page embeds that board, so it is verified that way instead.
    expect(rows.find((r) => r.key === "greenhouse:nova")).toMatchObject({ status: "verified", company: "Nova Labs" });
    // Learned from an existing job, and found by web search.
    expect(by.Ledgerly).toMatchObject({ origin: "learned", status: "verified", type: "lever" });
    // "Platform Engineer" does not match the "Backend Engineer" target: open, but not matching.
    expect(rows.find((r) => r.key === "ashby:orbit")).toMatchObject({ origin: "web_search", status: "verified", jobsOpen: 1, jobsMatching: 0 });
    // Avoided and current-employer companies are never suggested; unknown ones fall back to careers page.
    expect(by["Blocked Co"]).toBeUndefined();
    expect(by.Paylane).toBeUndefined();
    expect(by["Ghost Corp"]).toMatchObject({ status: "not_found", type: "careerpage" });
    expect(result.verified).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toMatch(/^Done:/);
    expect(careersHits).toBeGreaterThan(0);

    // Re-running keeps dismissed suggestions dismissed.
    db.update(s.sourceSuggestions).set({ status: "dismissed" }).where((await import("@jh/db")).eq(s.sourceSuggestions.key, "greenhouse:acmepay")).run();
    await b.buildSources(db, { runId: "run2", profile, prefs, hints: { pursue: [], avoid: [], industries: [], stageOrSize: [] }, llm: llm as any, webSearch, firecrawl: null, progress: () => undefined });
    expect(listSuggestions(db, ["dismissed"]).map((r) => r.key)).toEqual(["greenhouse:acmepay"]);
  });
});

describe("Firecrawl client", () => {
  it("falls back from v2 to v1 and reports capabilities", async () => {
    const { Firecrawl } = await import("../src/web/firecrawl");
    const fc = new Firecrawl(base, null);
    const caps = await fc.capabilities();
    expect(caps).toMatchObject({ reachable: true, version: "v1", scrape: true, map: true, search: true });
    const down = await new Firecrawl("http://127.0.0.1:9", null).capabilities();
    expect(down.reachable).toBe(false);
  });
  it("turns board tokens into readable company names", async () => {
    const { prettyToken } = await import("../src/builder");
    expect(prettyToken("canarytechnologies")).toBe("Canary Technologies");
    expect(prettyToken("momenti-inc")).toBe("Momenti Inc");
    expect(prettyToken("bluefishai")).toBe("Bluefish AI");
    expect(prettyToken("stripe")).toBe("Stripe");
  });
});
