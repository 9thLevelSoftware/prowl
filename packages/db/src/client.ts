import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { dataPath, LOCAL_USER_ID, REPO_ROOT } from "@prowl/shared";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const globalForDb = globalThis as unknown as { __prowlDb?: Db };

export function dbFilePath(): string {
  return process.env.PROWL_DB_PATH ?? dataPath("prowl.sqlite");
}

function migrationsFolder(): string {
  // Works from source (tsx/next transpile) and from the repo root.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const p = path.join(here, "..", "drizzle");
    if (fs.existsSync(p)) return p;
  } catch {
    /* import.meta.url unavailable in some bundles */
  }
  return path.join(REPO_ROOT, "packages", "db", "drizzle");
}

export function openDb(file = dbFilePath()): Db {
  const sqlite = new Database(file);
  // Web and worker are separate processes sharing one file: WAL + busy timeout avoid SQLITE_BUSY.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  return drizzle(sqlite, { schema }) as Db;
}

/** Process-wide singleton (survives Next.js dev hot reload). */
export function getDb(): Db {
  if (!globalForDb.__prowlDb) globalForDb.__prowlDb = openDb();
  return globalForDb.__prowlDb;
}

export function runMigrations(db: Db = getDb()): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
  db.insert(schema.users).values({ id: LOCAL_USER_ID, displayName: "Local user" }).onConflictDoNothing().run();
}
