"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardHeader, Input } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { deleteAllDataAction } from "@/lib/actions/system";

export function DangerZone() {
  const [text, setText] = useState("");
  const { pending, result, run } = useAction();
  return (
    <Card className="border-bad/40">
      <CardHeader title="Delete all data" description="Removes your profile, jobs, applications, generated documents, screenshots, saved answers, and browser sign-ins. This cannot be undone." />
      <CardBody className="flex flex-wrap items-center gap-2">
        <Input className="w-40" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type DELETE" aria-label="Type DELETE to confirm" />
        <Button variant="danger" disabled={text !== "DELETE" || pending} onClick={() => run(() => deleteAllDataAction(text))}>
          Delete everything
        </Button>
        <ResultMessage result={result} />
      </CardBody>
    </Card>
  );
}
