import { desc, eq, gte, and, schema as s, sql, queueStats } from "@jh/db";
import { Badge, Card, CardBody, CardHeader, PageHeader, Stat, Table, Td, Th, formatDateTime, timeAgo } from "@/components/ui";
import { db, USER, workerOnline } from "@/lib/server";

export default function RunsPage() {
  const d = db();
  const worker = workerOnline();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const runs = d.select().from(s.pipelineRuns).where(eq(s.pipelineRuns.userId, USER)).orderBy(desc(s.pipelineRuns.startedAt)).limit(40).all();
  const byTask = d
    .select({
      task: s.llmCalls.task,
      model: s.llmCalls.model,
      calls: sql<number>`count(*)`,
      failures: sql<number>`sum(case when ${s.llmCalls.ok} then 0 else 1 end)`,
      input: sql<number>`sum(${s.llmCalls.inputTokens})`,
      output: sql<number>`sum(${s.llmCalls.outputTokens})`,
      cost: sql<number | null>`sum(${s.llmCalls.costUsd})`,
      avgMs: sql<number>`avg(${s.llmCalls.durationMs})`,
    })
    .from(s.llmCalls)
    .where(and(eq(s.llmCalls.userId, USER), gte(s.llmCalls.at, since)))
    .groupBy(s.llmCalls.task, s.llmCalls.model)
    .orderBy(desc(sql`count(*)`))
    .all();
  const totals = byTask.reduce((a, r) => ({ calls: a.calls + r.calls, tokens: a.tokens + r.input + r.output, cost: a.cost + (r.cost ?? 0) }), { calls: 0, tokens: 0, cost: 0 });
  const tailored = d.select({ n: sql<number>`count(*)` }).from(s.tailoredResumes).where(and(eq(s.tailoredResumes.userId, USER), gte(s.tailoredResumes.createdAt, since))).get()?.n ?? 0;
  const errors = d.select().from(s.llmCalls).where(and(eq(s.llmCalls.userId, USER), eq(s.llmCalls.ok, false))).orderBy(desc(s.llmCalls.at)).limit(8).all();
  const queue = queueStats(d);
  const failedTasks = d.select().from(s.queueTasks).where(eq(s.queueTasks.status, "failed")).orderBy(desc(s.queueTasks.updatedAt)).limit(10).all();

  return (
    <>
      <PageHeader title="Activity & costs" description="Background work, AI usage over the last 30 days, and anything that failed." />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Worker" value={worker.online ? "Running" : "Offline"} hint={worker.online ? (worker.currentTask ?? "Idle") : `Last seen ${timeAgo(worker.lastBeatAt)}`} />
        <Stat label="AI calls (30d)" value={totals.calls.toLocaleString()} hint={`${Math.round(totals.tokens / 1000).toLocaleString()}k tokens`} />
        <Stat label="Est. API cost (30d)" value={totals.cost ? `$${totals.cost.toFixed(2)}` : "—"} hint="Not tracked for subscription sign-in" />
        <Stat label="Per tailored application" value={tailored && totals.cost ? `$${(totals.cost / tailored).toFixed(2)}` : "—"} hint={`${tailored} tailored`} />
      </div>

      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader title="Queue" />
          <CardBody className="flex flex-wrap gap-2 text-[13px]">
            {Object.keys(queue).length ? (
              Object.entries(queue)
                .sort()
                .map(([k, n]) => (
                  <Badge key={k} tone={k.endsWith(":failed") ? "bad" : k.endsWith(":running") ? "busy" : k.endsWith(":pending") ? "accent" : "neutral"}>
                    {k.replace(":", " · ")} {n}
                  </Badge>
                ))
            ) : (
              <span className="text-muted">Empty</span>
            )}
          </CardBody>
          {failedTasks.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Failed task</Th>
                  <Th>Error</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {failedTasks.map((t) => (
                  <tr key={t.id}>
                    <Td className="whitespace-nowrap">{t.type}</Td>
                    <Td className="text-[13px] text-bad">{t.lastError?.slice(0, 300)}</Td>
                    <Td className="whitespace-nowrap text-[13px] text-muted">{timeAgo(t.updatedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </Card>

        <Card>
          <CardHeader title="AI usage by task" />
          <Table>
            <thead>
              <tr>
                <Th>Task</Th>
                <Th>Model</Th>
                <Th className="text-right">Calls</Th>
                <Th className="text-right">Failed</Th>
                <Th className="text-right">Tokens in / out</Th>
                <Th className="text-right">Avg time</Th>
                <Th className="text-right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {byTask.map((r) => (
                <tr key={`${r.task}-${r.model}`}>
                  <Td>{r.task}</Td>
                  <Td className="text-[13px] text-muted">{r.model}</Td>
                  <Td className="tabular text-right">{r.calls}</Td>
                  <Td className={`tabular text-right ${r.failures ? "text-bad" : "text-muted"}`}>{r.failures}</Td>
                  <Td className="tabular text-right text-[13px]">
                    {Math.round(r.input / 1000)}k / {Math.round(r.output / 1000)}k
                  </Td>
                  <Td className="tabular text-right text-[13px]">{(r.avgMs / 1000).toFixed(1)}s</Td>
                  <Td className="tabular text-right">{r.cost != null ? `$${r.cost.toFixed(2)}` : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        {errors.length ? (
          <Card>
            <CardHeader title="Recent AI errors" />
            <ul className="divide-y divide-border text-[13px]">
              {errors.map((e) => (
                <li key={e.id} className="px-4 py-2">
                  <p>
                    <span className="font-medium">{e.task}</span> <span className="text-muted">· {e.provider} {e.model} · {formatDateTime(e.at)}</span>
                  </p>
                  <p className="text-bad">{e.error}</p>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Discovery runs" />
          <Table>
            <thead>
              <tr>
                <Th>Run</Th>
                <Th>Result</Th>
                <Th>Started</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Badge tone={r.status === "done" ? "ok" : r.status === "failed" ? "bad" : "busy"}>{r.status}</Badge> {r.kind.replace("discover:", "")}
                  </Td>
                  <Td className="text-[13px] text-muted">{r.message}</Td>
                  <Td className="whitespace-nowrap text-[13px] text-muted">{formatDateTime(r.startedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
