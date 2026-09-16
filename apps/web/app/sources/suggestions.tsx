"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Sparkles, X } from "lucide-react";
import { Badge, Button, Card, CardHeader, EmptyState, cn } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { addSuggestionAction, dismissSuggestionAction, findMoreSourcesAction } from "@/lib/actions/interview";
import type { SuggestionView } from "@/app/interview/review/review-form";

const TYPE_LABEL: Record<string, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", adzuna: "Adzuna search", linkedin: "LinkedIn", indeed: "Indeed", careerpage: "Careers page" };
const ORIGIN_LABEL: Record<string, string> = { ai: "AI suggestion", web_search: "Web search", learned: "From jobs you found", search: "Search" };

function Row({ x }: { x: SuggestionView }) {
  const add = useAction();
  const [dismissing, startDismiss] = useTransition();
  const router = useRouter();
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{x.company}</span>
          <Badge>{TYPE_LABEL[x.type] ?? x.type}</Badge>
          {x.status === "unconfirmed" ? <Badge tone="warn">Unconfirmed match</Badge> : null}
          <span className="text-[12px] text-muted">{ORIGIN_LABEL[x.origin] ?? x.origin}</span>
        </p>
        {x.why ? <p className="text-[13px] text-muted">{x.why}</p> : null}
        {x.sampleTitles.length ? <p className="truncate text-[13px]">{x.sampleTitles.join(" · ")}</p> : null}
        {x.note ? <p className="text-[12px] text-warn">{x.note}</p> : null}
        <ResultMessage result={add.result} />
      </div>
      {x.jobsOpen !== null ? (
        <div className="shrink-0 text-right text-[13px]">
          <p className={cn("tabular font-semibold", (x.jobsMatching ?? 0) > 0 ? "text-ok" : "text-muted")}>{x.jobsMatching ?? 0} matching</p>
          <p className="tabular text-muted">{x.jobsOpen} open</p>
        </div>
      ) : null}
      <div className="flex shrink-0 gap-1">
        <Button size="sm" variant="primary" disabled={add.pending} onClick={() => add.run(() => addSuggestionAction(x.id))}>
          {add.pending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add
        </Button>
        <Button size="sm" variant="ghost" aria-label={`Dismiss ${x.company}`} disabled={dismissing} onClick={() => startDismiss(async () => { await dismissSuggestionAction(x.id); router.refresh(); })}>
          <X className="size-4" />
        </Button>
      </div>
    </li>
  );
}

export function SuggestedSources({ suggestions, running, message, searchProvider }: { suggestions: SuggestionView[]; running: boolean; message: string | null; searchProvider: string }) {
  const find = useAction();
  const withBoards = suggestions.filter((x) => x.type !== "careerpage");
  const noBoard = suggestions.filter((x) => x.type === "careerpage");
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Suggested sources {withBoards.length ? <Badge tone="accent">{withBoards.length}</Badge> : null}
          </span>
        }
        description={`Employers and searches that fit your profile and preferences, checked live. Web search: ${searchProvider}.`}
        actions={
          <Button disabled={running || find.pending} onClick={() => find.run(() => findMoreSourcesAction())}>
            {running || find.pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Find more companies
          </Button>
        }
      />
      {running ? (
        <p className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[13px] text-busy">
          <Loader2 className="size-4 animate-spin" /> {message ?? "Finding employers and job boards…"}
        </p>
      ) : null}
      <ResultMessage result={find.result} className="px-4 pt-2" />
      {withBoards.length ? (
        <ul className="divide-y divide-border">
          {withBoards.map((x) => (
            <Row key={x.id} x={x} />
          ))}
        </ul>
      ) : !running ? (
        <div className="p-4">
          <EmptyState title="No suggestions right now">Find more companies uses your profile and preferences to suggest employers, then checks their job boards live.</EmptyState>
        </div>
      ) : null}
      {noBoard.length ? (
        <details className="border-t border-border">
          <summary className="cursor-pointer px-4 py-3 text-[13px] text-muted">{noBoard.length} employer{noBoard.length === 1 ? "" : "s"} without a known job board (watch through their careers page)</summary>
          <ul className="divide-y divide-border">
            {noBoard.map((x) => (
              <Row key={x.id} x={x} />
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
