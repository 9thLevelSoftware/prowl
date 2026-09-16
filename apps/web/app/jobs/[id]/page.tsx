import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, getActiveProfile, schema as s } from "@jh/db";
import { APPLIABLE_ATS } from "@jh/shared";
import { Badge, Card, CardBody, CardHeader, PageHeader, ScoreBadge, StatusBadge, buttonClass, money, formatDateTime } from "@/components/ui";
import { ActionButton } from "@/components/action";
import { rescoreJob, setJobStatus, tailorJob } from "@/lib/actions/pipeline";
import { db, USER } from "@/lib/server";

export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();
  const job = d.select().from(s.jobs).where(and(eq(s.jobs.id, id), eq(s.jobs.userId, USER))).get();
  if (!job) notFound();
  const profile = getActiveProfile(d, USER);
  const match = profile ? d.select().from(s.jobMatches).where(and(eq(s.jobMatches.jobId, id), eq(s.jobMatches.profileId, profile.id))).get() : undefined;
  const app = d.select().from(s.applications).where(eq(s.applications.jobId, id)).get();
  const r = job.requirements;
  const b = match?.breakdown;

  return (
    <>
      <PageHeader
        title={job.title}
        description={
          <span>
            {job.company} · {job.location || "Location not listed"}
            {job.salaryMax ? ` · ${money(job.salaryMin)}–${money(job.salaryMax)}` : ""} · found {formatDateTime(job.firstSeenAt)}
          </span>
        }
        actions={
          <>
            {app ? (
              <Link href={`/applications/${app.id}`} className={buttonClass("secondary")}>
                Application: <StatusBadge status={app.status} />
              </Link>
            ) : (
              <ActionButton variant="primary" action={tailorJob.bind(null, job.id)}>
                Tailor resume & cover letter
              </ActionButton>
            )}
            <a className={buttonClass("secondary")} href={job.postingUrl || job.applyUrl} target="_blank" rel="noreferrer">
              Open posting
            </a>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          {r ? (
            <Card>
              <CardHeader title="What they're asking for" description={r.roleSummary} />
              <CardBody className="grid gap-4 text-[13px] sm:grid-cols-2">
                <div>
                  <p className="mb-1 font-medium">Required</p>
                  <div className="flex flex-wrap gap-1">
                    {r.mustHaveSkills.map((x) => (
                      <Badge key={x} tone={b?.matchedSkills.includes(x) ? "ok" : b?.missingSkills.includes(x) ? "bad" : "neutral"}>
                        {x}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1 font-medium">Nice to have</p>
                  <div className="flex flex-wrap gap-1">
                    {r.niceToHaveSkills.map((x) => (
                      <Badge key={x}>{x}</Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1 font-medium">ATS keywords</p>
                  <p className="text-muted">{r.atsKeywords.join(", ")}</p>
                </div>
                <div className="space-y-0.5 text-muted">
                  <p>Experience: {r.minYearsExperience != null ? `${r.minYearsExperience}+ years` : "not stated"}</p>
                  <p>Seniority: {r.seniority ?? "not stated"}</p>
                  <p>Arrangement: {r.remote}</p>
                  {r.workAuthorization ? <p>Authorization: {r.workAuthorization}</p> : null}
                  {r.sponsorshipAvailable === false ? <p className="text-bad">No visa sponsorship</p> : null}
                </div>
              </CardBody>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Posting" />
            <CardBody>
              <div className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap text-[13.5px] leading-relaxed">{job.descriptionText || "No description was available."}</div>
            </CardBody>
          </Card>
        </div>
        <aside className="flex flex-col gap-5">
          <Card>
            <CardHeader title={<span className="flex items-center gap-2">Match <ScoreBadge score={match?.scoreTotal} vetoed={b?.vetoed} /></span>} />
            <CardBody className="text-[13px]">
              {b ? (
                <>
                  {b.vetoed ? <p className="mb-2 text-bad">{b.vetoReasons.join("; ")}</p> : null}
                  <dl className="grid grid-cols-[1fr_auto] gap-y-1">
                    <dt className="text-muted">Skills (35)</dt>
                    <dd className="tabular">{b.skills}</dd>
                    <dt className="text-muted">Semantic fit (25)</dt>
                    <dd className="tabular">{b.semantic}</dd>
                    <dt className="text-muted">Experience (20)</dt>
                    <dd className="tabular">{b.experience}</dd>
                    <dt className="text-muted">Preferences (20)</dt>
                    <dd className="tabular">{b.preference}</dd>
                  </dl>
                  <ul className="mt-3 list-disc space-y-0.5 pl-4 text-muted">
                    {b.reasons.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-muted">{job.processingError ?? "Not scored yet."}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <ActionButton size="sm" action={rescoreJob.bind(null, job.id)}>
                  Re-analyze
                </ActionButton>
                {match?.status !== "ignored" ? (
                  <ActionButton size="sm" variant="ghost" action={setJobStatus.bind(null, job.id, "ignored")}>
                    Ignore
                  </ActionButton>
                ) : (
                  <ActionButton size="sm" variant="ghost" action={setJobStatus.bind(null, job.id, "new")}>
                    Un-ignore
                  </ActionButton>
                )}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Applying" />
            <CardBody className="space-y-1 text-[13px] text-muted">
              <p>
                Site: <span className="text-text">{job.atsType}</span>{" "}
                {APPLIABLE_ATS.includes(job.atsType) ? <Badge tone="ok">Auto-apply</Badge> : <Badge>Manual</Badge>}
              </p>
              <p className="break-all">
                Apply URL:{" "}
                <a className="underline" href={job.applyUrl} target="_blank" rel="noreferrer">
                  {job.applyUrl}
                </a>
              </p>
              <p>Source: {job.sourceType}</p>
            </CardBody>
          </Card>
        </aside>
      </div>
    </>
  );
}
