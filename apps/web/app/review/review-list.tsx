"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { APPLIABLE_ATS, type AtsType } from "@prowl/shared/schemas";
import { Badge, Button, Card, ScoreBadge, Table, Td, Th, timeAgo } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { approveManyAction } from "@/lib/actions/pipeline";

export interface ReviewRow {
  id: string;
  title: string;
  company: string;
  location: string;
  atsType: AtsType;
  score: number | null;
  resumeAudit: string;
  coverAudit: string | null;
  flags: number;
  keywordsBefore: number | null;
  keywordsAfter: number | null;
  updatedAt: string;
}

export function ReviewList({ rows }: { rows: ReviewRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { pending, result, run } = useAction();
  const clean = rows.filter((r) => r.resumeAudit !== "flagged" && r.coverAudit !== "flagged");
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(clean.map((r) => r.id)))}>
          Select all without flags ({clean.length})
        </Button>
        <Button size="sm" variant="primary" disabled={!selected.size || pending} onClick={() => run(() => approveManyAction([...selected], true), () => setSelected(new Set()))}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Approve {selected.size || ""} as dry run
        </Button>
        <Button
          size="sm"
          variant="success"
          disabled={!selected.size || pending}
          onClick={() => window.confirm(`Submit ${selected.size} application(s) for real?`) && run(() => approveManyAction([...selected], false), () => setSelected(new Set()))}
        >
          Approve {selected.size || ""} and submit
        </Button>
        <ResultMessage result={result} />
      </div>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th className="w-8" />
              <Th className="w-14">Match</Th>
              <Th>Role</Th>
              <Th>Truthfulness</Th>
              <Th>Keywords</Th>
              <Th>Updated</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const flagged = r.resumeAudit === "flagged" || r.coverAudit === "flagged";
              return (
                <tr key={r.id} className="hover:bg-panel-2/50">
                  <Td>
                    <input type="checkbox" aria-label={`Select ${r.title}`} className="size-4 accent-[var(--accent)]" disabled={flagged} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </Td>
                  <Td>
                    <ScoreBadge score={r.score} />
                  </Td>
                  <Td>
                    <Link href={`/review/${r.id}`} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    <p className="text-[13px] text-muted">
                      {r.company} · {r.location.slice(0, 50)} {APPLIABLE_ATS.includes(r.atsType) ? null : <Badge>Manual apply</Badge>}
                    </p>
                  </Td>
                  <Td>
                    {flagged ? (
                      <Badge tone="warn">{r.flags} flag{r.flags === 1 ? "" : "s"} to resolve</Badge>
                    ) : r.resumeAudit === "accepted" || r.coverAudit === "accepted" ? (
                      <Badge tone="neutral">Flags accepted</Badge>
                    ) : (
                      <Badge tone="ok">All claims verified</Badge>
                    )}
                  </Td>
                  <Td className="tabular text-[13px]">{r.keywordsAfter != null ? `${r.keywordsBefore}% → ${r.keywordsAfter}%` : "—"}</Td>
                  <Td className="text-[13px] text-muted">{timeAgo(r.updatedAt)}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
