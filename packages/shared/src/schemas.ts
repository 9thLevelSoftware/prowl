import { z } from "zod";

/*
 * Two families of schemas live here:
 *  - Storage schemas (with defaults) used for the DB and UI.
 *  - LLM output schemas (suffix `Out`): every field required, nullable instead of optional,
 *    no defaults or min/max. OpenAI strict structured output and Gemini's schema subset both
 *    reject optional/default keywords, so these must stay "boring".
 */

/* ============================== Profile ============================== */

export const Contact = z.object({
  fullName: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
});

export const WorkEntry = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().default(""),
  startDate: z.string().default(""),
  endDate: z.string().default(""),
  bullets: z.array(z.string()).default([]),
});
export type WorkEntry = z.infer<typeof WorkEntry>;

export const EducationEntry = z.object({
  id: z.string(),
  institution: z.string(),
  degree: z.string().default(""),
  field: z.string().default(""),
  startDate: z.string().default(""),
  endDate: z.string().default(""),
  details: z.array(z.string()).default([]),
});
export type EducationEntry = z.infer<typeof EducationEntry>;

export const Skill = z.object({
  name: z.string(),
  category: z.string().default("General"),
  aliases: z.array(z.string()).default([]),
  /** User confirmed they genuinely have this skill. Only confirmed skills may appear in tailored output. */
  confirmed: z.boolean().default(false),
});
export type Skill = z.infer<typeof Skill>;

export const Certification = z.object({
  name: z.string(),
  issuer: z.string().default(""),
  date: z.string().default(""),
});

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  bullets: z.array(z.string()).default([]),
  url: z.string().default(""),
});
export type Project = z.infer<typeof Project>;

export const ProfileData = z.object({
  contact: Contact.default({ fullName: "", email: "", phone: "", location: "", links: [] }),
  headline: z.string().default(""),
  summary: z.string().default(""),
  work: z.array(WorkEntry).default([]),
  education: z.array(EducationEntry).default([]),
  skills: z.array(Skill).default([]),
  certifications: z.array(Certification).default([]),
  projects: z.array(Project).default([]),
  /** Free-form context the user supplies (e.g. "why I left", visa details). Never printed on a resume. */
  additionalContext: z.string().default(""),
});
export type ProfileData = z.infer<typeof ProfileData>;

export function emptyProfile(): ProfileData {
  return ProfileData.parse({});
}

/** LLM extraction target for resume parsing. */
export const ProfileExtractOut = z.object({
  contact: z.object({
    fullName: z.string(),
    email: z.string(),
    phone: z.string(),
    location: z.string(),
    links: z.array(z.object({ label: z.string(), url: z.string() })),
  }),
  headline: z.string(),
  summary: z.string(),
  work: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      startDate: z.string().describe("YYYY-MM or YYYY; empty string if unknown"),
      endDate: z.string().describe("YYYY-MM, YYYY, or 'present'"),
      bullets: z.array(z.string()).describe("Copy bullets verbatim from the resume; do not rewrite"),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      field: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      details: z.array(z.string()),
    }),
  ),
  skills: z.array(z.object({ name: z.string(), category: z.string() })),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string(), date: z.string() })),
  projects: z.array(z.object({ name: z.string(), description: z.string(), bullets: z.array(z.string()), url: z.string() })),
});
export type ProfileExtractOut = z.infer<typeof ProfileExtractOut>;

/** An atomized, citable claim derived from the confirmed profile. */
export const ProfileFact = z.object({
  id: z.string(),
  kind: z.enum(["role", "bullet", "skill", "education", "certification", "project", "summary", "context"]),
  text: z.string(),
  refId: z.string().default(""),
});
export type ProfileFact = z.infer<typeof ProfileFact>;

/* ============================ Preferences ============================ */

export const RemotePolicy = z.enum(["remote_only", "hybrid_ok", "onsite_ok", "any"]);
export const SENIORITIES = ["intern", "entry", "mid", "senior", "staff", "principal", "manager", "director", "executive"] as const;
export const Seniority = z.enum(SENIORITIES);
export type Seniority = z.infer<typeof Seniority>;

export const Preferences = z.object({
  targetTitles: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  remotePolicy: RemotePolicy.default("any"),
  salaryFloor: z.number().int().nonnegative().default(0),
  seniority: z.array(Seniority).default([]),
  industriesInclude: z.array(z.string()).default([]),
  industriesExclude: z.array(z.string()).default([]),
  companyExclude: z.array(z.string()).default([]),
  workAuthorization: z.string().default(""),
  requiresSponsorship: z.boolean().default(false),
  dailyApplyCap: z.number().int().min(0).max(200).default(20),
  minMatchScore: z.number().int().min(0).max(100).default(65),
  autoTailor: z.boolean().default(true),
  dryRun: z.boolean().default(true),
  coverLetterTone: z.enum(["professional", "warm", "direct"]).default("professional"),
  coverLetterLength: z.enum(["short", "medium"]).default("short"),
  applyDelaySecondsMin: z.number().int().min(0).default(60),
  applyDelaySecondsMax: z.number().int().min(0).default(180),
  headlessBrowser: z.boolean().default(false),
  discoveryIntervalHours: z.number().int().min(1).max(168).default(6),
});
export type Preferences = z.infer<typeof Preferences>;

/* =============================== Jobs ================================ */

export const ATS_TYPES = ["greenhouse", "lever", "ashby", "workday", "smartrecruiters", "linkedin", "indeed", "other"] as const;
export const AtsType = z.enum(ATS_TYPES);
export type AtsType = z.infer<typeof AtsType>;

/** ATS types the applier can submit to without human help. */
export const APPLIABLE_ATS: readonly AtsType[] = ["greenhouse", "lever", "ashby"];

export const SOURCE_TYPES = ["greenhouse", "lever", "ashby", "adzuna", "careerpage", "linkedin", "indeed"] as const;
export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

export interface RawJob {
  externalId: string;
  title: string;
  company: string;
  location: string;
  remote: boolean | null;
  salaryMin: number | null;
  salaryMax: number | null;
  descriptionText: string;
  applyUrl: string;
  postingUrl: string;
  postedAt: string | null;
  atsType: AtsType;
}

export const JobRequirementsOut = z.object({
  roleSummary: z.string().describe("One sentence describing the role"),
  mustHaveSkills: z.array(z.string()),
  niceToHaveSkills: z.array(z.string()),
  minYearsExperience: z.number().nullable(),
  seniority: Seniority.nullable(),
  educationRequirements: z.array(z.string()),
  certifications: z.array(z.string()),
  remote: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  locationConstraints: z.array(z.string()),
  workAuthorization: z.string().nullable().describe("Any citizenship/visa/clearance requirement, verbatim, else null"),
  sponsorshipAvailable: z.boolean().nullable(),
  industry: z.string().nullable(),
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  keyResponsibilities: z.array(z.string()),
  atsKeywords: z
    .array(z.string())
    .describe("Exact terms (tools, frameworks, certifications, methodologies) an ATS keyword filter would look for, spelled as in the posting"),
});
export type JobRequirements = z.infer<typeof JobRequirementsOut>;

export interface ScoreBreakdown {
  vetoed: boolean;
  vetoReasons: string[];
  skills: number;
  semantic: number;
  experience: number;
  preference: number;
  total: number;
  matchedSkills: string[];
  missingSkills: string[];
  reasons: string[];
}

/* ============================= Tailoring ============================= */

export const TailoredBulletOut = z.object({
  text: z.string(),
  factIds: z.array(z.string()).describe("IDs of the profile facts this bullet is derived from. Must not be empty."),
});

export const TailoredResumeOut = z.object({
  headline: z.string(),
  summary: z.object({ text: z.string(), factIds: z.array(z.string()) }),
  skills: z.array(z.object({ category: z.string(), items: z.array(z.string()) })),
  work: z.array(
    z.object({
      workId: z.string().describe("id of the work entry in the profile, copied exactly"),
      bullets: z.array(TailoredBulletOut),
    }),
  ),
  projects: z.array(z.object({ projectId: z.string(), bullets: z.array(TailoredBulletOut) })),
  includeEducationIds: z.array(z.string()),
  includeCertifications: z.array(z.string()),
  changeNotes: z.array(z.string()).describe("Short notes on what was changed and why"),
});
export type TailoredResume = z.infer<typeof TailoredResumeOut>;

export const AuditVerdict = z.enum(["entailed", "exaggerated", "fabricated"]);
export type AuditVerdict = z.infer<typeof AuditVerdict>;

export const AuditReportOut = z.object({
  items: z.array(
    z.object({
      location: z.string().describe("'headline', 'summary', 'skills', 'work:<workId>:<bulletIndex>', 'project:<projectId>:<bulletIndex>', or 'cover:<paragraphIndex>'"),
      claim: z.string(),
      verdict: AuditVerdict,
      offendingSpan: z.string().describe("The exact unsupported words, or empty string when entailed"),
      explanation: z.string(),
    }),
  ),
});
export type AuditReport = z.infer<typeof AuditReportOut> & { overall: "pass" | "flagged" };
export type AuditItem = AuditReport["items"][number];

export const CoverLetterOut = z.object({
  greeting: z.string(),
  paragraphs: z.array(z.object({ text: z.string(), factIds: z.array(z.string()) })),
  closing: z.string(),
  signature: z.string(),
});
export type CoverLetter = z.infer<typeof CoverLetterOut>;

/* ============================ Applications =========================== */

export const APPLICATION_STATUSES = [
  "matched",
  "tailoring",
  "ready_for_review",
  "approved",
  "applying",
  "needs_input",
  "submitted",
  "failed",
  "skipped",
  "rejected_by_user",
] as const;
export const ApplicationStatus = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof ApplicationStatus>;

export const OUTCOME_STATUSES = ["none", "acknowledged", "recruiter_contact", "interview", "offer", "rejected", "ghosted", "withdrawn"] as const;
export const OutcomeStatus = z.enum(OUTCOME_STATUSES);
export type OutcomeStatus = z.infer<typeof OutcomeStatus>;

export const TASK_TYPES = ["discover_all", "discover_source", "process_job", "tailor", "apply", "build_sources"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
