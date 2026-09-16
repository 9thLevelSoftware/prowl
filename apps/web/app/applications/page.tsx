import Link from "next/link";
import { and, desc, eq, like, or, schema as s, sql } from "@jh/db";
import { APPLICATION_STATUSES, OUTCOME_STATUSES } from "@jh/shared";
import { Badge, Button, Card, EmptyState, Input, OUTCOME_META, PageHeader, STATUS_META, Select, StatusBadge, Table, Td, Th, buttonClass, formatDateTime } from "@/components/ui";
import { db, fileUrl, USER } from "@/lib/server";

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const d = db();
  const where = [eq(s.applications.userId, USER)];
  if (sp.status) where.push(eq(s.applications.status, sp.status as (typeof APPLICATION_STATUSES)[number]));
  if (sp.outcome) where.push(eq(s.applications.outcome, sp.outcome as (typeof OUTCOME_STATUSES)[number]));
  if (sp.q) where.push(or(like(s.jobs.title, `%${sp.q}%`), like(s.jobs.company, `%${sp.q}%`))!);

  const rows = d
    .select({ app: s.applications, job: s.jobs, tr: s.tailoredResumes, cl: s.coverLetters })
    .from(s.applications)
    .innerJoin(s.jobs, eq(s.jobs.id, s.applications.jobId))
    .leftJoin(s.tailoredResumes, eq(s.tailoredResumes.id, s.applications.tailoredResumeId))
    .leftJoin(s.coverLetters, eq(s.coverLetters.id, s.applications.coverLetterId))
    .where(and(...where))
    .orderBy(sql`coalesce(${s.applications.submittedAt}, ${s.applications.updatedAt}) desc`)
    .limit(500)
    .all();

  const exportQs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <>
      <PageHeader
        title="Applications"
        description="Every application: where it went, when, which files were sent, and what happened next."
        actions={
          <a className={buttonClass("secondary")} href={`/api/export/applications?${exportQs}`}>
            Export CSV
          </a>
        }
      />
      <form className="mb-4 flex flex-wrap gap-2" action="/applications">
        <Input name="q" defaultValue={sp.q} placeholder="Search title or company" className="w-60" />
        <Select name="status" defaultValue={sp.status ?? ""} className="w-44">
          <option value="">Any status</option>
          {APPLICATION_STATUSES.map((st) => (
            <option key={st} value={st}>
              {STATUS_META[st]?.label ?? st}
            </option>
          ))}
        </Select>
        <Select name="outcome" defaultValue={sp.outcome ?? ""} className="w-44">
          <option value="">Any outcome</option>
          {OUTCOME_STATUSES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_META[o]?.label ?? o}
            </option>
          ))}
        </Select>
        <Button type="submit">Filter</Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No applications match">Applications appear here as soon as a job is matched and tailoring starts.</EmptyState>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>Submitted</Th>
                <Th>Files sent</Th>
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ app, job, tr, cl }) => (
                <tr key={app.id} className="hover:bg-panel-2/50">
                  <Td>
                    <Link href={`/applications/${app.id}`} className="font-medium hover:underline">
                      {job.title}
                    </Link>
                    <p className="text-[13px] text-muted">
                      {job.company} · {job.atsType}
                    </p>
                  </Td>
                  <Td>
                    <StatusBadge status={app.status} dryRun={app.dryRun} />
                  </Td>
                  <Td className="whitespace-nowrap text-[13px]">{app.submittedAt ? formatDateTime(app.submittedAt) : <span className="text-muted">—</span>}</Td>
                  <Td className="text-[13px]">
                    {app.submittedResumePath || tr?.pdfPath ? (
                      <a className="underline" href={fileUrl(app.submittedResumePath ?? tr?.pdfPath)!} target="_blank" rel="noreferrer">
                        Resume
                      </a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                    {app.submittedCoverLetterPath || cl?.pdfPath ? (
                      <>
                        {" · "}
                        <a className="underline" href={fileUrl(app.submittedCoverLetterPath ?? cl?.pdfPath)!} target="_blank" rel="noreferrer">
                          Cover letter
                        </a>
                      </>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={OUTCOME_META[app.outcome]?.tone}>{OUTCOME_META[app.outcome]?.label}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
