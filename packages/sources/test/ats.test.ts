import { describe, expect, it } from "vitest";
import { Preferences, type RawJob } from "@jh/shared";
import { detectAts, findEmbeddedBoards, prefilter, parseSalaryText } from "../src";

describe("detectAts", () => {
  it("parses hosted board URLs", () => {
    expect(detectAts("https://job-boards.greenhouse.io/stripe/jobs/8172487")).toEqual({ ats: "greenhouse", board: "stripe", jobId: "8172487" });
    expect(detectAts("https://boards.greenhouse.io/embed/job_app?for=acme&token=123")).toEqual({ ats: "greenhouse", board: "acme", jobId: "123" });
    expect(detectAts("https://jobs.lever.co/palantir/abc-123/apply")).toEqual({ ats: "lever", board: "palantir", jobId: "abc-123" });
    expect(detectAts("https://jobs.ashbyhq.com/ramp/uuid-1")).toEqual({ ats: "ashby", board: "ramp", jobId: "uuid-1" });
    expect(detectAts("https://acme.wd5.myworkdayjobs.com/en-US/External/job/X")).toEqual({ ats: "workday" });
    expect(detectAts("https://stripe.com/jobs/search?gh_jid=42").ats).toBe("greenhouse");
    expect(detectAts("not a url").ats).toBe("other");
  });
});

describe("findEmbeddedBoards", () => {
  it("finds greenhouse, lever, and ashby embeds", () => {
    const html = `
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmecorp"></script>
      <a href="https://jobs.lever.co/acme">Jobs</a>
      <iframe src="https://jobs.ashbyhq.com/acme.ai/embed"></iframe>`;
    expect(findEmbeddedBoards(html)).toEqual([
      { type: "greenhouse", token: "acmecorp" },
      { type: "lever", token: "acme" },
      { type: "ashby", token: "acme.ai" },
    ]);
  });
});

describe("prefilter", () => {
  const job = (title: string): RawJob => ({
    externalId: title,
    title,
    company: "X",
    location: "",
    remote: null,
    salaryMin: null,
    salaryMax: null,
    descriptionText: "",
    applyUrl: "https://x",
    postingUrl: "",
    postedAt: null,
    atsType: "other",
  });
  const jobs = ["Senior Backend Engineer", "Backend Software Engineer II", "Legal Counsel", "Staff Data Engineer"].map(job);

  it("keeps titles containing all significant target words", () => {
    const prefs = Preferences.parse({ targetTitles: ["Senior Backend Engineer"] });
    expect(prefilter(jobs, prefs).map((j) => j.title)).toEqual(["Senior Backend Engineer", "Backend Software Engineer II"]);
  });
  it("passes everything without targets", () => {
    expect(prefilter(jobs, Preferences.parse({}))).toHaveLength(4);
  });
  it("keeps role words when a title has only one other word, and ignores bare role keywords", () => {
    const titles = ["SVP, Product Management", "Head of Product", "Account Executive, Product", "Senior Vice President of Product", "Director of Product", "VP Sales"].map(job);
    const prefs = Preferences.parse({ targetTitles: ["VP of Product", "Head of Product"], keywords: ["head", "vp"] });
    expect(prefilter(titles, prefs).map((j) => j.title)).toEqual(["SVP, Product Management", "Head of Product", "Senior Vice President of Product"]);
    expect(prefilter(titles, Preferences.parse({ keywords: ["head"] }))).toHaveLength(titles.length);
    expect(prefilter(titles, Preferences.parse({ keywords: ["product management"] })).map((j) => j.title)).toEqual(["SVP, Product Management"]);
  });
  it("skips titles in a different job function unless a target names it", () => {
    const titles = ["Head of Product", "Head of Product Marketing", "Head of Product Design", "Staff Product Manager"].map(job);
    expect(prefilter(titles, Preferences.parse({ targetTitles: ["Head of Product", "Product Manager"] })).map((j) => j.title)).toEqual(["Head of Product", "Staff Product Manager"]);
    expect(prefilter(titles, Preferences.parse({ targetTitles: ["Product Designer", "Head of Product"] })).map((j) => j.title)).toEqual(["Head of Product", "Head of Product Design"]);
  });
  it("supports keyword matches", () => {
    expect(prefilter(jobs, Preferences.parse({ keywords: ["data"] })).map((j) => j.title)).toEqual(["Staff Data Engineer"]);
  });
});

describe("parseSalaryText", () => {
  it("reads ranges", () => {
    expect(parseSalaryText("$150,000 - $190,000")).toEqual({ min: 150000, max: 190000 });
    expect(parseSalaryText("$211.4K – $290.6K")).toEqual({ min: 211400, max: 290600 });
    expect(parseSalaryText("competitive")).toEqual({ min: null, max: null });
  });
});
