import { and, desc, eq, schema as s } from "@prowl/db";
import type { ApplicationStatus, OutcomeStatus } from "@prowl/shared";
import { db, USER } from "@/lib/server";

export const dynamic = "force-dynamic";

const csv = (v: unknown) => {
  const t = v == null ? "" : String(v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const where = [eq(s.applications.userId, USER)];
  if (sp.get("status")) where.push(eq(s.applications.status, sp.get("status") as ApplicationStatus));
  if (sp.get("outcome")) where.push(eq(s.applications.outcome, sp.get("outcome") as OutcomeStatus));
  const rows = db()
    .select({ app: s.applications, job: s.jobs, tr: s.tailoredResumes, cl: s.coverLetters })
    .from(s.applications)
    .innerJoin(s.jobs, eq(s.jobs.id, s.applications.jobId))
    .leftJoin(s.tailoredResumes, eq(s.tailoredResumes.id, s.applications.tailoredResumeId))
    .leftJoin(s.coverLetters, eq(s.coverLetters.id, s.applications.coverLetterId))
    .where(and(...where))
    .orderBy(desc(s.applications.updatedAt))
    .all();

  const header = [
    "company",
    "title",
    "location",
    "status",
    "dry_run",
    "submitted_at",
    "outcome",
    "outcome_notes",
    "ats",
    "apply_url",
    "posting_url",
    "resume_file",
    "resume_sha256",
    "cover_letter_file",
    "cover_letter_sha256",
    "keyword_coverage_after",
    "audit_status",
    "confirmation",
    "application_id",
  ];
  const lines = [header.join(",")];
  for (const { app, job, tr, cl } of rows) {
    lines.push(
      [
        job.company,
        job.title,
        job.location,
        app.status,
        app.dryRun,
        app.submittedAt,
        app.outcome,
        app.outcomeNotes,
        job.atsType,
        job.applyUrl,
        job.postingUrl,
        app.submittedResumePath ?? tr?.pdfPath,
        app.submittedResumeSha256,
        app.submittedCoverLetterPath ?? cl?.pdfPath,
        app.submittedCoverLetterSha256,
        tr?.keywordCoverageAfter,
        tr?.auditStatus,
        app.confirmationText?.replace(/\s+/g, " ").slice(0, 300),
        app.id,
      ]
        .map(csv)
        .join(","),
    );
  }
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="applications-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
