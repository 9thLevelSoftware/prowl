import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, dbFilePath, getDb, localWipeTargets, runMigrations, schema, wipeLocalFiles } from "../src";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-wipe-"));
process.env.PROWL_DATA_DIR = tmp;
delete process.env.PROWL_DB_PATH;
delete process.env.PROWL_SECRETS_FILE;

/** Placeholder bytes only — fixtures must never carry real credentials. */
const FIXTURES: Array<[string, string]> = [
  ["secrets.key", "00ff-placeholder-not-a-real-key"],
  ["secrets.json", '{"conn/api_key":{"iv":"x","tag":"y","data":"z"}}'],
  ["models/Xenova/all-MiniLM-L6-v2/model.bin", "embedding-cache-bytes"],
  ["documents/baseline/abc/Resume.pdf", "%PDF-1.4 resume"],
  ["evidence/app-1/1700000000-before.jpg", "jpeg-bytes"],
  ["browser-profile/Default/Cookies", "cookie-bytes"],
  ["catalog/models-dev.json", "{}"],
];

function writeRel(rel: string, body: string): string {
  const abs = path.join(tmp, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

function abs(rel: string): string {
  return path.join(tmp, ...rel.split("/"));
}

beforeEach(() => {
  closeDb();
  for (const entry of fs.readdirSync(tmp)) {
    fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
  }
});

describe("localWipeTargets", () => {
  it("covers sqlite (+wal/shm), secrets.key/json, embedding cache, and data dirs", () => {
    const dbFile = dbFilePath();
    const targets = localWipeTargets();
    expect(targets).toContain(dbFile);
    expect(targets).toContain(`${dbFile}-wal`);
    expect(targets).toContain(`${dbFile}-shm`);
    expect(targets).toContain(abs("secrets.key"));
    expect(targets).toContain(abs("secrets.json"));
    expect(targets).toContain(abs("models"));
    expect(targets).toContain(abs("documents"));
    expect(targets).toContain(abs("evidence"));
    expect(targets).toContain(abs("browser-profile"));
    // OS keychain entry is outside the data dir — never a wipe target.
    expect(targets.every((t) => !t.includes("keychain") && !t.endsWith("prowl/master-key"))).toBe(true);
  });
});

describe("wipeLocalFiles", () => {
  it("closes the DB handle and removes secrets, sqlite files, embedding cache, and data dirs", () => {
    for (const [rel, body] of FIXTURES) writeRel(rel, body);
    const db = getDb();
    runMigrations(db);
    db.insert(schema.users).values({ id: "local", displayName: "Local user" }).onConflictDoNothing().run();
    db.insert(schema.profiles)
      .values({ userId: "local", version: 1, isActive: true, data: { fullName: "Wipe Fixture" } as never })
      .run();
    expect(fs.existsSync(dbFilePath())).toBe(true);
    expect(fs.existsSync(abs("secrets.key"))).toBe(true);

    const removed = wipeLocalFiles();

    expect(removed).toContain(dbFilePath());
    expect(removed).toContain(abs("secrets.key"));
    expect(removed).toContain(abs("secrets.json"));
    expect(removed).toContain(abs("models"));
    expect(removed).toContain(abs("documents"));
    expect(removed).toContain(abs("evidence"));
    expect(removed).toContain(abs("browser-profile"));

    for (const p of [
      dbFilePath(),
      `${dbFilePath()}-wal`,
      `${dbFilePath()}-shm`,
      abs("secrets.key"),
      abs("secrets.json"),
      abs("models"),
      abs("documents"),
      abs("evidence"),
      abs("browser-profile"),
    ]) {
      expect(fs.existsSync(p), p).toBe(false);
    }

    // Catalog cache is derived data, not secrets — left alone by this wipe.
    expect(fs.existsSync(abs("catalog/models-dev.json"))).toBe(true);

    // Next getDb() opens a fresh file; runMigrations rebuilds schema.
    const fresh = getDb();
    runMigrations(fresh);
    const profiles = fresh.select().from(schema.profiles).all();
    expect(profiles).toEqual([]);
  });

  it("is safe when nothing exists yet", () => {
    const removed = wipeLocalFiles();
    expect(removed).toEqual([]);
  });

  it("fixtures contain no credential-shaped values", () => {
    for (const [rel, body] of FIXTURES) {
      expect(body, rel).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
      expect(body, rel).not.toMatch(/-----BEGIN/);
      expect(body, rel).not.toMatch(/Bearer\s+\S{20,}/);
    }
  });
});
