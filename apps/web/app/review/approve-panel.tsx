"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Notice, Textarea } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { acceptFlagsAction, approveAction, rejectAction, retailorAction } from "@/lib/actions/pipeline";

export function ApprovePanel({
  applicationId,
  resumeFlags,
  coverFlags,
  resumeStatus,
  coverStatus,
  dryRunDefault,
  appliable,
}: {
  applicationId: string;
  resumeFlags: number;
  coverFlags: number;
  resumeStatus: string;
  coverStatus: string | null;
  dryRunDefault: boolean;
  appliable: boolean;
}) {
  const approve = useAction();
  const other = useAction();
  const [note, setNote] = useState("");
  const blocked = resumeStatus === "flagged" || coverStatus === "flagged";

  return (
    <Card>
      <CardHeader title="Decision" />
      <CardBody className="flex flex-col gap-3">
        {blocked ? (
          <Notice tone="warn" title="Truthfulness flags need a decision">
            Edit the flagged lines, re-tailor, or confirm below that the flagged claims are accurate. Approval stays locked until then.
          </Notice>
        ) : (
          <Notice tone="ok" title="No unresolved flags">
            {resumeStatus === "accepted" || coverStatus === "accepted" ? "You accepted the flagged claims; that decision is in the audit trail." : "Every claim traced back to your confirmed facts."}
          </Notice>
        )}
        {!appliable ? <Notice tone="neutral">This site doesn't support automatic submission. Approving moves it to Needs you with the files ready to upload by hand.</Notice> : null}

        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" disabled={blocked || approve.pending} onClick={() => approve.run(() => approveAction(applicationId, true))}>
            {approve.pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Approve: dry run first
          </Button>
          <Button
            variant={dryRunDefault ? "secondary" : "success"}
            disabled={blocked || approve.pending}
            onClick={() => {
              if (window.confirm("Submit this application for real, without a dry run?")) approve.run(() => approveAction(applicationId, false));
            }}
          >
            Approve and submit
          </Button>
          <ResultMessage result={approve.result} />
        </div>

        {blocked ? (
          <div className="border-t border-border pt-3">
            <p className="mb-1 text-[13px] font-medium">Accept flagged claims as accurate</p>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why these are true (e.g. 'I did lead that migration; my original bullet undersold it')" />
            <div className="mt-2 flex flex-wrap gap-2">
              {resumeStatus === "flagged" ? (
                <Button size="sm" disabled={other.pending} onClick={() => other.run(() => acceptFlagsAction(applicationId, "resume", note))}>
                  Accept {resumeFlags} resume flag{resumeFlags === 1 ? "" : "s"}
                </Button>
              ) : null}
              {coverStatus === "flagged" ? (
                <Button size="sm" disabled={other.pending} onClick={() => other.run(() => acceptFlagsAction(applicationId, "cover", note))}>
                  Accept {coverFlags} cover letter flag{coverFlags === 1 ? "" : "s"}
                </Button>
              ) : null}
            </div>
            <p className="mt-1 text-[12px] text-muted">Better: update the bullet in your profile so future tailoring can use it honestly.</p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button size="sm" disabled={other.pending} onClick={() => other.run(() => retailorAction(applicationId))}>
            Re-tailor
          </Button>
          <Button size="sm" variant="danger" disabled={other.pending} onClick={() => window.confirm("Reject and ignore this job?") && other.run(() => rejectAction(applicationId))}>
            Reject
          </Button>
        </div>
        <ResultMessage result={other.result} />
      </CardBody>
    </Card>
  );
}
