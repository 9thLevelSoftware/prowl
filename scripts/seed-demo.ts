/**
 * Seeds a realistic local dataset WITHOUT calling any AI provider, so the UI and the applier can be
 * exercised end to end before credentials exist. Uses the real profile, scoring, validation, audit
 * override, and PDF rendering code; only the model outputs (requirements, tailoring, audit verdicts)
 * are hand-written.
 *
 *   pnpm seed:demo      # writes demo data to ./data-demo
 *   pnpm dev:demo       # runs the app against it
 */
import {
  getDb,
  runMigrations,
  saveProfileVersion,
  savePreferences,
  ensureApplication,
  transitionApplication,
  logApplicationEvent,
  schema as s,
  eq,
} from "@prowl/db";
import { ProfileData, type JobRequirements, type TailoredResume, type CoverLetter } from "@prowl/shared";
import { buildFacts, scoreJob, validateTailored, measure, jobDedupKey } from "@prowl/core";
import { renderCoverLetterFiles, renderResumeFiles, resolveBaseline, resolveCoverLetter, resolveTailored, closeRenderer } from "@prowl/documents";

const db = getDb();
runMigrations(db);

const existing = db.select().from(s.jobs).where(eq(s.jobs.externalId, "demo:1")).get();
if (existing) {
  console.log("Demo data already present. Delete data from Settings to reseed.");
  process.exit(0);
}

const profileData = ProfileData.parse({
  contact: {
    fullName: "Jordan Rivera",
    email: "jordan.rivera@example.com",
    phone: "(512) 555-0142",
    location: "Austin, TX",
    links: [
      { label: "LinkedIn", url: "https://www.linkedin.com/in/jordan-rivera-demo" },
      { label: "GitHub", url: "https://github.com/jrivera-demo" },
    ],
  },
  headline: "Backend Engineer, Payments and Platform",
  summary: "Backend engineer with seven years building payment APIs and internal platforms in TypeScript and Go.",
  work: [
    {
      id: "w_paylane",
      company: "Paylane",
      title: "Senior Software Engineer",
      location: "Remote",
      startDate: "2021-03",
      endDate: "present",
      bullets: [
        "Built and operate a TypeScript payments API handling 2M requests per day",
        "Cut p95 checkout latency by 40% by moving fraud-scoring hot paths to Go",
        "Led migration of 14 services from EC2 to Kubernetes with zero customer-facing downtime",
        "Mentored 3 engineers through promotion to mid-level",
      ],
    },
    {
      id: "w_shopco",
      company: "ShopCo",
      title: "Software Engineer",
      location: "Austin, TX",
      startDate: "2018-06",
      endDate: "2021-02",
      bullets: [
        "Maintained PostgreSQL schemas and query performance for the order service",
        "Wrote CI pipelines in GitHub Actions that cut build times from 25 to 9 minutes",
        "Added idempotency keys to the refunds API, eliminating duplicate refunds",
      ],
    },
  ],
  education: [{ id: "e_ut", institution: "University of Texas at Austin", degree: "BS", field: "Computer Science", startDate: "2014", endDate: "2018" }],
  skills: [
    { name: "TypeScript", category: "Languages", confirmed: true },
    { name: "Go", category: "Languages", aliases: ["Golang"], confirmed: true },
    { name: "SQL", category: "Languages", confirmed: true },
    { name: "PostgreSQL", category: "Data", aliases: ["Postgres"], confirmed: true },
    { name: "Redis", category: "Data", confirmed: true },
    { name: "Kubernetes", category: "Infrastructure", aliases: ["K8s"], confirmed: true },
    { name: "AWS", category: "Infrastructure", confirmed: true },
    { name: "GitHub Actions", category: "Infrastructure", confirmed: true },
    { name: "Kafka", category: "Data", confirmed: false },
  ],
  certifications: [{ name: "AWS Certified Developer – Associate", issuer: "Amazon Web Services", date: "2022" }],
});

const facts = buildFacts(profileData);
const profile = saveProfileVersion(db, { data: profileData, facts, sourceText: "(demo)", sourceFileName: "demo.txt" });
const baseline = await renderResumeFiles(resolveBaseline(profileData), { kind: "baseline", key: `v${profile.version}` });
db.update(s.profiles).set({ baselinePdfPath: baseline.pdfPath, baselineDocxPath: baseline.docxPath }).where(eq(s.profiles.id, profile.id)).run();

const prefs = savePreferences(db, {
  targetTitles: ["Backend Engineer", "Software Engineer", "Platform Engineer"],
  locations: ["Austin", "Texas", "United States"],
  remotePolicy: "hybrid_ok",
  salaryFloor: 150000,
  seniority: ["senior", "staff"],
  workAuthorization: "US citizen",
  dryRun: true,
});

for (const [key, text, answer] of [
  ["are you legally authorized to work in the united states", "Are you legally authorized to work in the United States?", "Yes"],
  ["will you now or in the future require sponsorship for employment visa status", "Will you now or in the future require visa sponsorship?", "No"],
  ["how did you hear about this job", "How did you hear about this job?", "Company careers page"],
  ["eeo:gender", "Gender (voluntary self-identification)", "Decline to self-identify"],
] as const) {
  db.insert(s.qaBank).values({ questionKey: key, questionText: text, answer, approved: true }).onConflictDoNothing().run();
}

const source = db.insert(s.jobSources).values({ type: "greenhouse", name: "Demo boards", config: { boardToken: "demo" }, enabled: false, lastRunStatus: "ok", lastRunMessage: "Seeded demo data", lastRunAt: new Date().toISOString(), lastRunJobCount: 4 }).returning().get();

const baseReq: JobRequirements = {
  roleSummary: "",
  mustHaveSkills: [],
  niceToHaveSkills: [],
  minYearsExperience: null,
  seniority: null,
  educationRequirements: [],
  certifications: [],
  remote: "unknown",
  locationConstraints: [],
  workAuthorization: null,
  sponsorshipAvailable: null,
  industry: null,
  salaryMin: null,
  salaryMax: null,
  keyResponsibilities: [],
  atsKeywords: [],
};

const JOBS = [
  {
    n: 1,
    title: "Senior Backend Engineer, Payments",
    company: "Northwind Pay",
    location: "Remote - US",
    ats: "greenhouse" as const,
    salary: [165000, 205000],
    description:
      "Northwind Pay moves money for 40,000 small businesses. You'll build and scale the payment APIs at the core of our platform.\n\nWhat you'll do\n- Design and ship payment APIs in TypeScript and Go\n- Own reliability and latency of checkout services running on Kubernetes\n- Partner with risk on fraud-scoring performance\n\nRequirements\n- 5+ years building backend services\n- Strong TypeScript or Go\n- PostgreSQL at scale\n- Kubernetes in production\n\nNice to have\n- Kafka\n- Payments or fintech experience",
    req: {
      roleSummary: "Senior backend engineer building payment APIs for a small-business payments platform",
      mustHaveSkills: ["TypeScript", "Go", "PostgreSQL", "Kubernetes"],
      niceToHaveSkills: ["Kafka", "payments experience"],
      minYearsExperience: 5,
      seniority: "senior",
      remote: "remote",
      industry: "Fintech",
      salaryMin: 165000,
      salaryMax: 205000,
      keyResponsibilities: ["Design payment APIs", "Own checkout latency and reliability", "Improve fraud-scoring performance"],
      atsKeywords: ["TypeScript", "Go", "PostgreSQL", "Kubernetes", "Kafka", "payment APIs", "latency"],
    },
    state: "ready_for_review",
    flagged: true,
  },
  {
    n: 2,
    title: "Platform Engineer",
    company: "Brightline Health",
    location: "Austin, TX (Hybrid)",
    ats: "lever" as const,
    salary: [150000, 180000],
    description:
      "Brightline Health is hiring a Platform Engineer to run our AWS and Kubernetes infrastructure.\n\nResponsibilities\n- Operate EKS clusters and CI/CD with GitHub Actions\n- Improve developer build times\n\nRequirements\n- AWS\n- Kubernetes\n- CI/CD\n- 4+ years experience\n\nPreferred\n- Terraform",
    req: {
      roleSummary: "Platform engineer running AWS and Kubernetes infrastructure and CI/CD",
      mustHaveSkills: ["AWS", "Kubernetes", "CI/CD"],
      niceToHaveSkills: ["Terraform"],
      minYearsExperience: 4,
      seniority: "senior",
      remote: "hybrid",
      locationConstraints: ["Austin, TX"],
      industry: "Healthcare",
      salaryMin: 150000,
      salaryMax: 180000,
      keyResponsibilities: ["Operate EKS clusters", "Maintain CI/CD pipelines", "Reduce build times"],
      atsKeywords: ["AWS", "Kubernetes", "EKS", "GitHub Actions", "CI/CD", "Terraform"],
    },
    state: "needs_input",
    flagged: false,
  },
  {
    n: 3,
    title: "Software Engineer II, Orders",
    company: "Cartwheel",
    location: "Remote",
    ats: "ashby" as const,
    salary: [140000, 170000],
    description: "Cartwheel's orders team builds the APIs behind checkout and refunds.\n\nRequirements\n- 3+ years backend experience\n- PostgreSQL\n- REST APIs\n- Go or TypeScript",
    req: {
      roleSummary: "Backend engineer on orders and refunds APIs",
      mustHaveSkills: ["PostgreSQL", "REST APIs", "Go"],
      niceToHaveSkills: [],
      minYearsExperience: 3,
      seniority: "mid",
      remote: "remote",
      industry: "E-commerce",
      salaryMin: 140000,
      salaryMax: 170000,
      keyResponsibilities: ["Build order APIs", "Own refunds correctness"],
      atsKeywords: ["PostgreSQL", "REST", "Go", "TypeScript", "idempotency"],
    },
    state: "submitted",
    flagged: false,
  },
  {
    n: 4,
    title: "Registered Nurse, ICU",
    company: "St. Example Hospital",
    location: "Dallas, TX",
    ats: "other" as const,
    salary: [80000, 95000],
    description: "Provide critical care nursing in a 24-bed ICU. Active RN license and BLS/ACLS required.",
    req: {
      roleSummary: "ICU registered nurse",
      mustHaveSkills: ["RN license", "BLS", "ACLS"],
      niceToHaveSkills: [],
      minYearsExperience: 2,
      seniority: null,
      remote: "onsite",
      locationConstraints: ["Dallas, TX"],
      industry: "Healthcare",
      salaryMin: 80000,
      salaryMax: 95000,
      keyResponsibilities: ["Patient care"],
      atsKeywords: ["RN", "BLS", "ACLS"],
    },
    state: null,
    flagged: false,
  },
];

const W1 = "w_paylane";
const W2 = "w_shopco";

function tailoredFor(n: number, flagged: boolean): TailoredResume {
  const base: TailoredResume = {
    headline: "Senior Backend Engineer, Payments APIs",
    summary: { text: "Backend engineer with seven years building payment APIs and internal platforms in TypeScript and Go.", factIds: ["S"] },
    skills: [
      { category: "Languages", items: ["TypeScript", "Go", "SQL"] },
      { category: "Data", items: ["PostgreSQL", "Redis", "Kafka"] },
      { category: "Infrastructure", items: ["Kubernetes", "AWS", "GitHub Actions"] },
    ],
    work: [
      {
        workId: W1,
        bullets: [
          { text: "Built and operate a TypeScript payments API handling 2M requests per day", factIds: ["W1.1"] },
          { text: "Cut p95 checkout latency by 40% by moving fraud-scoring hot paths to Go", factIds: ["W1.2"] },
          { text: "Led migration of 14 services to Kubernetes with zero customer-facing downtime", factIds: ["W1.3"] },
          { text: "Mentored 3 engineers through promotion to mid-level", factIds: ["W1.4"] },
        ],
      },
      {
        workId: W2,
        bullets: [
          { text: "Added idempotency keys to the refunds API, eliminating duplicate refunds", factIds: ["W2.3"] },
          { text: "Maintained PostgreSQL schemas and tuned query performance for the order service", factIds: ["W2.1"] },
          { text: "Built GitHub Actions CI pipelines that cut build times from 25 to 9 minutes", factIds: ["W2.2"] },
        ],
      },
    ],
    projects: [],
    includeEducationIds: ["e_ut"],
    includeCertifications: ["AWS Certified Developer – Associate"],
    changeNotes: [
      "Led with payments API scale and latency work, which the posting emphasizes",
      "Used the posting's spelling for PostgreSQL and Kubernetes",
      "Moved the refunds idempotency bullet up for its payments relevance",
    ],
  };
  if (flagged) {
    // A realistic overreach for the demo: "architected" and "100+ merchants" are not in the facts.
    base.work[0]!.bullets[0] = { text: "Architected the payments platform processing 2M requests per day for 100+ enterprise merchants", factIds: ["W1.1"] };
  }
  if (n === 2) base.headline = "Backend and Platform Engineer, AWS and Kubernetes";
  return base;
}

for (const j of JOBS) {
  const requirements = { ...baseReq, ...j.req } as JobRequirements;
  const raw = {
    externalId: `demo:${j.n}`,
    title: j.title,
    company: j.company,
    location: j.location,
  };
  const job = db
    .insert(s.jobs)
    .values({
      sourceId: source.id,
      sourceType: "greenhouse",
      externalId: raw.externalId,
      dedupKey: jobDedupKey(raw),
      title: j.title,
      company: j.company,
      location: j.location,
      remote: requirements.remote === "remote",
      salaryMin: j.salary[0],
      salaryMax: j.salary[1],
      descriptionText: j.description,
      requirements,
      atsType: j.ats,
      applyUrl: j.ats === "other" ? "https://careers.example.org/jobs/icu-rn" : `https://example.com/demo/${j.ats}/${j.n}`,
      postingUrl: `https://example.com/demo/posting/${j.n}`,
      firstSeenAt: new Date(Date.now() - j.n * 5 * 3600_000).toISOString(),
    })
    .returning()
    .get();

  const breakdown = await scoreJob(profileData, prefs, { ...job, requirements });
  db.insert(s.jobMatches).values({ jobId: job.id, profileId: profile.id, scoreTotal: breakdown.total, breakdown, status: j.state ? "queued" : "new" }).run();
  if (!j.state) continue;

  const app = ensureApplication(db, job.id);
  transitionApplication(db, app.id, "tailoring");
  const t = validateTailored(profileData, facts, tailoredFor(j.n, j.flagged));
  const metrics = await measure(profileData, t.resume, { ...job, requirements });
  const items = [
    { location: "headline", claim: t.resume.headline, verdict: "entailed" as const, offendingSpan: "", explanation: "Matches title history" },
    { location: "summary", claim: t.resume.summary.text, verdict: "entailed" as const, offendingSpan: "", explanation: "" },
    ...t.resume.work.flatMap((w) =>
      w.bullets.map((b, i) => {
        const bad = j.flagged && w.workId === W1 && i === 0;
        return {
          location: `work:${w.workId}:${i}`,
          claim: b.text,
          verdict: bad ? ("exaggerated" as const) : ("entailed" as const),
          offendingSpan: bad ? "Architected the payments platform" : "",
          explanation: bad ? "Fact W1.1 says built and operate an API, not architected the platform; '100+ enterprise merchants' does not appear in any fact." : "",
        };
      }),
    ),
  ];
  const audit = { items, overall: items.some((i) => i.verdict !== "entailed") ? ("flagged" as const) : ("pass" as const) };
  const files = await renderResumeFiles(resolveTailored(profileData, t.resume), { kind: "tailored", key: app.id, company: job.company });
  const tr = db
    .insert(s.tailoredResumes)
    .values({
      jobId: job.id,
      profileId: profile.id,
      content: t.resume,
      ...metrics,
      audit,
      auditStatus: audit.overall,
      structuralErrors: t.issues.map((i) => `${i.location}: ${i.message}`),
      pdfPath: files.pdfPath,
      docxPath: files.docxPath,
      fileName: files.fileName,
      model: "demo",
    })
    .returning()
    .get();

  const letter: CoverLetter = {
    greeting: "Dear Hiring Team,",
    paragraphs: [
      { text: `I'm applying for the ${job.title} role at ${job.company}. For the last several years I've built and operated a TypeScript payments API that handles 2M requests per day, so the problems in this posting are ones I work on daily.`, factIds: ["W1", "W1.1"] },
      { text: "At Paylane I cut p95 checkout latency by 40% by moving fraud-scoring hot paths to Go, and led the migration of 14 services to Kubernetes without customer-facing downtime. Earlier, at ShopCo, I added idempotency keys to the refunds API and eliminated duplicate refunds.", factIds: ["W1.2", "W1.3", "W2.3"] },
      { text: "I'd welcome the chance to talk about how that experience fits your team's roadmap.", factIds: [] },
    ],
    closing: "Best regards,",
    signature: "Jordan Rivera",
  };
  const clFiles = await renderCoverLetterFiles(resolveCoverLetter(profileData, letter, job), app.id);
  const cl = db
    .insert(s.coverLetters)
    .values({
      jobId: job.id,
      tailoredResumeId: tr.id,
      content: letter,
      audit: { items: letter.paragraphs.map((p, i) => ({ location: `cover:${i}`, claim: p.text, verdict: "entailed" as const, offendingSpan: "", explanation: "" })), overall: "pass" },
      auditStatus: "pass",
      pdfPath: clFiles.pdfPath,
      fileName: clFiles.fileName,
      model: "demo",
    })
    .returning()
    .get();
  transitionApplication(db, app.id, "ready_for_review", "Resume and cover letter ready for review", { tailoredResumeId: tr.id, coverLetterId: cl.id });

  if (j.state === "needs_input") {
    transitionApplication(db, app.id, "approved", "Approved (dry run: will fill but not submit)", { dryRun: true, approvedAt: new Date().toISOString() });
    transitionApplication(db, app.id, "applying", "Filling the form (dry run)");
    transitionApplication(db, app.id, "needs_input", "1 question needs your answer", {
      needsInputReason: "1 question needs your answer before this application can be submitted.",
      pendingQuestions: [
        {
          questionKey: "brightline health:why are you interested in brightline health",
          label: "Why are you interested in Brightline Health?",
          type: "textarea",
          options: [],
          required: true,
          draftAnswer:
            "I've spent the last few years running production services on Kubernetes and AWS, including migrating 14 services to Kubernetes without customer-facing downtime. Brightline's platform role focuses on exactly that work, and I'd like to apply it to healthcare, where reliable infrastructure directly affects patients.",
        },
      ],
    });
  }
  if (j.state === "submitted") {
    transitionApplication(db, app.id, "approved", "Approved for submission", { dryRun: false, approvedAt: new Date(Date.now() - 50 * 3600_000).toISOString() });
    transitionApplication(db, app.id, "applying", "Submitting application");
    transitionApplication(db, app.id, "submitted", "Application submitted", {
      submittedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
      confirmationText: "Thanks for applying! Your application has been received.",
      submittedResumePath: files.pdfPath,
      submittedResumeSha256: files.pdfSha256,
      submittedCoverLetterPath: clFiles.pdfPath,
      submittedCoverLetterSha256: clFiles.pdfSha256,
      outcome: "recruiter_contact",
      outcomeNotes: "Recruiter emailed to schedule a phone screen",
      formSnapshot: {
        url: "https://jobs.ashbyhq.com/cartwheel/demo/application",
        capturedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
        fields: [
          { label: "Legal Name", name: "_systemfield_name", type: "text", value: "Jordan Rivera", required: true, source: "profile" },
          { label: "Email", name: "_systemfield_email", type: "email", value: "jordan.rivera@example.com", required: true, source: "profile" },
          { label: "Resume", name: "_systemfield_resume", type: "file", value: `resume: ${files.fileName}`, required: true, source: "file" },
          { label: "Cover Letter", name: "cover", type: "file", value: `cover letter: ${clFiles.fileName}`, required: false, source: "file" },
          { label: "Are you legally authorized to work in the United States?", name: "q1", type: "radio", value: "Yes", required: true, source: "qa_bank" },
          { label: "Gender", name: "gender", type: "combobox", value: "Decline to self-identify", required: false, source: "default" },
        ],
      },
    });
    logApplicationEvent(db, app.id, "outcome:recruiter_contact", "Recruiter emailed to schedule a phone screen");
  }
}

await closeRenderer();

console.log("Seeded demo profile, 4 jobs, and 3 applications in review, needs-input, and submitted states.");
process.exit(0);
