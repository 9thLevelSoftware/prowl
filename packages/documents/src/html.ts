import type { ResolvedCoverLetter, ResolvedResume } from "./model";

/*
 * ATS-safe layout rules:
 *  - single column, no tables, text boxes, icons, images, or header/footer regions
 *  - standard section headings a parser recognizes
 *  - contact details in the document body
 *  - real text with system fonts so copy/paste and parsing yield the same words a human reads
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BASE_CSS = `
  @page { size: Letter; margin: 0.6in 0.65in; }
  * { box-sizing: border-box; }
  body { font-family: Calibri, Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.32; color: #111; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2pt; font-weight: 700; }
  .headline { font-size: 11pt; margin: 0 0 3pt; }
  .contact { font-size: 9.5pt; margin: 0 0 8pt; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid #444; margin: 10pt 0 4pt; padding-bottom: 1pt; }
  p { margin: 0 0 4pt; }
  .role { margin: 0 0 6pt; page-break-inside: avoid; }
  .role-head { font-weight: 700; }
  .role-sub { font-style: normal; color: #333; }
  ul { margin: 2pt 0 0 0; padding-left: 16pt; }
  li { margin: 0 0 1.5pt; }
  .skills p { margin: 0 0 2pt; }
`;

export function resumeHtml(r: ResolvedResume): string {
  const c = r.contact;
  const contactBits = [c.email, c.phone, c.location, ...c.links.map((l) => l.url)].filter(Boolean).map(esc);
  const section = (title: string, body: string) => (body.trim() ? `<h2>${title}</h2>${body}` : "");
  const bullets = (items: string[]) => (items.length ? `<ul>${items.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "");

  const summary = r.summary ? `<p>${esc(r.summary)}</p>` : "";
  const skills = r.skills.length
    ? `<div class="skills">${r.skills.map((g) => `<p><strong>${esc(g.category)}:</strong> ${esc(g.items.join(", "))}</p>`).join("")}</div>`
    : "";
  const work = r.work
    .map(
      (w) => `<div class="role">
        <div class="role-head">${esc(w.title)}, ${esc(w.company)}</div>
        <div class="role-sub">${esc([w.location, w.dates].filter(Boolean).join(" | "))}</div>
        ${bullets(w.bullets)}
      </div>`,
    )
    .join("");
  const projects = r.projects
    .map((p) => `<div class="role"><div class="role-head">${esc(p.name)}${p.url ? ` <span class="role-sub">(${esc(p.url)})</span>` : ""}</div>${bullets(p.bullets)}</div>`)
    .join("");
  const education = r.education
    .map(
      (e) => `<div class="role">
        <div class="role-head">${esc(e.degree || e.institution)}</div>
        <div class="role-sub">${esc([e.degree ? e.institution : "", e.dates].filter(Boolean).join(" | "))}</div>
        ${bullets(e.details)}
      </div>`,
    )
    .join("");
  const certs = r.certifications.length ? bullets(r.certifications) : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(c.fullName)} Resume</title><style>${BASE_CSS}</style></head><body>
    <h1>${esc(c.fullName)}</h1>
    ${r.headline ? `<p class="headline">${esc(r.headline)}</p>` : ""}
    <p class="contact">${contactBits.join(" | ")}</p>
    ${section("Summary", summary)}
    ${section("Skills", skills)}
    ${section("Experience", work)}
    ${section("Projects", projects)}
    ${section("Education", education)}
    ${section("Certifications", certs)}
  </body></html>`;
}

export function coverLetterHtml(l: ResolvedCoverLetter): string {
  const c = l.contact;
  const contactBits = [c.email, c.phone, c.location].filter(Boolean).map(esc);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(c.fullName)} Cover Letter</title><style>${BASE_CSS}
    body { font-size: 11pt; line-height: 1.45; }
    p { margin: 0 0 10pt; }
  </style></head><body>
    <h1>${esc(c.fullName)}</h1>
    <p class="contact">${contactBits.join(" | ")}</p>
    <p>${esc(l.date)}</p>
    <p>Hiring Team<br>${esc(l.company)}<br>Re: ${esc(l.jobTitle)}</p>
    <p>${esc(l.greeting)}</p>
    ${l.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}
    <p>${esc(l.closing)}<br>${esc(l.signature)}</p>
  </body></html>`;
}
