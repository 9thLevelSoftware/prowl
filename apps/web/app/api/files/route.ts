import fs from "node:fs";
import path from "node:path";
import { safeDataFile } from "@/lib/server";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** Serve generated documents and evidence screenshots from the local data directory only. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("p");
  const abs = p ? safeDataFile(p) : null;
  if (!abs || !fs.existsSync(abs)) return new Response("Not found", { status: 404 });
  const ext = path.extname(abs).toLowerCase();
  const disposition = url.searchParams.get("download") ? "attachment" : "inline";
  return new Response(fs.readFileSync(abs), {
    headers: {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-disposition": `${disposition}; filename="${path.basename(abs)}"`,
      "cache-control": "no-store",
    },
  });
}
