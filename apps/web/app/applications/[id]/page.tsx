import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, schema as s } from "@jh/db";
import { Badge, Card, CardBody, CardHeader, LinkButton, Notice, PageHeader, StatusBadge, buttonClass, formatDateTime } from "@/components/ui";
import { ActionButton } from "@/components/action";
import { markSubmittedManuallyAction, retryApplyAction } from "@/lib/actions/pipeline";
import { db, fileUrl, USER } from "@/lib/server";
import { OutcomeForm } from "./outcome-form";

export default async function ApplicationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();
  const app = d.select().from(s.applications).where(and(eq(s.applications.id, id), eq(s.applications.userId, USER))).get();
  if (!app) notFound();
  const job = d.select().from(s.jobs).where(eq(s.jobs.id, app.jobId)).get()!;
  const tr = app.tailoredResumeId ? d.select().from(s.tailoredResumes).where(eq(s.tailoredResumes.id, app.tailoredResumeId)).get() : undefined;
  const cl = app.coverLetterId ? d.select().from(s.coverLetters).where(eq(s.coverLetters.id, app.coverLetterId)).get() : undefined;
  const events = d.select().from(s.applicationEvents).where(eq(s.applicationEvents.applicationId, id)).orderBy(asc(s.applicationEvents.at)).all();
  const shots = events.filter((e) => e.screenshotPath);
  const logs = events.filter((e) => e.type === "apply:log");
  const timeline = events.filter((e) => !e.screenshotPath && e.type !== "apply:log");
  const resumePath = app.submittedResumePath ?? tr?.pdfPath;
  const coverPath = app.submittedCoverLetterPath ?? cl?.pdfPath;

  return (
    <>
      <PageHeader
        title={job.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link className="underline" href={`/jobs/${job.id}`}>
              {job.company}
            </Link>
            <span>· {job.location}</span>
            <StatusBadge status={app.status} dryRun={app.dryRun} />
          </span>
        }
        actions={
          <>
            {app.status === "ready_for_review" ? (
              <LinkButton href={`/review/${app.id}`} variant="primary">
                Review
              </LinkButton>
            ) : null}
            {app.status === "failed" ? <ActionButton action={retryApplyAction.bind(null, app.id)}>Retry</ActionButton> : null}
            <a className={buttonClass("secondary")} href={job.postingUrl || job.applyUrl} target="_blank" rel="noreferrer">
              Posting
            </a>
          </>
        }
      />

      {app.status === "failed" && app.errorText ? (
        <Notice tone="bad" title="Failed" className="mb-5">
          {app.errorText}
        </Notice>
      ) : null}
      {app.status === "needs_input" ? (
        <Notice tone="warn" title="Waiting on you" className="mb-5">
          {app.needsInputReason}{" "}
          <Link href="/needs-input" className="underline">
            Resolve
          </Link>
        </Notice>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <CardHeader title="Submission record" />
            <CardBody className="grid gap-4 text-[13.5px] sm:grid-cols-2">
              <dl className="space-y-1.5">
                <div>
                  <dt className="text-[12px] text-muted">Company</dt>
                  <dd>{job.company}</dd>
                </div>
                <div>
                  <dt className="text-[12px] text-muted">Position</dt>
                  <dd>{job.title}</dd>
                </div>
                <div>
                  <dt className="text-[12px] text-muted">Submitted</dt>
                  <dd>{app.submittedAt ? formatDateTime(app.submittedAt) : app.dryRun && app.formSnapshot ? "Dry run only (not submitted)" : "Not yet"}</dd>
                </div>
                <div>
                  <dt className="text-[12px] text-muted">Applied through</dt>
                  <dd className="break-all">
                    {job.atsType} ·{" "}
                    <a className="underline" href={app.formSnapshot?.url ?? job.applyUrl} target="_blank" rel="noreferrer">
                      {app.formSnapshot?.url ?? job.applyUrl}
                    </a>
                  </dd>
                </div>
              </dl>
              <dl className="space-y-1.5">
                <div>
                  <dt className="text-[12px] text-muted">Resume sent</dt>
                  <dd>
                    {resumePath ? (
                      <a className="underline" href={fileUrl(resumePath)!} target="_blank" rel="noreferrer">
                        {resumePath.split(/[\\/]/).pop()}
                      </a>
                    ) : (
                      "—"
                    )}
                    {app.submittedResumeSha256 ? <span className="block font-mono text-[11px] text-muted">sha256 {app.submittedResumeSha256.slice(0, 16)}…</span> : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-[12px] text-muted">Cover letter sent</dt>
                  <dd>
                    {coverPath ? (
                      <a className="underline" href={fileUrl(coverPath)!} target="_blank" rel="noreferrer">
                        {coverPath.split(/[\\/]/).pop()}
                      </a>
                    ) : (
                      "—"
                    )}
                    {app.submittedCoverLetterSha256 ? <span className="block font-mono text-[11px] text-muted">sha256 {app.submittedCoverLetterSha256.slice(0, 16)}…</span> : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-[12px] text-muted">Confirmation</dt>
                  <dd className="whitespace-pre-wrap text-muted">{app.confirmationText?.slice(0, 400) ?? "—"}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          {app.formSnapshot?.fields.length ? (
            <Card>
              <CardHeader title="Answers given" description={`Captured ${formatDateTime(app.formSnapshot.capturedAt)}`} />
              <div className="max-h-[480px] overflow-y-auto">
                <table className="w-full text-[13px]">
                  <tbody>
                    {app.formSnapshot.fields.map((f, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="w-2/5 px-4 py-1.5 align-top text-muted">
                          {f.label}
                          {f.required ? <span className="text-bad"> *</span> : null}
                        </td>
                        <td className="px-2 py-1.5 align-top whitespace-pre-wrap">{f.value || <span className="text-muted">(blank)</span>}</td>
                        <td className="px-4 py-1.5 text-right align-top">
                          <Badge>{f.source.replace("_", " ")}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {shots.length ? (
            <Card>
              <CardHeader title="Screenshots" />
              <CardBody className="grid gap-3 sm:grid-cols-2">
                {shots.map((e) => (
                  <a key={e.id} href={fileUrl(e.screenshotPath)!} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl(e.screenshotPath)!} alt={`Screenshot: ${e.message}`} className="max-h-72 w-full object-cover object-top" />
                    <p className="border-t border-border px-2 py-1 text-[12px] text-muted">
                      {e.message} · {formatDateTime(e.at)}
                    </p>
                  </a>
                ))}
              </CardBody>
            </Card>
          ) : null}

          {logs.length ? (
            <Card>
              <CardHeader title="Applier log" />
              <CardBody>
                {logs.map((l) => (
                  <pre key={l.id} className="mb-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-panel-2 p-2 font-mono text-[12px]">
                    {l.message}
                  </pre>
                ))}
              </CardBody>
            </Card>
          ) : null}
        </div>

        <aside className="flex flex-col gap-5">
          <Card>
            <CardHeader title="After submitting" description="Track what happens next" />
            <CardBody>
              <OutcomeForm applicationId={app.id} outcome={app.outcome} notes={app.outcomeNotes} />
              {app.status !== "submitted" && app.status !== "matched" && app.status !== "tailoring" ? (
                <div className="mt-3 border-t border-border pt-3">
                  <ActionButton size="sm" action={markSubmittedManuallyAction.bind(null, app.id, "")} confirm="Mark as submitted? Only do this if you applied yourself.">
                    I applied to this myself
                  </ActionButton>
                </div>
              ) : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Timeline" />
            <ol className="relative flex flex-col gap-3 px-4 py-3 text-[13px]">
              {timeline.map((e) => (
                <li key={e.id} className="border-l-2 border-border pl-3">
                  <p>{e.message || e.type}</p>
                  <p className="text-[12px] text-muted">{formatDateTime(e.at)}</p>
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>
    </>
  );
}
