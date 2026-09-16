import fs from "node:fs";
import crypto from "node:crypto";
import { chromium, type Browser } from "playwright";
import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TextRun } from "docx";
import { dataPath, logger, slug } from "@jh/shared";
import { coverLetterHtml, resumeHtml } from "./html";
import type { ResolvedCoverLetter, ResolvedResume } from "./model";

const log = logger("documents");

let browserPromise: Promise<Browser> | undefined;

async function pdfBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((err) => {
      browserPromise = undefined;
      throw new Error(
        `Could not start Chromium for PDF rendering. Run \`pnpm exec playwright install chromium\` once. (${(err as Error).message})`,
      );
    });
  }
  return browserPromise;
}

export async function closeRenderer(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => undefined);
    browserPromise = undefined;
    await b?.close();
  }
}

export async function htmlToPdf(html: string, outPath: string): Promise<void> {
  const browser = await pdfBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: outPath, format: "Letter", printBackground: false, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

export function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/* ------------------------------- DOCX ------------------------------- */

const FONT = "Calibri";
const run = (text: string, opts: { bold?: boolean; size?: number; italics?: boolean } = {}) =>
  new TextRun({ text, font: FONT, bold: opts.bold, italics: opts.italics, size: opts.size ?? 21 });

function heading(title: string): Paragraph {
  return new Paragraph({
    children: [run(title.toUpperCase(), { bold: true, size: 22 })],
    spacing: { before: 200, after: 60 },
    border: { bottom: { color: "444444", style: BorderStyle.SINGLE, size: 6, space: 1 } },
  });
}

const bullet = (text: string) => new Paragraph({ children: [run(text)], bullet: { level: 0 }, spacing: { after: 20 } });

export function resumeDocx(r: ResolvedResume): Document {
  const c = r.contact;
  const kids: Paragraph[] = [
    new Paragraph({ children: [run(c.fullName, { bold: true, size: 36 })], spacing: { after: 40 } }),
  ];
  if (r.headline) kids.push(new Paragraph({ children: [run(r.headline, { size: 22 })] }));
  kids.push(
    new Paragraph({
      children: [run([c.email, c.phone, c.location, ...c.links.map((l) => l.url)].filter(Boolean).join(" | "), { size: 19 })],
      spacing: { after: 120 },
    }),
  );
  if (r.summary) kids.push(heading("Summary"), new Paragraph({ children: [run(r.summary)] }));
  if (r.skills.length) {
    kids.push(heading("Skills"));
    for (const g of r.skills) kids.push(new Paragraph({ children: [run(`${g.category}: `, { bold: true }), run(g.items.join(", "))] }));
  }
  if (r.work.length) {
    kids.push(heading("Experience"));
    for (const w of r.work) {
      kids.push(new Paragraph({ children: [run(`${w.title}, ${w.company}`, { bold: true })], spacing: { before: 80 } }));
      kids.push(new Paragraph({ children: [run([w.location, w.dates].filter(Boolean).join(" | "))] }));
      kids.push(...w.bullets.map(bullet));
    }
  }
  if (r.projects.length) {
    kids.push(heading("Projects"));
    for (const p of r.projects) {
      kids.push(new Paragraph({ children: [run(p.name, { bold: true }), ...(p.url ? [run(` (${p.url})`)] : [])], spacing: { before: 80 } }));
      kids.push(...p.bullets.map(bullet));
    }
  }
  if (r.education.length) {
    kids.push(heading("Education"));
    for (const e of r.education) {
      kids.push(new Paragraph({ children: [run(e.degree || e.institution, { bold: true })], spacing: { before: 80 } }));
      kids.push(new Paragraph({ children: [run([e.degree ? e.institution : "", e.dates].filter(Boolean).join(" | "))] }));
      kids.push(...e.details.map(bullet));
    }
  }
  if (r.certifications.length) {
    kids.push(heading("Certifications"), ...r.certifications.map(bullet));
  }
  return new Document({ sections: [{ properties: { page: { margin: { top: 860, bottom: 860, left: 936, right: 936 } } }, children: kids }] });
}

export function coverLetterDocx(l: ResolvedCoverLetter): Document {
  const c = l.contact;
  const p = (text: string, opts: { bold?: boolean; size?: number } = {}) =>
    new Paragraph({ children: [run(text, { ...opts, size: opts.size ?? 22 })], spacing: { after: 200 }, alignment: AlignmentType.LEFT });
  return new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [run(c.fullName, { bold: true, size: 36 })] }),
          p([c.email, c.phone, c.location].filter(Boolean).join(" | "), { size: 19 }),
          p(l.date),
          p(`Hiring Team, ${l.company}. Re: ${l.jobTitle}`),
          p(l.greeting),
          ...l.paragraphs.map((x) => p(x)),
          p(l.closing),
          p(l.signature),
        ],
      },
    ],
  });
}

/* ------------------------------ Outputs ----------------------------- */

export interface RenderedFiles {
  pdfPath: string;
  docxPath: string;
  fileName: string;
  pdfSha256: string;
}

function documentDir(kind: "baseline" | "tailored" | "cover", key: string): string {
  return dataPath("documents", kind, key, ".keep").replace(/[\\/]\.keep$/, "");
}

export async function renderResumeFiles(
  r: ResolvedResume,
  opts: { kind: "baseline" | "tailored"; key: string; company?: string },
): Promise<RenderedFiles> {
  const dir = documentDir(opts.kind, opts.key);
  const base = [slug(r.contact.fullName) || "Resume", "Resume", opts.company ? slug(opts.company) : ""].filter(Boolean).join("_");
  const pdfPath = `${dir}/${base}.pdf`;
  const docxPath = `${dir}/${base}.docx`;
  await htmlToPdf(resumeHtml(r), pdfPath);
  fs.writeFileSync(docxPath, await Packer.toBuffer(resumeDocx(r)));
  log.info(`rendered resume ${pdfPath}`);
  return { pdfPath, docxPath, fileName: `${base}.pdf`, pdfSha256: sha256File(pdfPath) };
}

export async function renderCoverLetterFiles(l: ResolvedCoverLetter, key: string): Promise<RenderedFiles> {
  const dir = documentDir("cover", key);
  const base = [slug(l.contact.fullName) || "Cover", "Cover_Letter", slug(l.company)].filter(Boolean).join("_");
  const pdfPath = `${dir}/${base}.pdf`;
  const docxPath = `${dir}/${base}.docx`;
  await htmlToPdf(coverLetterHtml(l), pdfPath);
  fs.writeFileSync(docxPath, await Packer.toBuffer(coverLetterDocx(l)));
  return { pdfPath, docxPath, fileName: `${base}.pdf`, pdfSha256: sha256File(pdfPath) };
}
