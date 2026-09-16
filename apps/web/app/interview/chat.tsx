"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Check, Circle, Loader2, Minus, RotateCcw, Sparkles } from "lucide-react";
import type { InterviewMessage } from "@jh/db/schema";
import type { InterviewDraft } from "@jh/core/interview";
import { Badge, Button, Card, CardBody, CardHeader, Textarea, cn } from "@/components/ui";
import { answerInterviewAction, finishInterviewAction, startOverAction } from "@/lib/actions/interview";

interface Topic {
  key: string;
  label: string;
  required: boolean;
}

const REMOTE_LABELS: Record<string, string> = { remote_only: "Remote only", hybrid_ok: "Remote or hybrid", onsite_ok: "Onsite is fine", any: "Any arrangement" };

function topicValue(key: string, d: InterviewDraft): string | null {
  const p = d.preferences;
  const list = (xs?: string[]) => (xs?.length ? xs.join(", ") : null);
  switch (key) {
    case "roles":
      return list(p.targetTitles);
    case "seniority":
      return list(p.seniority?.map((x) => x.charAt(0).toUpperCase() + x.slice(1)));
    case "industries":
      return list([...(p.industriesInclude ?? []), ...d.companyHints.industries, ...d.companyHints.pursue.map((c) => `pursue ${c}`), ...d.companyHints.avoid.map((c) => `avoid ${c}`)]);
    case "location":
      return [p.remotePolicy ? REMOTE_LABELS[p.remotePolicy] : null, list(p.locations)].filter(Boolean).join(" · ") || null;
    case "compensation":
      return p.salaryFloor ? `At least $${p.salaryFloor.toLocaleString()}` : null;
    case "authorization":
      return p.workAuthorization || null;
    case "sponsorship":
      return p.requiresSponsorship === undefined ? null : p.requiresSponsorship ? "Needs sponsorship" : "No sponsorship needed";
    case "start":
      return d.startDate || null;
    case "company_type":
      return list(d.companyHints.stageOrSize);
    case "dealbreakers":
      return list(d.dealbreakers);
    case "pace":
      return [p.dailyApplyCap !== undefined ? `${p.dailyApplyCap}/day` : null, p.dryRun === false ? "submit for real" : p.dryRun ? "dry run first" : null].filter(Boolean).join(" · ") || null;
    case "screening":
      return d.screeningAnswers.length ? `${d.screeningAnswers.length} answer${d.screeningAnswers.length === 1 ? "" : "s"}` : null;
    default:
      return null;
  }
}

export function InterviewChat({ interviewId, messages, draft, topics, roles }: { interviewId: string; messages: InterviewMessage[]; draft: InterviewDraft; topics: Topic[]; roles: Record<string, string> }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [sending, startSend] = useTransition();
  const [finishing, startFinish] = useTransition();
  const [elapsed, setElapsed] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = sending || finishing;
  const answered = messages.filter((m) => m.role === "user").length;
  const last = messages[messages.length - 1];
  const requiredOpen = topics.filter((t) => t.required && draft.coverage[t.key] === "open");

  useEffect(() => {
    // Braces matter: newer browsers return a promise from scrollIntoView, and React treats a returned value as cleanup.
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pendingText]);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  function send(answer: string) {
    const value = answer.trim();
    if (!value || busy) return;
    setError(null);
    setNotice(null);
    setPendingText(value);
    setText("");
    startSend(async () => {
      const r = await answerInterviewAction(interviewId, value);
      if (!r.ok) {
        setError(r.error);
        setText(value);
      } else {
        setReady(!!r.data?.readyToFinish);
        if (r.data?.rejected.length) setNotice("Some details weren't recorded because they didn't match your own words. You can add them on the review screen.");
      }
      setPendingText(null);
      router.refresh();
    });
  }

  function finish() {
    setError(null);
    startFinish(async () => {
      const r = await finishInterviewAction(interviewId);
      if (!r.ok) setError(r.error);
      else router.push("/interview/review");
    });
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="flex min-h-[70vh] min-w-0 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-5" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[85%] rounded-2xl px-4 py-2.5 text-[14.5px] leading-relaxed", m.role === "user" ? "rounded-br-sm bg-accent text-white dark:text-[#10131c]" : "rounded-bl-sm bg-panel-2")}>
                {m.content}
              </div>
            </div>
          ))}
          {pendingText ? (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-[14.5px] text-white opacity-80 dark:text-[#10131c]">{pendingText}</div>
            </div>
          ) : null}
          {busy ? (
            <div className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 className="size-4 animate-spin" />
              {finishing ? "Summarizing your answers" : "Thinking"} · {elapsed}s
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-border p-4">
          {!busy && last?.role === "assistant" && last.quickReplies?.length ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {last.quickReplies.map((q) => (
                <button key={q} type="button" onClick={() => send(q)} className="rounded-full border border-accent/40 bg-accent-soft/40 px-3 py-1 text-[13.5px] text-accent hover:bg-accent-soft">
                  {q}
                </button>
              ))}
            </div>
          ) : null}
          {error ? <p className="mb-2 text-[13px] text-bad" role="alert">{error}</p> : null}
          {notice ? <p className="mb-2 text-[13px] text-warn">{notice}</p> : null}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <Textarea
              aria-label="Your answer"
              rows={2}
              value={text}
              disabled={busy}
              placeholder={last?.inputKind === "number" ? "Type a number" : "Type your answer"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(text);
                }
              }}
            />
            <Button type="submit" variant="primary" aria-label="Send" disabled={busy || !text.trim()} className="h-10 w-10 shrink-0 p-0">
              <ArrowUp className="size-4" />
            </Button>
          </form>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => send("I'd rather skip this question.")}>
              Skip question
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Start the interview over? Your answers so far will be discarded.")) startSend(async () => {
                  await startOverAction(interviewId);
                  router.refresh();
                });
              }}
            >
              <RotateCcw className="size-3.5" /> Start over
            </Button>
            <span className="ml-auto" />
            <Button size="sm" variant={ready || requiredOpen.length === 0 ? "primary" : "secondary"} disabled={busy || answered === 0} onClick={finish}>
              <Sparkles className="size-3.5" /> {ready || requiredOpen.length === 0 ? "Review my answers" : "I'm done"}
            </Button>
          </div>
        </div>
      </Card>

      <aside className="flex min-w-0 flex-col gap-5">
        <Card>
          <CardHeader title="What I've learned" description={requiredOpen.length ? `${requiredOpen.length} key topic${requiredOpen.length === 1 ? "" : "s"} left` : "All key topics covered"} />
          <CardBody>
            <ul className="flex flex-col gap-2.5 text-[13px]">
              {topics.map((t) => {
                const state = draft.coverage[t.key] ?? "open";
                const value = topicValue(t.key, draft);
                return (
                  <li key={t.key} className="flex gap-2">
                    <span className="mt-0.5">
                      {state === "covered" ? <Check className="size-4 text-ok" /> : state === "skipped" ? <Minus className="size-4 text-muted" /> : <Circle className="size-4 text-border" />}
                    </span>
                    <span className="min-w-0">
                      <span className={cn("font-medium", state === "open" && "text-muted")}>
                        {t.label}
                        {t.required && state === "open" ? <span className="text-muted"> · needed</span> : null}
                      </span>
                      {value ? <span className="block truncate text-muted">{value}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
        {draft.profileAdditions.length ? (
          <Card>
            <CardHeader title="Possible profile additions" description="You'll confirm each one on the review screen" />
            <CardBody>
              <ul className="flex flex-col gap-2 text-[13px]">
                {draft.profileAdditions.map((a) => (
                  <li key={a.id}>
                    <Badge>{a.kind}</Badge> {a.text}
                    {a.workId && roles[a.workId] ? <span className="block text-muted">{roles[a.workId]}</span> : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
      </aside>
    </div>
  );
}
