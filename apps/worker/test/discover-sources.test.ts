import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@prowl/db";

process.env.PROWL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-pr8-worker-"));
process.env.PROWL_SECRETS_NO_KEYCHAIN = "1";
process.env.PROWL_CATALOG_OFFLINE = "1";
process.env.PROWL_BROWSER_CHANNEL = "chromium";

const mockDiscover = vi.fn();

vi.mock("@prowl/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prowl/sources")>();
  return {
    ...actual,
    getAdapter: () => ({
      label: "Career page",
      validate: (cfg: Record<string, unknown>) => cfg,
      discover: mockDiscover,
    }),
    Firecrawl: {
      fromSettings: async () => null,
    },
  };
});

const { openDb, runMigrations, schema: s, eq } = await import("@prowl/db");
const { LlmClient } = await import("@prowl/llm");
const { handleDiscoverSource } = await import("../src/handlers");

let db: Db;

beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prowl-pr8-w-")), "t.sqlite"));
  runMigrations(db);
  mockDiscover.mockReset();
});

function seedCareerSource() {
  return db
    .insert(s.jobSources)
    .values({
      userId: "local",
      type: "careerpage",
      name: "Acme careers",
      config: { companyName: "Acme", careersUrl: "https://acme.example/careers" },
      enabled: true,
    })
    .returning()
    .get();
}

describe("system discoveredSources dual contract (PR8)", () => {
  it("system career-page discoveredSources insert enabled:false", async () => {
    const src = seedCareerSource();
    mockDiscover.mockResolvedValue({
      jobs: [],
      discoveredSources: [
        { type: "greenhouse", name: "Acme (greenhouse)", config: { boardToken: "acme", companyName: "Acme" } },
        { type: "ashby", name: "Acme (ashby)", config: { org: "acme", companyName: "Acme" } },
      ],
    });

    const llm = new LlmClient(db);
    const task = {
      id: "t1",
      userId: "local",
      type: "discover_source",
      payload: { sourceId: src.id },
      status: "running",
      priority: 100,
      attempts: 0,
      maxAttempts: 2,
      runAfter: new Date().toISOString(),
      lockedBy: null,
      lockedAt: null,
      lastError: null,
      dedupKey: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Parameters<typeof handleDiscoverSource>[2];
    await handleDiscoverSource(db, llm, task);

    const sources = db.select().from(s.jobSources).where(eq(s.jobSources.type, "greenhouse")).all();
    const ashby = db.select().from(s.jobSources).where(eq(s.jobSources.type, "ashby")).all();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.enabled).toBe(false);
    expect(ashby).toHaveLength(1);
    expect(ashby[0]!.enabled).toBe(false);
  });

  it("does not re-enable an existing disabled system source on rediscovery", async () => {
    const src = seedCareerSource();
    db.insert(s.jobSources).values({ userId: "local", type: "greenhouse", name: "Acme (greenhouse)", config: { boardToken: "acme", companyName: "Acme" }, enabled: false }).run();
    mockDiscover.mockResolvedValue({
      jobs: [],
      discoveredSources: [{ type: "greenhouse", name: "Acme (greenhouse)", config: { boardToken: "acme", companyName: "Acme" } }],
    });

    const llm = new LlmClient(db);
    const task = {
      id: "t2",
      userId: "local",
      type: "discover_source",
      payload: { sourceId: src.id },
      status: "running",
      priority: 100,
      attempts: 0,
      maxAttempts: 2,
      runAfter: new Date().toISOString(),
      lockedBy: null,
      lockedAt: null,
      lastError: null,
      dedupKey: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Parameters<typeof handleDiscoverSource>[2];
    await handleDiscoverSource(db, llm, task);

    const gh = db.select().from(s.jobSources).where(eq(s.jobSources.type, "greenhouse")).all();
    expect(gh).toHaveLength(1);
    expect(gh[0]!.enabled).toBe(false);
  });
});
