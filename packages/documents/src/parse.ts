import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export type ResumeFileKind = "pdf" | "docx" | "txt" | "md";

export function detectKind(fileName: string): ResumeFileKind | null {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".txt") return "txt";
  if (ext === ".md" || ext === ".markdown") return "md";
  return null;
}

/** Extract plain text from an uploaded resume. Throws on unsupported types or empty output. */
export async function extractResumeText(fileName: string, bytes: Uint8Array): Promise<string> {
  const kind = detectKind(fileName);
  let text: string;
  switch (kind) {
    case "pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const res = await extractText(pdf, { mergePages: true });
      text = Array.isArray(res.text) ? res.text.join("\n") : res.text;
      break;
    }
    case "docx": {
      const res = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      text = res.value;
      break;
    }
    case "txt":
    case "md":
      text = Buffer.from(bytes).toString("utf8");
      break;
    default:
      throw new Error(`Unsupported resume file type: ${fileName}. Use PDF, DOCX, TXT, or MD.`);
  }
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 40) {
    throw new Error("Could not read meaningful text from that file. If it is a scanned PDF, export a text-based PDF or DOCX instead.");
  }
  return text;
}
