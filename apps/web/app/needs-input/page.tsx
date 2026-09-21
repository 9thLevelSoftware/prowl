import Link from "next/link";
import { and, desc, eq, schema as s } from "@prowl/db";
import { APPLIABLE_ATS } from "@prowl/shared";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, buttonClass, timeAgo } from "@/components/ui";
import { ActionButton } from "@/components/action";
import { markSubmittedManuallyAction, retryApplyAction, skipApplicationAction, submitForRealAction } from "@/lib/actions/pipeline";
import { db, fileUrl, USER } from "@/lib/server";
import { QuestionsForm } from "./questions-form";

export default function NeedsInputPage() {
  const d = db();
  const rows = d
    .select({ app: s.applications, job: s.jobs, tr: s.tailoredResumes, cl: s.coverLetters })
    .from(s.applications)
    .innerJoin(s.jobs, eq(s.jobs.id, s.applications.jobId))
    .leftJoin(s.tailoredResumes, eq(s.tailoredResumes.id, s.applications.tailoredResumeId))
    .leftJoin(s.coverLetters, eq(s.coverLetters.id, s.applications.coverLetterId))
    .where(and(eq(s.applications.userId, USER), eq(s.applications.status, "needs_input")))
    .orderBy(desc(s.applications.updatedAt))
    .all();

  return (
    <>
      <PageHeader title="Needs you" description="Applications paused for a question only you can answer, a verification check, a dry-run review, or a site that needs a manual application." />
      {rows.length === 0 ? (
        <EmptyState title="Nothing is waiting on you">Paused applications show up here with exactly what they need.</EmptyState>
      ) : (
        <div className="flex flex-col gap-5">
          {rows.map(({ app, job, tr, cl }) => {
            const questions = app.pendingQuestions ?? [];
            const dryRunDone = app.dryRun && app.formSnapshot && !questions.length;
            const manual = !APPLIABLE_ATS.includes(job.atsType);
            const shot = app.confirmationScreenshotPath;
            return (
              <Card key={app.id}>
                <CardHeader
                  title={
                    <Link href={`/applications/${app.id}`} className="hover:underline">
                      {job.title} <span className="font-normal text-muted">at {job.company}</span>
                    </Link>
                  }
                  description={
                    <span className="flex flex-wrap items-center gap-2">
                      {questions.length ? <Badge tone="warn">{questions.length} question{questions.length === 1 ? "" : "s"}</Badge> : null}
                      {dryRunDone ? <Badge tone="accent">Dry run finished</Badge> : null}
                      {manual ? <Badge>Manual application</Badge> : null}
                      <span>{timeAgo(app.updatedAt)}</span>
                    </span>
                  }
                  actions={
                    <>
                      {tr?.pdfPath ? (
                        <a className={buttonClass("secondary", "sm")} href={fileUrl(tr.pdfPath)!} target="_blank" rel="noreferrer">
                          Resume
                        </a>
                      ) : null}
                      {cl?.pdfPath ? (
                        <a className={buttonClass("secondary", "sm")} href={fileUrl(cl.pdfPath)!} target="_blank" rel="noreferrer">
                          Cover letter
                        </a>
                      ) : null}
                      <a className={buttonClass("secondary", "sm")} href={job.applyUrl} target="_blank" rel="noreferrer">
                        Open application
                      </a>
                    </>
                  }
                />
                <CardBody className="flex flex-col gap-4">
                  <p>{app.needsInputReason}</p>
                  {questions.length ? <QuestionsForm applicationId={app.id} questions={questions} /> : null}

                  {dryRunDone ? (
                    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
                      <div className="max-h-80 overflow-y-auto rounded-md border border-border">
                        <table className="w-full text-[13px]">
                          <tbody>
                            {app.formSnapshot!.fields
                              .filter((f) => f.value)
                              .map((f, i) => (
                                <tr key={i} className="border-b border-border last:border-0">
                                  <td className="w-2/5 px-2 py-1 text-muted">{f.label}</td>
                                  <td className="px-2 py-1">{f.value.length > 200 ? `${f.value.slice(0, 200)}…` : f.value}</td>
                                  <td className="px-2 py-1 text-right">
                                    <Badge>{f.source.replace("_", " ")}</Badge>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                      {shot ? (
                        <a href={fileUrl(shot)!} target="_blank" rel="noreferrer" className="block max-h-80 overflow-hidden rounded-md border border-border">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={fileUrl(shot)!} alt="Filled application form before submission" className="w-full" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                    {dryRunDone ? (
                      <ActionButton variant="success" action={submitForRealAction.bind(null, app.id)} confirm="Submit this application for real?">
                        Submit for real
                      </ActionButton>
                    ) : null}
                    {!questions.length && !manual && !dryRunDone ? (
                      <ActionButton action={retryApplyAction.bind(null, app.id)}>Try again</ActionButton>
                    ) : null}
                    <ActionButton action={markSubmittedManuallyAction.bind(null, app.id, "")} confirm="Mark this application as submitted? Do this only after you've submitted it yourself.">
                      I submitted it myself
                    </ActionButton>
                    <ActionButton variant="ghost" action={skipApplicationAction.bind(null, app.id)}>
                      Skip
                    </ActionButton>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
