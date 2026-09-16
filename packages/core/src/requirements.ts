import type { LlmClient } from "@jh/llm";
import { JobRequirementsOut, type JobRequirements } from "@jh/shared";

const SYSTEM = `You analyze job postings for a candidate-matching system.
Extract requirements exactly as the posting states them. Do not guess.
- mustHaveSkills: skills, tools, or qualifications the posting marks as required (or lists under "requirements"/"qualifications" without "preferred" language). Keep each item short (1-4 words).
- niceToHaveSkills: items marked preferred, bonus, or nice-to-have.
- atsKeywords: the exact spellings of hard terms an ATS keyword filter would match (named tools, languages, frameworks, certifications, methodologies, regulations). 5-25 items.
- minYearsExperience: the smallest number of years stated as required, else null.
- seniority: infer from title and years only when clear, else null.
- workAuthorization: quote any citizenship, visa, or clearance requirement; null if none.
- salaryMin/salaryMax: annual base in the posting's currency if stated, else null.`;

export async function extractRequirements(
  llm: LlmClient,
  job: { id: string; title: string; company: string; location: string; descriptionText: string },
): Promise<JobRequirements> {
  const description = job.descriptionText.slice(0, 24_000);
  return llm.object({ task: "extract_requirements", tier: "fast", jobId: job.id }, JobRequirementsOut, {
    system: SYSTEM,
    prompt: `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\n\nPosting:\n"""\n${description}\n"""`,
  });
}
