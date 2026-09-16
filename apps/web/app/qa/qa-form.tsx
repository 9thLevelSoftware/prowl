"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Input, Label, LabelText, Select, Textarea } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { deleteQaAction, saveQaAction } from "@/lib/actions/system";

export interface CommonQ {
  key: string;
  text: string;
  type: "text" | "select" | "boolean";
  options?: string[];
  help?: string;
  answer: string;
}

export interface SavedQ {
  id: string;
  questionKey: string;
  questionText: string;
  answer: string;
  approved: boolean;
  timesUsed: number;
}

export function CommonQuestions({ questions }: { questions: CommonQ[] }) {
  const [answers, setAnswers] = useState<Record<string, string>>(Object.fromEntries(questions.map((q) => [q.key, q.answer])));
  const { pending, result, run } = useAction();
  return (
    <Card>
      <CardHeader title="Common screening questions" description="Answer these once. They're reused whenever an application asks the same thing, even with different wording." />
      <CardBody>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => saveQaAction(questions.map((q) => ({ questionKey: q.key, questionText: q.text, answer: answers[q.key] ?? "" }))));
          }}
        >
          {questions.map((q) => {
            const v = answers[q.key] ?? "";
            const set = (x: string) => setAnswers((a) => ({ ...a, [q.key]: x }));
            return (
              <Label key={q.key} hint={q.help}>
                <LabelText>{q.text}</LabelText>
                {q.type === "boolean" ? (
                  <Select value={v} onChange={(e) => set(e.target.value)}>
                    <option value="">Not answered</option>
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </Select>
                ) : q.type === "select" && q.options ? (
                  <Select value={v} onChange={(e) => set(e.target.value)}>
                    <option value="">Not answered</option>
                    {q.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </Select>
                ) : (
                  <Input value={v} onChange={(e) => set(e.target.value)} />
                )}
              </Label>
            );
          })}
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Save answers
            </Button>
            <ResultMessage result={result} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function SavedRow({ q }: { q: SavedQ }) {
  const [answer, setAnswer] = useState(q.answer);
  const save = useAction();
  const del = useAction();
  const companyKey = q.questionKey.includes(":") && !q.questionKey.startsWith("eeo:") ? q.questionKey.split(":")[0] : null;
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 font-medium">{q.questionText}</p>
        {!q.approved ? <Badge tone="warn">Draft, not approved</Badge> : null}
        {companyKey ? <Badge>{companyKey} only</Badge> : null}
        <span className="text-[12px] text-muted">used {q.timesUsed}×</span>
      </div>
      <div className="flex items-start gap-2">
        <Textarea rows={answer.length > 120 ? 4 : 1} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        <Button size="sm" disabled={save.pending || (answer === q.answer && q.approved)} onClick={() => save.run(() => saveQaAction([{ questionKey: q.questionKey, questionText: q.questionText, answer }]))}>
          {q.approved ? "Save" : "Approve"}
        </Button>
        <Button size="sm" variant="ghost" aria-label="Delete answer" disabled={del.pending} onClick={() => window.confirm("Delete this saved answer?") && del.run(() => deleteQaAction(q.id))}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <ResultMessage result={save.result ?? del.result} />
    </li>
  );
}

export function SavedAnswers({ saved }: { saved: SavedQ[] }) {
  const [filter, setFilter] = useState("");
  const list = saved.filter((q) => !filter || q.questionText.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Card>
      <CardHeader title={`All saved answers (${saved.length})`} description="Includes answers you gave while resolving paused applications." actions={<Input className="w-56" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />} />
      {list.length ? <ul className="divide-y divide-border">{list.map((q) => <SavedRow key={q.id} q={q} />)}</ul> : <CardBody className="text-muted">No saved answers yet.</CardBody>}
    </Card>
  );
}
