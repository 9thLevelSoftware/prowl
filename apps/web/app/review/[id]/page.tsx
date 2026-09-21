import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, getPreferences, getProfileFacts, schema as s } from "@prowl/db";
import { APPLIABLE_ATS } from "@prowl/shared";
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader, StatusBadge, Table, Td, Th, buttonClass } from "@/components/ui";
import { db, fileUrl, USER } from "@/lib/server";
import { CoverLetterView, ResumeCompare } from "../resume-view";
import { ApprovePanel } from "../approve-panel";

export default async function ReviewDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();
  const app = d.select().from(s.applications).where(and(eq(s.applications.id, id), eq(s.applications.userId, USER))).get();
  if (!app) notFound();
  const job = d.select().from(s.jobs).where(eq(s.jobs.id, app.jobId)).get()!;
  const tr = app.tailoredResumeId ? d.select().from(s.tailoredResumes).where(eq(s.tailoredResumes.id, app.tailoredResumeId)).get() : undefined;
  const cl = app.coverLetterId ? d.select().from(s.coverLetters).where(eq(s.coverLetters.id, app.coverLetterId)).get() : undefined;
  const match = d.select().from(s.jobMatches).where(eq(s.jobMatches.jobId, job.id)).get();

  if (!tr) {
    return (
      <>
        <PageHeader title={`${job.title} at ${job.company}`} />
        <Notice tone={app.status === "failed" ? "bad" : "neutral"} title={app.status === "failed" ? "Tailoring failed" : "Not tailored yet"}>
          {app.errorText ?? "This application is still being prepared."}
        </Notice>
      </>
    );
  }
  const profile = d.select().from(s.profiles).where(eq(s.profiles.id, tr.profileId)).get()!;
  const facts = getProfileFacts(d, profile.id);
  const prefs = getPreferences(d, USER);
  const resumeFlags = tr.audit?.items.filter((i) => i.verdict !== "entailed") ?? [];
  const coverFlags = cl?.audit?.items.filter((i) => i.verdict !== "entailed") ?? [];
  const editable = app.status === "ready_for_review";

  return (
    <>
      <PageHeader
        title={`${job.title}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link href={`/jobs/${job.id}`} className="underline">
              {job.company}
            </Link>
            <span>· {job.location}</span>
            <StatusBadge status={app.status} dryRun={app.dryRun} />
            {match ? <Badge tone="accent">Match {Math.round(match.scoreTotal)}</Badge> : null}
          </span>
        }
        actions={
          <>
            {tr.pdfPath ? (
              <a className={buttonClass("secondary")} href={fileUrl(tr.pdfPath)!} target="_blank" rel="noreferrer">
                Resume PDF
              </a>
            ) : null}
            {tr.docxPath ? (
              <a className={buttonClass("secondary")} href={fileUrl(tr.docxPath, true)!}>
                DOCX
              </a>
            ) : null}
            {cl?.pdfPath ? (
              <a className={buttonClass("secondary")} href={fileUrl(cl.pdfPath)!} target="_blank" rel="noreferrer">
                Cover letter PDF
              </a>
            ) : null}
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          {tr.structuralErrors?.length ? (
            <Notice tone="neutral" title="Automatic corrections and checks">
              <ul className="list-disc pl-4">
                {tr.structuralErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <ResumeCompare applicationId={app.id} profile={profile.data} facts={facts} tailored={tr.content} audit={tr.audit?.items ?? []} editable={editable} />

          {cl ? <CoverLetterView applicationId={app.id} letter={cl.content} audit={cl.audit?.items ?? []} facts={facts} editable={editable} /> : null}

          <Card>
            <CardHeader title="What changed" />
            <CardBody>
              <ul className="list-disc space-y-1 pl-5 text-[13.5px]">
                {tr.content.changeNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>

        <aside className="flex flex-col gap-5">
          {editable ? (
            <ApprovePanel
              applicationId={app.id}
              resumeFlags={resumeFlags.length}
              coverFlags={coverFlags.length}
              resumeStatus={tr.auditStatus}
              coverStatus={cl?.auditStatus ?? null}
              dryRunDefault={prefs.dryRun}
              appliable={APPLIABLE_ATS.includes(job.atsType)}
            />
          ) : (
            <Notice tone="neutral" title="Already decided">
              This application is {app.status.replaceAll("_", " ")}.{" "}
              <Link className="underline" href={`/applications/${app.id}`}>
                View its history
              </Link>
            </Notice>
          )}

          <Card>
            <CardHeader title="ATS keyword coverage" description="Exact terms from the posting that a keyword filter looks for" />
            <CardBody className="text-[13px]">
              <div className="mb-3 grid grid-cols-2 gap-2">
                <div>
                  <p className="text-muted">Keywords</p>
                  <p className="tabular text-lg font-semibold">
                    {tr.keywordCoverageBefore ?? 0}% → {tr.keywordCoverageAfter ?? 0}%
                  </p>
                </div>
                <div>
                  <p className="text-muted">Semantic fit</p>
                  <p className="tabular text-lg font-semibold">
                    {tr.semanticBefore ?? 0} → {tr.semanticAfter ?? 0}
                  </p>
                </div>
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th className="px-1">Term</Th>
                    <Th className="px-1 text-center">Before</Th>
                    <Th className="px-1 text-center">After</Th>
                  </tr>
                </thead>
                <tbody>
                  {(tr.keywordReport ?? []).map((k) => (
                    <tr key={k.keyword}>
                      <Td className="px-1 py-1">
                        {k.keyword}
                        {!k.inProfile ? <span className="block text-[11px] text-muted">not in your profile</span> : null}
                      </Td>
                      <Td className="px-1 py-1 text-center">{k.before ? "✓" : "–"}</Td>
                      <Td className={`px-1 py-1 text-center ${k.after ? "text-ok" : "text-muted"}`}>{k.after ? "✓" : "–"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="mt-2 text-[12px] text-muted">Terms not in your profile are never added. Confirm the skill in your profile if you genuinely have it.</p>
            </CardBody>
          </Card>
        </aside>
      </div>
    </>
  );
}
