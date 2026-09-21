import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@prowl/shared";
import { safeDataFile } from "@/lib/server";
import { isAllowedAbsoluteDataFile, sanitizeDispositionFilename } from "@/lib/files-guard";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/**
 * Serve generated documents and evidence screenshots from the local data directory only.
 * safeDataFile blocks path escape outside the data dir; the allowlist then restricts
 * which in-dir files may be served (documents/ and evidence/ with document extensions).
 * Secrets, SQLite, and the browser profile are never served.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("p");
  const abs = p ? safeDataFile(p) : null;
  if (!abs) return new Response("Not found", { status: 404 });
  // Allowlist before any filesystem read of the target.
  if (!isAllowedAbsoluteDataFile(abs, dataDir())) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!fs.existsSync(abs)) return new Response("Not found", { status: 404 });
  const ext = path.extname(abs).toLowerCase();
  const disposition = url.searchParams.get("download") ? "attachment" : "inline";
  const filename = sanitizeDispositionFilename(path.basename(abs));
  return new Response(fs.readFileSync(abs), {
    headers: {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-disposition": `${disposition}; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
