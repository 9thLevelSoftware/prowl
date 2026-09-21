import { and, desc, eq, schema as s } from "@prowl/db";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { db, USER } from "@/lib/server";
import { ReviewList, type ReviewRow } from "./review-list";

export default function ReviewQueue() {
  const d = db();
  const rows = d
    .select({ app: s.applications, job: s.jobs, tr: s.tailoredResumes, cl: s.coverLetters, score: s.jobMatches.scoreTotal })
    .from(s.applications)
    .innerJoin(s.jobs, eq(s.jobs.id, s.applications.jobId))
    .leftJoin(s.tailoredResumes, eq(s.tailoredResumes.id, s.applications.tailoredResumeId))
    .leftJoin(s.coverLetters, eq(s.coverLetters.id, s.applications.coverLetterId))
    .leftJoin(s.jobMatches, eq(s.jobMatches.jobId, s.jobs.id))
    .where(and(eq(s.applications.userId, USER), eq(s.applications.status, "ready_for_review")))
    .orderBy(desc(s.jobMatches.scoreTotal), desc(s.applications.updatedAt))
    .all();

  const list: ReviewRow[] = rows.map(({ app, job, tr, cl, score }) => ({
    id: app.id,
    title: job.title,
    company: job.company,
    location: job.location,
    atsType: job.atsType,
    score: score ?? null,
    resumeAudit: tr?.auditStatus ?? "pending",
    coverAudit: cl?.auditStatus ?? null,
    flags: (tr?.audit?.items.filter((i) => i.verdict !== "entailed").length ?? 0) + (cl?.audit?.items.filter((i) => i.verdict !== "entailed").length ?? 0),
    keywordsBefore: tr?.keywordCoverageBefore ?? null,
    keywordsAfter: tr?.keywordCoverageAfter ?? null,
    updatedAt: app.updatedAt,
  }));

  return (
    <>
      <PageHeader
        title="Review"
        description="Tailored applications waiting for your decision. Items with truthfulness flags can't be approved until you resolve them."
      />
      {list.length ? (
        <ReviewList rows={list} />
      ) : (
        <EmptyState title="Nothing to review" action={<LinkButton href="/jobs">Browse jobs</LinkButton>}>
          Strong matches are tailored automatically. You can also pick a job and choose Tailor.
        </EmptyState>
      )}
    </>
  );
}
