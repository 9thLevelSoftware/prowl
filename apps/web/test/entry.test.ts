import { describe, expect, it } from "vitest";
import { isAllowedDataRelPath, sanitizeDispositionFilename } from "../lib/files-guard";

describe("web entry (PR8 offline)", () => {
  it("files-guard remains pure offline policy", () => {
    expect(isAllowedDataRelPath("documents/a/b.pdf")).toBe(true);
    expect(isAllowedDataRelPath("evidence/x/y.png")).toBe(true);
    expect(isAllowedDataRelPath("secrets.json")).toBe(false);
    expect(isAllowedDataRelPath("prowl.sqlite")).toBe(false);
  });

  it("sanitizeDispositionFilename strips header-breaking characters", () => {
    expect(sanitizeDispositionFilename('Jordan_Resume\r\nX-Evil: 1.pdf')).toBe("Jordan_Resume__X-Evil: 1.pdf");
    expect(sanitizeDispositionFilename("Jordan_Resume.pdf")).toBe("Jordan_Resume.pdf");
  });
});
