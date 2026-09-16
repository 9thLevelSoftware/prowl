"use client";

import { useState } from "react";
import { OUTCOME_STATUSES } from "@jh/shared/schemas";
import { Button, Label, LabelText, OUTCOME_META, Select, Textarea } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { updateOutcomeAction } from "@/lib/actions/pipeline";

export function OutcomeForm({ applicationId, outcome, notes }: { applicationId: string; outcome: string; notes: string }) {
  const [o, setO] = useState(outcome);
  const [n, setN] = useState(notes);
  const { pending, result, run } = useAction();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updateOutcomeAction(applicationId, o, n));
      }}
    >
      <Label>
        <LabelText>Outcome</LabelText>
        <Select value={o} onChange={(e) => setO(e.target.value)}>
          {OUTCOME_STATUSES.map((x) => (
            <option key={x} value={x}>
              {OUTCOME_META[x]?.label ?? x}
            </option>
          ))}
        </Select>
      </Label>
      <Label>
        <LabelText>Notes</LabelText>
        <Textarea rows={3} value={n} onChange={(e) => setN(e.target.value)} placeholder="Recruiter name, interview dates, next steps" />
      </Label>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}
