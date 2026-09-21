import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@prowl/shared";
import { closeDb, dbFilePath } from "./client";

/** Directories under the data dir that Settings → Delete all data removes. `models` is the local embedding-model cache. */
export const WIPE_DATA_DIRS = ["documents", "evidence", "browser-profile", "models"] as const;

/**
 * Absolute paths the wipe should remove: SQLite (+ WAL/SHM), secret material, and the
 * embedding-model cache. The OS keychain master-key entry (service `prowl`) lives **outside**
 * the data dir and is not in this list — see packages/llm/src/secrets.ts.
 */
export function localWipeTargets(): string[] {
  const file = dbFilePath();
  const dir = dataDir();
  const secretsJson = process.env.PROWL_SECRETS_FILE ?? path.join(dir, "secrets.json");
  return [
    file,
    `${file}-wal`,
    `${file}-shm`,
    path.join(dir, "secrets.key"),
    secretsJson,
    ...WIPE_DATA_DIRS.map((d) => path.join(dir, d)),
  ];
}

/**
 * Best-effort local wipe used by Settings → Delete all data.
 * Closes this process's SQLite handle first so `prowl.sqlite` (+ wal/shm) can be unlinked.
 * Locks held by another process (the worker) may leave files in place; callers should still
 * clear table rows before calling this. Returns paths that were present and removed.
 */
export function wipeLocalFiles(): string[] {
  closeDb();
  const removed: string[] = [];
  for (const p of localWipeTargets()) {
    try {
      if (!fs.existsSync(p)) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch {
      // Locked by another process or permission denied — best effort.
    }
  }
  return removed;
}
