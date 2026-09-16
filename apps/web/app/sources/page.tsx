import { and, desc, eq, inArray, listSuggestions, schema as s } from "@jh/db";
import { getLlm } from "@jh/llm";
import { firecrawlSettings } from "@jh/sources";
import { SuggestedSources } from "./suggestions";
import { ADAPTERS } from "@jh/sources";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, Td, Th, timeAgo } from "@/components/ui";
import { ActionButton } from "@/components/action";
import { deleteSourceAction, openBrowserLoginAction, runAllSourcesAction, runSourceAction, toggleSourceAction } from "@/lib/actions/system";
import { db, USER } from "@/lib/server";
import { AddSource, type AdapterMeta } from "./add-source";

export default function SourcesPage() {
  const sources = db().select().from(s.jobSources).where(eq(s.jobSources.userId, USER)).orderBy(desc(s.jobSources.createdAt)).all();
  const adapters: AdapterMeta[] = Object.values(ADAPTERS).map((a) => ({
    type: a.type,
    label: a.label,
    description: a.description,
    usesBrowser: a.usesBrowser,
    configFields: a.configFields,
  }));
  const adzunaReady = !!process.env.ADZUNA_APP_ID && !!process.env.ADZUNA_APP_KEY;

  return (
    <>
      <PageHeader
        title="Job sources"
        description="Where new postings come from. Enabled sources run on the schedule in Preferences; jobs are filtered by your target titles before any AI work."
        actions={
          <>
            <ActionButton action={openBrowserLoginAction.bind(null, "linkedin,indeed")}>Open browser to sign in</ActionButton>
            <ActionButton variant="primary" action={runAllSourcesAction}>
              Run all now
            </ActionButton>
          </>
        }
      />
      <div className="flex flex-col gap-5">
        <SuggestedSources
          suggestions={listSuggestions(db(), ["verified", "unconfirmed", "not_found", "pending"], USER).map((x) => ({ id: x.id, company: x.company, type: x.type, origin: x.origin, status: x.status, why: x.why, note: x.note, jobsOpen: x.jobsOpen, jobsMatching: x.jobsMatching, sampleTitles: x.sampleTitles ?? [], config: x.config }))}
          running={!!db().select({ id: s.queueTasks.id }).from(s.queueTasks).where(and(eq(s.queueTasks.type, "build_sources"), inArray(s.queueTasks.status, ["pending", "running"]))).get()}
          message={db().select().from(s.pipelineRuns).where(eq(s.pipelineRuns.kind, "build_sources")).orderBy(desc(s.pipelineRuns.startedAt)).get()?.message ?? null}
          searchProvider={getLlm(db()).canSearchWeb() ? "built into your AI connection" : firecrawlSettings(db()).enabled ? "Firecrawl" : "not available"}
        />
        <AddSource adapters={adapters} />
        {!adzunaReady ? (
          <p className="text-[13px] text-muted">
            Adzuna needs <code className="font-mono">ADZUNA_APP_ID</code> and <code className="font-mono">ADZUNA_APP_KEY</code> in your <code className="font-mono">.env</code> (free at developer.adzuna.com).
          </p>
        ) : null}
        <Card>
          <CardHeader title="Your sources" />
          {sources.length === 0 ? (
            <CardBody>
              <EmptyState title="No sources yet">
                A good start: add 5-10 companies you'd like to work for using their Greenhouse, Lever, or Ashby boards, plus one Adzuna search for your target title.
              </EmptyState>
            </CardBody>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Source</Th>
                  <Th>Last run</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {sources.map((src) => (
                  <tr key={src.id}>
                    <Td>
                      <p className="font-medium">
                        {src.name} {!src.enabled ? <Badge>Paused</Badge> : null}
                      </p>
                      <p className="text-[13px] text-muted">
                        {ADAPTERS[src.type]?.label ?? src.type} · {Object.entries(src.config).filter(([k]) => !["companyName", "resolveLimit"].includes(k)).map(([k, v]) => `${k}: ${v}`).join(", ")}
                      </p>
                    </Td>
                    <Td className="max-w-md text-[13px]">
                      {src.lastRunAt ? (
                        <>
                          <p>
                            <Badge tone={src.lastRunStatus === "ok" ? "ok" : "bad"}>{src.lastRunStatus === "ok" ? "OK" : "Error"}</Badge> <span className="text-muted">{timeAgo(src.lastRunAt)}</span>
                          </p>
                          <p className="mt-0.5 text-muted">{src.lastRunMessage}</p>
                        </>
                      ) : (
                        <span className="text-muted">Not run yet</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-1">
                        <ActionButton size="sm" action={runSourceAction.bind(null, src.id)} showResult={false}>
                          Run
                        </ActionButton>
                        <ActionButton size="sm" variant="ghost" action={toggleSourceAction.bind(null, src.id, !src.enabled)} showResult={false}>
                          {src.enabled ? "Pause" : "Resume"}
                        </ActionButton>
                        <ActionButton size="sm" variant="ghost" action={deleteSourceAction.bind(null, src.id)} confirm={`Remove ${src.name}?`} showResult={false}>
                          Remove
                        </ActionButton>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
