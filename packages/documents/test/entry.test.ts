import { describe, expect, it } from "vitest";
import { ProfileData } from "@prowl/shared";
import { coverLetterHtml, detectKind, extractResumeText, formatDate, formatRange, resolveBaseline, resolveCoverLetter, resumeHtml } from "../src";

const profile = ProfileData.parse({
  contact: { fullName: "Jordan Rivera", email: "jordan@example.com", phone: "555-0100", location: "Austin, TX", links: [] },
  headline: "Backend Engineer",
  summary: "Backend engineer building payment APIs.",
  work: [{ id: "w1", company: "Paylane", title: "Senior Software Engineer", location: "Remote", startDate: "2021-03", endDate: "present", bullets: ["Built payment APIs"] }],
  skills: [{ name: "TypeScript", category: "Languages", confirmed: true }],
});

describe("documents entry (offline)", () => {
  it("detectKind maps supported resume extensions", () => {
    expect(detectKind("resume.pdf")).toBe("pdf");
    expect(detectKind("resume.docx")).toBe("docx");
    expect(detectKind("resume.TXT")).toBe("txt");
    expect(detectKind("resume.md")).toBe("md");
    expect(detectKind("resume.png")).toBeNull();
  });

  it("extractResumeText accepts plain text offline", async () => {
    const text = await extractResumeText("resume.txt", Buffer.from("Jordan Rivera built payment APIs in TypeScript for several years."));
    expect(text).toContain("Jordan Rivera");
  });

  it("resumeHtml emits single-column ATS-safe markup from the profile", () => {
    const html = resumeHtml(resolveBaseline(profile));
    expect(html).toContain("Jordan Rivera");
    expect(html).toContain("Paylane");
    expect(html).not.toContain("<table");
    expect(html).toContain("<h2>Experience</h2>");
  });

  it("coverLetterHtml keeps contact and body text", () => {
    const letter = { greeting: "Dear Hiring Team,", paragraphs: [{ text: "I build payment APIs.", factIds: ["W1.1"] }], closing: "Best,", signature: "Jordan Rivera" };
    const html = coverLetterHtml(resolveCoverLetter(profile, letter, { title: "Backend Engineer", company: "Acme" }));
    expect(html).toContain("Jordan Rivera");
    expect(html).toContain("payment APIs");
  });

  it("formatDate / formatRange normalize profile dates", () => {
    expect(formatDate("present")).toBe("Present");
    expect(formatDate("2021-03")).toBe("Mar 2021");
    expect(formatRange("2021-03", "present")).toBe("Mar 2021 – Present");
  });
});
