import path from "node:path";

/**
 * Pure allow/deny policy for /api/files.
 * Path escape outside the data dir is already blocked by safeDataFile;
 * this module only decides whether a path inside the data dir may be served.
 */

export const ALLOWED_TOP_LEVEL_DIRS = ["documents", "evidence"] as const;

export const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".jpg", ".jpeg", ".png"]);

const DENIED_BASENAMES = new Set(["secrets.json", "secrets.key"]);

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join("/").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

function isDeniedPath(normalizedRel: string): boolean {
  const base = normalizedRel.split("/").pop() ?? "";
  if (DENIED_BASENAMES.has(base)) return true;
  if (normalizedRel === "browser-profile" || normalizedRel.startsWith("browser-profile/")) return true;
  // Covers prowl.sqlite, prowl.sqlite-wal, prowl.sqlite-shm, *.sqlite.bak, etc.
  if (/\.sqlite/i.test(base)) return true;
  return false;
}

/** True only when the data-dir-relative path is under documents/ or evidence/ and has an allowlisted extension. */
export function isAllowedDataRelPath(rel: string): boolean {
  const normalized = normalizeRel(rel);
  if (!normalized || normalized === "." || normalized.split("/").some((seg) => seg === ".." || seg === "")) {
    return false;
  }
  if (isDeniedPath(normalized)) return false;
  const top = normalized.split("/")[0];
  if (!top || !(ALLOWED_TOP_LEVEL_DIRS as readonly string[]).includes(top)) return false;
  if (!normalized.includes("/")) return false;
  const ext = path.extname(normalized).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

/** Absolute-path form of the allowlist, used by the route after safeDataFile resolves. */
export function isAllowedAbsoluteDataFile(abs: string, dataRoot: string): boolean {
  const root = path.resolve(dataRoot);
  const resolved = path.resolve(abs);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return isAllowedDataRelPath(rel);
}

/** Strip CRLF and quotes so Content-Disposition cannot be header-injected. */
export function sanitizeDispositionFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_");
}
