import path from "node:path";
import fs from "node:fs";

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export const REPO_ROOT = findRepoRoot(process.cwd());

export function dataDir(): string {
  const configured = process.env.PROWL_DATA_DIR ?? "./data";
  const dir = path.isAbsolute(configured) ? configured : path.join(REPO_ROOT, configured);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve a path under the data dir, creating parent directories. */
export function dataPath(...parts: string[]): string {
  const p = path.join(dataDir(), ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

export const LOCAL_USER_ID = "local";

export const WORKER_PORT = Number(process.env.PROWL_WORKER_PORT ?? 3031);
export const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
