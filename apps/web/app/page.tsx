import Link from "next/link";
import { and, desc, eq, gte, schema as s, sql } from "@prowl/db";
import { Card, CardBody, CardHeader, EmptyState, LinkButton, PageHeader, Stat, StatusBadge, timeAgo, Badge } from "@/components/ui";
import { ActionButton } from "@/components/action";
import { runAllSourcesAction } from "@/lib/actions/system";
import { db, USER } from "@/lib/server";
import { onboardingSteps } from "@/lib/onboarding";

export default function Dashboard() {
  const d = db();
  const steps = onboardingSteps();
  const remaining = steps.filter((x) => !x.done);

  const byStatus = Object.fromEntries(
    d
      .select({ status: s.applications.status, n: sql<number>`count(*)` })
      .from(s.applications)
      .where(eq(s.applications.userId, USER))
      .groupBy(s.applications.status)
      .all()
      .map((r) => [r.status, r.n]),
  ) as Record<string, number>;
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const jobsWeek = d.select({ n: sql<number>`count(*)` }).from(s.jobs).where(and(eq(s.jobs.userId, USER), gte(s.jobs.firstSeenAt, weekAgo))).get()?.n ?? 0;
  const submittedWeek =
    d
      .select({ n: sql<number>`count(*)` })
      .from(s.applications)
      .where(and(eq(s.applications.userId, USER), eq(s.applications.status, "submitted"), eq(s.applications.dryRun, false), gte(s.applications.submittedAt, weekAgo)))
      .get()?.n ?? 0;
  const interviews =
    d
      .select({ n: sql<number>`count(*)` })
      .from(s.applications)
      .where(and(eq(s.applications.userId, USER), sql`${s.applications.outcome} in ('recruiter_contact','interview','offer')`))
      .get()?.n ?? 0;

  const recent = d
    .select({
      id: s.applicationEvents.id,
      at: s.applicationEvents.at,
      type: s.applicationEvents.type,
      message: s.applicationEvents.message,
      applicationId: s.applicationEvents.applicationId,
      title: s.jobs.title,
      company: s.jobs.company,
      status: s.applications.status,
    })
    .from(s.applicationEvents)
    .innerJoin(s.applications, eq(s.applications.id, s.applicationEvents.applicationId))
    .innerJoin(s.jobs, eq(s.jobs.id, s.applications.jobId))
    .where(
      and(
        eq(s.applicationEvents.userId, USER),
        sql`${s.applicationEvents.type} not like 'screenshot:%' and ${s.applicationEvents.type} != 'apply:log'`,
        // Latest event per application only, so one busy application doesn't fill the list.
        sql`${s.applicationEvents.id} = (select e2.id from application_events e2 where e2.application_id = ${s.applicationEvents.applicationId} and e2.type not like 'screenshot:%' and e2.type != 'apply:log' order by e2.at desc, e2.rowid desc limit 1)`,
      ),
    )
    .orderBy(desc(s.applicationEvents.at))
    .limit(10)
    .all();

  const funnel = [
    { label: "Tailoring", n: (byStatus.matched ?? 0) + (byStatus.tailoring ?? 0), href: "/applications?status=tailoring" },
    { label: "Ready for review", n: byStatus.ready_for_review ?? 0, href: "/review" },
    { label: "Queued to apply", n: (byStatus.approved ?? 0) + (byStatus.applying ?? 0), href: "/applications?status=approved" },
    { label: "Needs you", n: byStatus.needs_input ?? 0, href: "/needs-input" },
    { label: "Submitted", n: byStatus.submitted ?? 0, href: "/applications?status=submitted" },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your search at a glance. Discovery and tailoring run in the background; you approve before anything is sent."
        actions={<ActionButton action={runAllSourcesAction} variant="primary">Find jobs now</ActionButton>}
      />

      {remaining.length ? (
        <Card className="mb-6">
          <CardHeader
            title={`Finish setup: ${steps.length - remaining.length} of ${steps.length} done`}
            actions={<LinkButton href="/onboarding" size="sm">See all steps</LinkButton>}
          />
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">{remaining[0]!.title}</p>
              <p className="text-muted">{remaining[0]!.description}</p>
            </div>
            <LinkButton href={remaining[0]!.href} variant="primary">
              {remaining[0]!.cta}
            </LinkButton>
          </CardBody>
        </Card>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="New jobs this week" value={jobsWeek} href="/jobs" />
        <Stat label="Waiting for review" value={byStatus.ready_for_review ?? 0} href="/review" hint="Approve to send" />
        <Stat label="Submitted this week" value={submittedWeek} href="/applications?status=submitted" />
        <Stat label="Responses" value={interviews} hint="Recruiter contact, interviews, offers" href="/applications" />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader title="Pipeline" description="Where every matched job currently sits" />
          <CardBody className="flex flex-col gap-2">
            {funnel.map((f) => {
              const max = Math.max(1, ...funnel.map((x) => x.n));
              return (
                <Link key={f.label} href={f.href} className="group grid grid-cols-[120px_1fr_36px] items-center gap-3">
                  <span className="text-[13px] text-muted group-hover:text-text">{f.label}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-panel-2">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${(f.n / max) * 100}%` }} />
                  </span>
                  <span className="tabular text-right font-medium">{f.n}</span>
                </Link>
              );
            })}
          </CardBody>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader title="Recent activity" actions={<LinkButton href="/applications" size="sm" variant="ghost">All applications</LinkButton>} />
          {recent.length ? (
            <ul className="divide-y divide-border">
              {recent.map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/applications/${e.applicationId}`} className="font-medium hover:underline">
                      {e.title} <span className="font-normal text-muted">at {e.company}</span>
                    </Link>
                    <p className="truncate text-[13px] text-muted">{e.message}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <StatusBadge status={e.status} />
                    <span className="text-[12px] text-muted">{timeAgo(e.at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <CardBody>
              <EmptyState title="No activity yet">Once sources are added and your profile is saved, matching jobs will start flowing here.</EmptyState>
            </CardBody>
          )}
        </Card>
      </div>
      {byStatus.needs_input ? (
        <p className="mt-6 text-[13px]">
          <Badge tone="warn">{byStatus.needs_input} need you</Badge>{" "}
          <Link href="/needs-input" className="underline">
            Answer questions or finish paused applications
          </Link>
        </p>
      ) : null}
    </>
  );
}
