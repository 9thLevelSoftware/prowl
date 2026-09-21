"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { Preferences } from "@prowl/shared/schemas";
import type { InterviewDraft } from "@prowl/core/interview";
import { Badge, Button, Card, CardBody, CardHeader, Input, Notice, cn } from "@/components/ui";
import { PreferencesFields } from "@/app/preferences/form";
import { applyInterviewAction, findMoreSourcesAction } from "@/lib/actions/interview";

export interface SuggestionView {
  id: string;
  company: string;
  type: string;
  origin: string;
  status: string;
  why: string;
  note: string | null;
  jobsOpen: number | null;
  jobsMatching: number | null;
  sampleTitles: string[];
  config: Record<string, unknown>;
}

const TYPE_LABEL: Record<string, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", adzuna: "Adzuna search", linkedin: "LinkedIn", indeed: "Indeed", careerpage: "Careers page" };
const ORIGIN_LABEL: Record<string, string> = { ai: "AI suggestion", web_search: "Web search", learned: "From jobs you found", search: "Search" };

/** Pre-check boards that are confirmed and have matching jobs, plus job-board searches (not LinkedIn/Indeed). */
function defaultChecked(x: SuggestionView): boolean {
  if (x.type === "adzuna") return true;
  if (x.type === "linkedin" || x.type === "indeed") return false;
  return x.status === "verified" && (x.jobsMatching ?? 0) > 0;
}

export function ReviewForm({
  interviewId,
  careerSummary,
  initialDraft,
  savedPreferences,
  roles,
  suggestions,
  sources,
}: {
  interviewId: string;
  careerSummary: string;
  initialDraft: InterviewDraft;
  savedPreferences: Preferences;
  roles: Record<string, string>;
  suggestions: SuggestionView[];
  sources: { running: boolean; message: string | null; failed: boolean };
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Preferences>({ ...savedPreferences, ...initialDraft.preferences } as Preferences);
  const [answers, setAnswers] = useState(initialDraft.screeningAnswers);
  const [additions, setAdditions] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [applying, startApply] = useTransition();
  const [finding, startFind] = useTransition();

  const checked = (x: SuggestionView) => overrides[x.id] ?? defaultChecked(x);
  const boards = useMemo(() => suggestions.filter((x) => ["greenhouse", "lever", "ashby"].includes(x.type)), [suggestions]);
  const searches = useMemo(() => suggestions.filter((x) => ["adzuna", "linkedin", "indeed"].includes(x.type)), [suggestions]);
  const noBoard = useMemo(() => suggestions.filter((x) => x.type === "careerpage"), [suggestions]);
  const selectedIds = suggestions.filter(checked).map((x) => x.id);
  const uncovered = Object.entries(initialDraft.coverage).filter(([, v]) => v === "open").length;

  const toggle = (id: string, value: boolean) => setOverrides((o) => ({ ...o, [id]: value }));

  function apply() {
    setResult(null);
    const draft: InterviewDraft = { ...initialDraft, preferences: prefs, screeningAnswers: answers.filter((a) => a.answer.trim()) };
    startApply(async () => {
      const r = await applyInterviewAction(interviewId, draft, [...additions], selectedIds);
      if (!r.ok) setResult({ ok: false, text: r.error });
      else {
        setResult({ ok: true, text: r.message ?? "Applied" });
        setTimeout(() => router.push("/sources"), 1500);
      }
    });
  }

  function SuggestionRow({ x }: { x: SuggestionView }) {
    return (
      <li className="flex items-start gap-3 px-4 py-3">
        <input type="checkbox" aria-label={`Watch ${x.company}`} className="mt-1 size-4 accent-[var(--accent)]" checked={checked(x)} onChange={(e) => toggle(x.id, e.target.checked)} />
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
        </div>
        {x.jobsOpen !== null ? (
          <div className="shrink-0 text-right text-[13px]">
            <p className={cn("tabular font-semibold", (x.jobsMatching ?? 0) > 0 ? "text-ok" : "text-muted")}>{x.jobsMatching ?? 0} matching</p>
            <p className="tabular text-muted">{x.jobsOpen} open</p>
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-24">
      {careerSummary ? <Notice tone="neutral" title="How the interviewer sees your background">{careerSummary}</Notice> : null}
      {uncovered ? <Notice tone="warn">{uncovered} topic{uncovered === 1 ? " wasn't" : "s weren't"} covered in the interview. Check the fields below before applying.</Notice> : null}

      <PreferencesFields value={prefs} onChange={setPrefs} />

      <Card>
        <CardHeader title="Screening answers" description="Reused whenever an application asks the same question. Taken from what you said in the interview." />
        <CardBody className="flex flex-col gap-3">
          {answers.length === 0 ? <p className="text-muted">No screening answers came up. You can add them later on the Saved answers page.</p> : null}
          {answers.map((a, i) => (
            <div key={a.questionKey} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
              <div>
                <p className="text-[13px] font-medium">{a.questionText}</p>
                <p className="text-[12px] text-muted">You said: “{a.evidence}”</p>
              </div>
              <Input aria-label={a.questionText} value={a.answer} onChange={(e) => setAnswers((xs) => xs.map((x, k) => (k === i ? { ...x, answer: e.target.value } : x)))} />
              <Button variant="ghost" size="sm" aria-label={`Remove answer to ${a.questionText}`} onClick={() => setAnswers((xs) => xs.filter((_, k) => k !== i))}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </CardBody>
      </Card>

      {initialDraft.profileAdditions.length ? (
        <Card>
          <CardHeader
            title="Add to your profile?"
            description="You mentioned these, but they aren't on your resume. Checked items become confirmed facts that tailored resumes may use. Only check what's accurate."
          />
          <ul className="divide-y divide-border">
            {initialDraft.profileAdditions.map((a) => (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label={`Add ${a.text}`}
                  className="mt-1 size-4 accent-[var(--accent)]"
                  checked={additions.has(a.id)}
                  onChange={(e) =>
                    setAdditions((set) => {
                      const next = new Set(set);
                      if (e.target.checked) next.add(a.id);
                      else next.delete(a.id);
                      return next;
                    })
                  }
                />
                <div className="min-w-0">
                  <p>
                    <Badge>{a.kind === "bullet" ? "accomplishment" : a.kind}</Badge> {a.text}
                  </p>
                  <p className="text-[12px] text-muted">
                    {a.workId && roles[a.workId] ? `${roles[a.workId]} · ` : a.kind === "bullet" ? "Saved as private context (no matching role) · " : ""}You said: “{a.evidence}”
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Job sources"
          description="Employers and searches that fit what you told the interviewer. Each company board was checked live; counts show open jobs and jobs matching your titles."
          actions={
            <Button size="sm" disabled={sources.running || finding} onClick={() => startFind(async () => { await findMoreSourcesAction(interviewId); router.refresh(); })}>
              <RefreshCw className="size-3.5" /> Find more
            </Button>
          }
        />
        {sources.running ? (
          <p className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[13px] text-busy">
            <Loader2 className="size-4 animate-spin" /> {sources.message ?? "Finding employers and job boards…"}
          </p>
        ) : sources.failed ? (
          <p className="border-b border-border px-4 py-2.5 text-[13px] text-bad">Finding sources failed: {sources.message}</p>
        ) : null}
        {boards.length ? (
          <>
            <p className="px-4 pt-3 text-[12px] font-medium uppercase tracking-wide text-muted">Company job boards ({boards.length})</p>
            <ul className="divide-y divide-border">{boards.map((x) => <SuggestionRow key={x.id} x={x} />)}</ul>
          </>
        ) : !sources.running ? (
          <CardBody className="text-muted">No company boards yet. Use Find more to search again.</CardBody>
        ) : null}
        {searches.length ? (
          <>
            <p className="border-t border-border px-4 pt-3 text-[12px] font-medium uppercase tracking-wide text-muted">Searches ({searches.length})</p>
            <ul className="divide-y divide-border">{searches.map((x) => <SuggestionRow key={x.id} x={x} />)}</ul>
          </>
        ) : null}
        {noBoard.length ? (
          <details className="border-t border-border">
            <summary className="cursor-pointer px-4 py-3 text-[13px] text-muted">
              {noBoard.length} employer{noBoard.length === 1 ? "" : "s"} without a Greenhouse, Lever, or Ashby board. They can be watched through their careers pages.
            </summary>
            <ul className="divide-y divide-border">{noBoard.map((x) => <SuggestionRow key={x.id} x={x} />)}</ul>
          </details>
        ) : null}
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-panel/95 backdrop-blur md:left-56">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-3 px-4 py-3 md:px-8">
          <Button variant="primary" size="lg" disabled={applying} onClick={apply}>
            {applying ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Apply
          </Button>
          <span className="text-[13px] text-muted">
            Saves preferences{answers.length ? `, ${answers.length} answer${answers.length === 1 ? "" : "s"}` : ""}
            {additions.size ? `, ${additions.size} profile addition${additions.size === 1 ? "" : "s"}` : ""}
            {selectedIds.length ? `, and adds ${selectedIds.length} source${selectedIds.length === 1 ? "" : "s"}` : ""}.
          </span>
          {result ? <span className={cn("text-[13px]", result.ok ? "text-ok" : "text-bad")} role={result.ok ? "status" : "alert"}>{result.text}</span> : null}
        </div>
      </div>
    </div>
  );
}
