"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { startInterviewAction } from "@/lib/actions/interview";

export function StartInterview() {
  const { pending, result, run } = useAction();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" size="lg" disabled={pending} onClick={() => run(startInterviewAction)}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {pending ? "Reading your resume…" : "Start the interview"}
      </Button>
      {pending ? <span className="text-[13px] text-muted">The interviewer is reviewing your resume. This takes a moment.</span> : <ResultMessage result={result} />}
    </div>
  );
}
