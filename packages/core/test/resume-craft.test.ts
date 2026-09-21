import { describe, expect, it } from "vitest";
import {
  ATS_CRAFT,
  BULLET_CRAFT,
  RESUME_CRAFT_TRUTH,
  TAILOR_CRAFT,
  bulletDraftSystemPrompt,
  coverLetterSystemPrompt,
  requirementsSystemPrompt,
  summaryDraftSystemPrompt,
  tailorSystemPrompt,
} from "../src/resume-craft";

describe("resume-craft prompts", () => {
  it("keeps truthfulness as a hard override", () => {
    expect(RESUME_CRAFT_TRUTH).toMatch(/may NOT invent or estimate/i);
    expect(RESUME_CRAFT_TRUTH).toMatch(/no metric/i);
  });

  it("encodes ATS and bullet craft without encouraging fabrication", () => {
    expect(ATS_CRAFT).toMatch(/exact spelling/i);
    expect(BULLET_CRAFT).toMatch(/X-Y-Z|achievement/i);
    expect(BULLET_CRAFT).toMatch(/Do not upgrade/i);
  });

  it("wires craft into tailor and cover-letter system prompts", () => {
    const tailor = tailorSystemPrompt();
    expect(tailor).toContain(RESUME_CRAFT_TRUTH.split("\n")[0]!);
    expect(tailor).toContain(TAILOR_CRAFT.slice(0, 20));
    expect(tailor).toContain("factIds");

    const cover = coverLetterSystemPrompt("180-250", "direct");
    expect(cover).toContain("180-250");
    expect(cover).toContain("direct");
    expect(cover).toMatch(/I am writing to apply/);
    expect(cover).toContain(RESUME_CRAFT_TRUTH.split("\n")[0]!);
  });

  it("wires craft into profile builder and JD prompts", () => {
    expect(bulletDraftSystemPrompt()).toMatch(/notes do not state|ONLY information in the notes/i);
    expect(summaryDraftSystemPrompt()).toMatch(/Do not invent/i);
    expect(requirementsSystemPrompt()).toMatch(/mustHaveSkills|required/i);
  });
});
