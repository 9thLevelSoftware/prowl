import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAllowedAbsoluteDataFile, isAllowedDataRelPath, sanitizeDispositionFilename } from "../lib/files-guard";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-files-guard-"));

function writeRel(rel: string, body = "fixture"): string {
  const abs = path.join(dataRoot, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

beforeAll(() => {
  // Allowlist fixtures (no real secrets — placeholder bytes only).
  writeRel("documents/baseline/abc/Jordan_Resume.pdf", "%PDF-1.4 resume");
  writeRel("documents/tailored/def/Jordan_Resume_Acme.docx", "docx");
  writeRel("documents/cover/xyz/Jordan_Cover.pdf", "%PDF-1.4 cover");
  writeRel("evidence/app-1/1700000000-before-submit.jpg", "jpeg-bytes");
  writeRel("evidence/app-1/1700000001-confirmation.png", "png-bytes");
  writeRel("documents/nested/deep/file.JPEG", "jpeg-upper");

  // Denylist / non-allowlisted fixtures.
  writeRel("secrets.json", '{"placeholder":true}');
  writeRel("secrets.key", "not-a-real-key");
  writeRel("prowl.sqlite", "sqlite-bytes");
  writeRel("prowl.sqlite-wal", "wal-bytes");
  writeRel("prowl.sqlite-shm", "shm-bytes");
  writeRel("browser-profile/Default/Cookies", "cookie-bytes");
  writeRel("browser-profile/Local State", "state");
  writeRel("catalog/models-dev.json", "{}");
  writeRel("documents/evil.sqlite", "should-deny-by-basename");
  writeRel("evidence/notes.txt", "txt-not-allowlisted");
  writeRel("other/report.pdf", "pdf-in-wrong-dir");
});

describe("isAllowedDataRelPath — allow matrix", () => {
  it("allows document and evidence paths with allowlisted extensions", () => {
    expect(isAllowedDataRelPath("documents/baseline/abc/Jordan_Resume.pdf")).toBe(true);
    expect(isAllowedDataRelPath("documents/tailored/def/Jordan_Resume_Acme.docx")).toBe(true);
    expect(isAllowedDataRelPath("documents/cover/xyz/Jordan_Cover.pdf")).toBe(true);
    expect(isAllowedDataRelPath("evidence/app-1/1700000000-before-submit.jpg")).toBe(true);
    expect(isAllowedDataRelPath("evidence/app-1/1700000001-confirmation.png")).toBe(true);
    expect(isAllowedDataRelPath("documents/nested/deep/file.JPEG")).toBe(true);
    expect(isAllowedDataRelPath("evidence/app-1/photo.jpeg")).toBe(true);
  });

  it("normalizes Windows separators", () => {
    expect(isAllowedDataRelPath("documents\\baseline\\abc\\Jordan_Resume.pdf")).toBe(true);
    expect(isAllowedDataRelPath("evidence\\app-1\\shot.png")).toBe(true);
  });
});

describe("isAllowedDataRelPath — deny matrix", () => {
  it("denies secrets, sqlite, and browser profile", () => {
    expect(isAllowedDataRelPath("secrets.json")).toBe(false);
    expect(isAllowedDataRelPath("secrets.key")).toBe(false);
    expect(isAllowedDataRelPath("prowl.sqlite")).toBe(false);
    expect(isAllowedDataRelPath("prowl.sqlite-wal")).toBe(false);
    expect(isAllowedDataRelPath("prowl.sqlite-shm")).toBe(false);
    expect(isAllowedDataRelPath("browser-profile/Default/Cookies")).toBe(false);
    expect(isAllowedDataRelPath("browser-profile/Local State")).toBe(false);
  });

  it("denies denylisted basenames even under an allowed top-level dir", () => {
    expect(isAllowedDataRelPath("documents/evil.sqlite")).toBe(false);
    expect(isAllowedDataRelPath("evidence/secrets.json")).toBe(false);
    expect(isAllowedDataRelPath("documents/sub/secrets.key")).toBe(false);
  });

  it("denies non-allowlisted top-level dirs and extensions", () => {
    expect(isAllowedDataRelPath("catalog/models-dev.json")).toBe(false);
    expect(isAllowedDataRelPath("other/report.pdf")).toBe(false);
    expect(isAllowedDataRelPath("evidence/notes.txt")).toBe(false);
    expect(isAllowedDataRelPath("documents/readme.md")).toBe(false);
  });

  it("denies empty, directory-only, and traversal-shaped relative paths", () => {
    expect(isAllowedDataRelPath("")).toBe(false);
    expect(isAllowedDataRelPath(".")).toBe(false);
    expect(isAllowedDataRelPath("documents")).toBe(false);
    expect(isAllowedDataRelPath("evidence")).toBe(false);
    expect(isAllowedDataRelPath("../secrets.json")).toBe(false);
    expect(isAllowedDataRelPath("documents/../../secrets.json")).toBe(false);
  });
});

describe("isAllowedAbsoluteDataFile against a temp data dir", () => {
  it("allows document/evidence files that exist on disk", () => {
    expect(isAllowedAbsoluteDataFile(path.join(dataRoot, "documents", "baseline", "abc", "Jordan_Resume.pdf"), dataRoot)).toBe(true);
    expect(isAllowedAbsoluteDataFile(path.join(dataRoot, "evidence", "app-1", "1700000000-before-submit.jpg"), dataRoot)).toBe(true);
  });

  it("denies secrets, sqlite, browser profile, and wrong-dir files on disk", () => {
    expect(isAllowedAbsoluteDataFile(path.join(dataRoot, "secrets.json"), dataRoot)).toBe(false);
    expect(isAllowedAbsoluteDataFile(path.join(dataRoot, "secrets.key"), dataRoot)).toBe(false);
    expect(isAllowedAbsoluteDataFile(path.join(dataRoot, "prowl.sqlite"), dataRoot)).toBe(false);
    expect(isAllowedAbsoluteDataFile(path.join(dataRoot, "prowl.sqlite-wal"), dataRoot)).toBe(false);
    expect(isAllowedAbsoluteDataFile(path.join(dataRoot, "browser-profile", "Default", "Cookies"), dataRoot)).toBe(false);
    expect(isAllowedAbsoluteDataFile(path.join(dataRoot, "other", "report.pdf"), dataRoot)).toBe(false);
    expect(isAllowedAbsoluteDataFile(path.join(dataRoot, "documents", "evil.sqlite"), dataRoot)).toBe(false);
  });

  it("denies absolute paths outside the data root (escape)", () => {
    const outside = path.join(os.tmpdir(), "prowl-outside-secret.pdf");
    fs.writeFileSync(outside, "%PDF-1.4 outside");
    expect(isAllowedAbsoluteDataFile(outside, dataRoot)).toBe(false);
  });
});

describe("sanitizeDispositionFilename", () => {
  it("strips CRLF and quotes that could break Content-Disposition", () => {
    expect(sanitizeDispositionFilename('Jordan_Resume\r\nX-Evil: 1.pdf')).toBe("Jordan_Resume__X-Evil: 1.pdf");
    expect(sanitizeDispositionFilename('evil".pdf')).toBe("evil_.pdf");
    expect(sanitizeDispositionFilename("a\\b.pdf")).toBe("a_b.pdf");
    expect(sanitizeDispositionFilename("Jordan_Resume.pdf")).toBe("Jordan_Resume.pdf");
  });
});
