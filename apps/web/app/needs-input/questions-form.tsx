"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { PendingQuestion } from "@prowl/db/schema";
import { Button, Input, Label, LabelText, Select, Textarea } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { answerQuestionsAction } from "@/lib/actions/pipeline";

export function QuestionsForm({ applicationId, questions }: { applicationId: string; questions: PendingQuestion[] }) {
  const [answers, setAnswers] = useState<Record<string, string>>(Object.fromEntries(questions.map((q) => [q.questionKey, q.draftAnswer ?? ""])));
  const { pending, result, run } = useAction();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => answerQuestionsAction(applicationId, questions.map((q) => ({ questionKey: q.questionKey, label: q.label, answer: answers[q.questionKey] ?? "" }))));
      }}
    >
      {questions.map((q) => {
        const value = answers[q.questionKey] ?? "";
        const set = (v: string) => setAnswers((a) => ({ ...a, [q.questionKey]: v }));
        const companySpecific = q.questionKey.includes(":");
        return (
          <Label key={q.questionKey} hint={q.draftAnswer ? "Drafted from your profile. Edit it so it's accurate and sounds like you." : companySpecific ? "Saved for this company only." : "Saved and reused on future applications that ask the same thing."}>
            <LabelText required={q.required}>{q.label}</LabelText>
            {q.options.length && q.type !== "checkbox" ? (
              <Select value={value} onChange={(e) => set(e.target.value)}>
                <option value="">Choose…</option>
                {q.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : q.type === "textarea" ? (
              <Textarea rows={5} value={value} onChange={(e) => set(e.target.value)} />
            ) : q.type === "checkbox" ? (
              <Input value={value} onChange={(e) => set(e.target.value)} placeholder={`Separate choices with ; from: ${q.options.join(" | ")}`} />
            ) : q.type === "checkbox_single" ? (
              <Select value={value} onChange={(e) => set(e.target.value)}>
                <option value="">Choose…</option>
                <option value="yes">Yes, tick this box</option>
                <option value="no">No, leave it unticked</option>
              </Select>
            ) : (
              <Input value={value} onChange={(e) => set(e.target.value)} />
            )}
          </Label>
        );
      })}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save answers and continue
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}
