"use client";

import { useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import type { AuditItem, CoverLetter, ProfileData, ProfileFact, TailoredResume } from "@jh/shared/schemas";
import { Badge, Button, Card, CardBody, CardHeader, Input, Textarea, cn } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { saveCoverLetterEdits, saveTailoredEdits } from "@/lib/actions/pipeline";

const VERDICT_TONE = { entailed: "ok", exaggerated: "warn", fabricated: "bad" } as const;

function highlight(text: string, span: string) {
  if (!span) return text;
  const i = text.toLowerCase().indexOf(span.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="flag">{text.slice(i, i + span.length)}</mark>
      {text.slice(i + span.length)}
    </>
  );
}

function Claim({ text, audit, factIds, facts }: { text: string; audit?: AuditItem; factIds?: string[]; facts: Map<string, ProfileFact> }) {
  const flagged = audit && audit.verdict !== "entailed";
  return (
    <div className={cn("group rounded px-1.5 py-1", flagged && (audit.verdict === "fabricated" ? "bg-bad-soft/60" : "bg-warn-soft/60"))}>
      <p className="leading-relaxed">{flagged ? highlight(text, audit.offendingSpan) : text}</p>
      {flagged ? (
        <p className="mt-0.5 text-[12px]">
          <Badge tone={VERDICT_TONE[audit.verdict]}>{audit.verdict}</Badge> <span className="text-muted">{audit.explanation}</span>
        </p>
      ) : null}
      {factIds?.length ? (
        <details className="mt-0.5 text-[12px] text-muted">
          <summary className="cursor-pointer select-none opacity-60 group-hover:opacity-100">Sources: {factIds.join(", ")}</summary>
          <ul className="mt-1 space-y-0.5 border-l border-border pl-2">
            {factIds.map((id) => (
              <li key={id}>
                <span className="font-mono">[{id}]</span> {facts.get(id)?.text ?? <span className="text-bad">unknown fact</span>}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function ResumeCompare({
  applicationId,
  profile,
  facts,
  tailored,
  audit,
  editable,
}: {
  applicationId: string;
  profile: ProfileData;
  facts: ProfileFact[];
  tailored: TailoredResume;
  audit: AuditItem[];
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TailoredResume>(tailored);
  const save = useAction();
  const factMap = new Map(facts.map((f) => [f.id, f]));
  const auditAt = (loc: string) => audit.find((a) => a.location === loc);
  const work = new Map(tailored.work.map((w) => [w.workId, w]));

  if (editing) {
    const setBullet = (wi: number, bi: number, text: string) =>
      setDraft((d) => ({ ...d, work: d.work.map((w, i) => (i !== wi ? w : { ...w, bullets: w.bullets.map((b, j) => (j === bi ? { ...b, text } : b)) })) }));
    return (
      <Card>
        <CardHeader
          title="Edit tailored resume"
          description="Edits are re-checked against your facts and re-rendered when you save. Keep each bullet's sources accurate."
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(tailored); setEditing(false); }}>Cancel</Button>
              <Button size="sm" variant="primary" disabled={save.pending} onClick={() => save.run(() => saveTailoredEdits(applicationId, JSON.stringify(draft)), () => setEditing(false))}>
                {save.pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Save and re-check
              </Button>
            </>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <ResultMessage result={save.result} />
          <Input value={draft.headline} onChange={(e) => setDraft({ ...draft, headline: e.target.value })} aria-label="Headline" />
          <Textarea rows={3} value={draft.summary.text} onChange={(e) => setDraft({ ...draft, summary: { ...draft.summary, text: e.target.value } })} aria-label="Summary" />
          <div>
            <p className="mb-1 text-[13px] font-medium">Skills (only confirmed skills are kept)</p>
            {draft.skills.map((g, gi) => (
              <div key={gi} className="mb-1.5 flex gap-2">
                <Input className="w-40" value={g.category} onChange={(e) => setDraft({ ...draft, skills: draft.skills.map((x, i) => (i === gi ? { ...x, category: e.target.value } : x)) })} />
                <Input value={g.items.join(", ")} onChange={(e) => setDraft({ ...draft, skills: draft.skills.map((x, i) => (i === gi ? { ...x, items: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) } : x)) })} />
              </div>
            ))}
          </div>
          {draft.work.map((w, wi) => {
            const role = profile.work.find((r) => r.id === w.workId);
            return (
              <div key={w.workId}>
                <p className="mb-1 font-medium">
                  {role?.title}, {role?.company}
                </p>
                {w.bullets.map((b, bi) => (
                  <div key={bi} className="mb-1.5 flex items-start gap-2">
                    <Textarea rows={2} value={b.text} onChange={(e) => setBullet(wi, bi, e.target.value)} />
                    <Input className="w-28 font-mono text-[12px]" title="Fact ids" value={b.factIds.join(",")} onChange={(e) => setDraft((d) => ({ ...d, work: d.work.map((x, i) => (i !== wi ? x : { ...x, bullets: x.bullets.map((y, j) => (j === bi ? { ...y, factIds: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) } : y)) })) }))} />
                    <Button size="sm" variant="ghost" aria-label="Remove bullet" onClick={() => setDraft((d) => ({ ...d, work: d.work.map((x, i) => (i !== wi ? x : { ...x, bullets: x.bullets.filter((_, j) => j !== bi) })) }))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
                {role?.bullets.length ? (
                  <details className="text-[12px] text-muted">
                    <summary className="cursor-pointer">Add an original bullet from this role</summary>
                    <ul className="mt-1 space-y-1">
                      {role.bullets.map((ob, oi) => {
                        const rolePos = profile.work.findIndex((r) => r.id === w.workId) + 1;
                        const fid = `W${rolePos}.${oi + 1}`;
                        return (
                          <li key={oi}>
                            <button type="button" className="flex items-start gap-1 text-left hover:text-text" onClick={() => setDraft((d) => ({ ...d, work: d.work.map((x, i) => (i !== wi ? x : { ...x, bullets: [...x.bullets, { text: ob, factIds: [fid] }] })) }))}>
                              <Plus className="mt-0.5 size-3 shrink-0" /> {ob}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                ) : null}
              </div>
            );
          })}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Resume: original vs tailored"
        description="Employers, titles, and dates always come from your profile. Hover a tailored line to see which facts it cites."
        actions={
          editable ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
          ) : null
        }
      />
      <CardBody className="grid gap-x-6 gap-y-4 text-[13.5px] md:grid-cols-2">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted">Original</p>
        <p className="hidden text-[12px] font-medium uppercase tracking-wide text-muted md:block">Tailored</p>

        <div className="text-muted">
          <p className="font-medium text-text">{profile.headline}</p>
          <p className="mt-1">{profile.summary}</p>
        </div>
        <div>
          <Claim text={tailored.headline} audit={auditAt("headline")} facts={factMap} />
          <Claim text={tailored.summary.text} audit={auditAt("summary")} factIds={tailored.summary.factIds} facts={factMap} />
        </div>

        <div className="text-muted">
          <p className="font-medium text-text">Skills</p>
          <p>{profile.skills.filter((x) => x.confirmed).map((x) => x.name).join(", ")}</p>
        </div>
        <div>
          <p className="px-1.5 font-medium">Skills</p>
          {tailored.skills.map((g) => (
            <p key={g.category} className="px-1.5">
              <span className="font-medium">{g.category}:</span> {g.items.join(", ")}
            </p>
          ))}
          {auditAt("skills") && auditAt("skills")!.verdict !== "entailed" ? <Claim text="" audit={auditAt("skills")} facts={factMap} /> : null}
        </div>

        {profile.work.map((role) => {
          const tw = work.get(role.id);
          return (
            <div key={role.id} className="contents">
              <div className="text-muted">
                <p className="font-medium text-text">
                  {role.title}, {role.company}
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {role.bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="px-1.5 font-medium">
                  {role.title}, {role.company}
                </p>
                {tw ? (
                  tw.bullets.map((b, i) => <Claim key={i} text={`• ${b.text}`} audit={auditAt(`work:${role.id}:${i}`)} factIds={b.factIds} facts={factMap} />)
                ) : (
                  <p className="px-1.5 text-[13px] text-muted">Original bullets kept</p>
                )}
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

export function CoverLetterView({ applicationId, letter, audit, facts, editable }: { applicationId: string; letter: CoverLetter; audit: AuditItem[]; facts: ProfileFact[]; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(letter);
  const save = useAction();
  const factMap = new Map(facts.map((f) => [f.id, f]));
  return (
    <Card>
      <CardHeader
        title="Cover letter"
        actions={
          editable ? (
            editing ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => { setDraft(letter); setEditing(false); }}>Cancel</Button>
                <Button size="sm" variant="primary" disabled={save.pending} onClick={() => save.run(() => saveCoverLetterEdits(applicationId, JSON.stringify(draft)), () => setEditing(false))}>
                  {save.pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Save and re-check
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            )
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-2 text-[14px] leading-relaxed">
        <ResultMessage result={save.result} />
        {editing ? (
          <>
            <Input value={draft.greeting} onChange={(e) => setDraft({ ...draft, greeting: e.target.value })} />
            {draft.paragraphs.map((p, i) => (
              <Textarea key={i} rows={5} value={p.text} onChange={(e) => setDraft({ ...draft, paragraphs: draft.paragraphs.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)) })} />
            ))}
            <Input value={draft.closing} onChange={(e) => setDraft({ ...draft, closing: e.target.value })} />
          </>
        ) : (
          <>
            <p>{letter.greeting}</p>
            {letter.paragraphs.map((p, i) => (
              <Claim key={i} text={p.text} audit={audit.find((a) => a.location === `cover:${i}`)} factIds={p.factIds} facts={factMap} />
            ))}
            <p>
              {letter.closing}
              <br />
              {letter.signature}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
