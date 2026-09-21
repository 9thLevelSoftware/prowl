import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { and, desc, eq, getActiveProfile, gte, like, or, schema as s, sql } from "@prowl/db";
import { APPLIABLE_ATS } from "@prowl/shared";
import { Badge, Card, EmptyState, Input, LinkButton, PageHeader, ScoreBadge, Select, StatusBadge, Table, Td, Th, Button, money, timeAgo } from "@/components/ui";
import { ActionButton } from "@/components/action";
import { setJobStatus, tailorJob } from "@/lib/actions/pipeline";
import { db, USER } from "@/lib/server";

const PAGE = 50;

export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const d = db();
  const profile = getActiveProfile(d, USER);
  const q = sp.q?.trim() ?? "";
  const min = Number(sp.min ?? 0) || 0;
  const view = sp.view ?? "active";
  const appliable = sp.appliable === "1";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);

  const where = [eq(s.jobs.userId, USER), eq(s.jobs.isActive, true)];
  if (q) where.push(or(like(s.jobs.title, `%${q}%`), like(s.jobs.company, `%${q}%`), like(s.jobs.location, `%${q}%`))!);
  if (min) where.push(gte(s.jobMatches.scoreTotal, min));
  if (appliable) where.push(sql`${s.jobs.atsType} in (${sql.join(APPLIABLE_ATS.map((a) => sql`${a}`), sql`, `)})`);
  if (view === "active") where.push(sql`coalesce(${s.jobMatches.status}, 'new') != 'ignored'`);
  if (view === "ignored") where.push(eq(s.jobMatches.status, "ignored"));
  if (view === "unscored") where.push(sql`${s.jobMatches.id} is null`);

  const matchJoin = profile ? and(eq(s.jobMatches.jobId, s.jobs.id), eq(s.jobMatches.profileId, profile.id)) : sql`0`;
  const rows = d
    .select({
      job: s.jobs,
      score: s.jobMatches.scoreTotal,
      breakdown: s.jobMatches.breakdown,
      matchStatus: s.jobMatches.status,
      appId: s.applications.id,
      appStatus: s.applications.status,
    })
    .from(s.jobs)
    .leftJoin(s.jobMatches, matchJoin)
    .leftJoin(s.applications, eq(s.applications.jobId, s.jobs.id))
    .where(and(...where))
    .orderBy(sql`${s.jobMatches.scoreTotal} is null`, desc(s.jobMatches.scoreTotal), desc(s.jobs.firstSeenAt))
    .limit(PAGE + 1)
    .offset((page - 1) * PAGE)
    .all();
  const hasMore = rows.length > PAGE;
  const list = rows.slice(0, PAGE);
  const total = d.select({ n: sql<number>`count(*)` }).from(s.jobs).where(and(eq(s.jobs.userId, USER), eq(s.jobs.isActive, true))).get()?.n ?? 0;

  const qs = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v !== undefined && v !== "") as [string, string][]);
    return `/jobs?${next}`;
  };

  return (
    <>
      <PageHeader
        title="Jobs"
        description={`${total} active postings found. Scores compare each posting to your confirmed profile and preferences.`}
        actions={<LinkButton href="/sources">Manage sources</LinkButton>}
      />
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/jobs">
        <Input name="q" defaultValue={q} placeholder="Search title, company, location" className="w-64" />
        <Select name="min" defaultValue={String(min || "")} className="w-36">
          <option value="">Any score</option>
          <option value="45">45+</option>
          <option value="60">60+</option>
          <option value="75">75+</option>
        </Select>
        <Select name="view" defaultValue={view} className="w-36">
          <option value="active">Not ignored</option>
          <option value="all">All</option>
          <option value="ignored">Ignored</option>
          <option value="unscored">Not scored yet</option>
        </Select>
        <Select name="appliable" defaultValue={appliable ? "1" : ""} className="w-48">
          <option value="">Any site</option>
          <option value="1">Auto-apply supported</option>
        </Select>
        <Button type="submit">Filter</Button>
      </form>

      {!profile ? (
        <EmptyState title="Add your profile to score jobs" action={<LinkButton href="/profile" variant="primary">Set up profile</LinkButton>}>
          Jobs are still collected, but they can't be matched until your resume is in.
        </EmptyState>
      ) : list.length === 0 ? (
        <EmptyState title="No jobs match these filters" action={<LinkButton href="/sources">Add job sources</LinkButton>}>
          New postings arrive as sources run. Try widening the filters.
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th className="w-14">Score</Th>
                <Th>Role</Th>
                <Th className="hidden lg:table-cell">Why</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {list.map(({ job, score, breakdown, matchStatus, appId, appStatus }) => (
                <tr key={job.id} className="hover:bg-panel-2/50">
                  <Td>
                    <ScoreBadge score={score} vetoed={breakdown?.vetoed} />
                  </Td>
                  <Td className="min-w-64">
                    <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                      {job.title}
                    </Link>
                    <p className="text-[13px] text-muted">
                      {job.company}
                      {job.location ? ` · ${job.location.slice(0, 60)}` : ""}
                      {job.salaryMax ? ` · ${money(job.salaryMin)}–${money(job.salaryMax)}` : ""}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[12px] text-muted">
                      {APPLIABLE_ATS.includes(job.atsType) ? <Badge tone="ok">Auto-apply</Badge> : <Badge>{job.atsType === "other" ? "Manual apply" : job.atsType}</Badge>}
                      <span>{job.sourceType}</span>
                      <span>· {timeAgo(job.firstSeenAt)}</span>
                    </p>
                  </Td>
                  <Td className="hidden max-w-sm text-[13px] text-muted lg:table-cell">
                    {job.processingError ? (
                      <span className="text-bad">{job.processingError}</span>
                    ) : breakdown ? (
                      <>
                        {breakdown.vetoed ? <p className="text-bad">{breakdown.vetoReasons.join("; ")}</p> : null}
                        {breakdown.reasons.slice(0, 3).map((r, i) => (
                          <p key={i}>{r}</p>
                        ))}
                      </>
                    ) : (
                      "Analyzing…"
                    )}
                  </Td>
                  <Td>{appStatus ? <Link href={`/applications/${appId}`}><StatusBadge status={appStatus} /></Link> : matchStatus === "ignored" ? <Badge>Ignored</Badge> : null}</Td>
                  <Td>
                    <div className="flex flex-wrap justify-end gap-1">
                      {!appStatus || ["skipped", "rejected_by_user", "failed", "matched"].includes(appStatus) ? (
                        <ActionButton size="sm" variant="primary" action={tailorJob.bind(null, job.id)} showResult={false}>
                          Tailor
                        </ActionButton>
                      ) : null}
                      {matchStatus !== "ignored" && !appStatus ? (
                        <ActionButton size="sm" variant="ghost" action={setJobStatus.bind(null, job.id, "ignored")} showResult={false}>
                          Ignore
                        </ActionButton>
                      ) : null}
                      <a href={job.postingUrl || job.applyUrl} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center px-1.5 text-muted hover:text-text" aria-label="Open posting">
                        <ExternalLink className="size-4" />
                      </a>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {page > 1 || hasMore ? (
        <div className="mt-4 flex gap-2">
          {page > 1 ? <LinkButton href={qs({ page: String(page - 1) })}>Previous</LinkButton> : null}
          {hasMore ? <LinkButton href={qs({ page: String(page + 1) })}>Next</LinkButton> : null}
        </div>
      ) : null}
    </>
  );
}
