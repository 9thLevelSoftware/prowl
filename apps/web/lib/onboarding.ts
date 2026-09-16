import "server-only";
import { and, eq, getActiveConnection, getActiveProfile, getPreferences, schema as s, sql } from "@jh/db";
import { db, USER } from "./server";

export interface Step {
  key: string;
  title: string;
  description: string;
  done: boolean;
  href: string;
  cta: string;
}

export function onboardingSteps(): Step[] {
  const d = db();
  const profile = getActiveProfile(d, USER);
  const prefs = getPreferences(d, USER);
  const connection = getActiveConnection(d, USER);
  const confirmedSkills = profile?.data.skills.filter((x) => x.confirmed).length ?? 0;
  const sources = d.select({ n: sql<number>`count(*)` }).from(s.jobSources).where(eq(s.jobSources.userId, USER)).get()?.n ?? 0;
  const answers = d.select({ n: sql<number>`count(*)` }).from(s.qaBank).where(and(eq(s.qaBank.userId, USER), eq(s.qaBank.approved, true))).get()?.n ?? 0;

  return [
    {
      key: "llm",
      title: "Connect an AI provider",
      description: "Sign in with ChatGPT or Google, or add an API key from almost any provider. It reads resumes, analyzes postings, and writes tailored documents.",
      done: connection?.status === "ok",
      href: "/settings",
      cta: "Open settings",
    },
    {
      key: "resume",
      title: "Add your resume",
      description: "Upload a PDF or DOCX, paste text, or build one from scratch. Everything tailored later is checked against this.",
      done: !!profile,
      href: "/profile",
      cta: profile ? "Edit profile" : "Add resume",
    },
    {
      key: "skills",
      title: "Confirm your skills",
      description: "Only skills you confirm can appear on tailored resumes. This is what keeps tailoring honest.",
      done: confirmedSkills > 0,
      href: "/profile#skills",
      cta: "Review skills",
    },
    {
      key: "prefs",
      title: "Set what you're looking for",
      description: "Target titles, locations, remote policy, salary floor, and how many applications per day.",
      done: prefs.targetTitles.length > 0,
      href: "/preferences",
      cta: "Set preferences",
    },
    {
      key: "answers",
      title: "Answer common screening questions",
      description: "Work authorization, sponsorship, start date, and similar. Answering once avoids pauses on every application.",
      done: answers >= 3,
      href: "/qa",
      cta: "Answer questions",
    },
    {
      key: "sources",
      title: "Add job sources",
      description: "Company boards on Greenhouse, Lever, or Ashby, an Adzuna search, company career pages, or LinkedIn/Indeed discovery.",
      done: sources > 0,
      href: "/sources",
      cta: "Add sources",
    },
  ];
}
