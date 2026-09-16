"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2, ChevronUp, ChevronDown, Sparkles, Loader2, Check } from "lucide-react";
import type { ProfileData } from "@jh/shared/schemas";
import { Badge, Button, Card, CardBody, CardHeader, Input, Label, LabelText, Textarea, cn } from "@/components/ui";
import { ResultMessage, useAction, type Result } from "@/components/action";
import { draftBullets, draftSummaryAction, saveProfile } from "@/lib/actions/profile";

let seq = 0;
const newId = (p: string) => `${p}new${Date.now().toString(36)}${(seq++).toString(36)}`;

function move<T>(arr: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const copy = [...arr];
  [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  return copy;
}

function BulletList({ bullets, onChange, placeholder }: { bullets: string[]; onChange: (b: string[]) => void; placeholder: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {bullets.map((b, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <span className="mt-2 text-muted">•</span>
          <Textarea rows={Math.max(1, Math.ceil(b.length / 110))} value={b} placeholder={placeholder} onChange={(e) => onChange(bullets.map((x, k) => (k === i ? e.target.value : x)))} />
          <div className="flex flex-col">
            <button type="button" aria-label="Move up" className="text-muted hover:text-text" onClick={() => onChange(move(bullets, i, -1))}>
              <ChevronUp className="size-4" />
            </button>
            <button type="button" aria-label="Move down" className="text-muted hover:text-text" onClick={() => onChange(move(bullets, i, 1))}>
              <ChevronDown className="size-4" />
            </button>
          </div>
          <button type="button" aria-label="Remove bullet" className="mt-1.5 text-muted hover:text-bad" onClick={() => onChange(bullets.filter((_, k) => k !== i))}>
            <Trash2 className="size-4" />
          </button>
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => onChange([...bullets, ""])}>
        <Plus className="size-3.5" /> Add bullet
      </Button>
    </div>
  );
}

function BulletHelper({ title, company, onAdd }: { title: string; company: string; onAdd: (b: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState<{ bullets: string[]; questions: string[] } | null>(null);
  const { pending, result, run } = useAction();
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Sparkles className="size-3.5" /> Write bullets from notes
      </Button>
    );
  }
  return (
    <div className="rounded-md border border-border bg-panel-2 p-3">
      <Label hint="Plain language is fine. Include real numbers only if you know them; the helper will not invent any.">
        <LabelText>What did you do in this role?</LabelText>
        <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. I ran the weekly payroll for about 200 staff, moved us from spreadsheets to ADP, trained two new hires..." />
      </Label>
      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const r = await draftBullets({ title, company, notes });
              if (r.ok) setDraft(r.data ?? null);
              return r as Result;
            })
          }
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Draft bullets
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
        <ResultMessage result={result} />
      </div>
      {draft ? (
        <div className="mt-3 flex flex-col gap-2">
          <ul className="list-disc space-y-1 pl-5">
            {draft.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          {draft.questions.length ? (
            <div className="text-[13px] text-muted">
              <p className="font-medium text-text">Could make these stronger:</p>
              <ul className="list-disc pl-5">
                {draft.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="self-start"
            onClick={() => {
              onAdd(draft.bullets);
              setDraft(null);
              setNotes("");
              setOpen(false);
            }}
          >
            <Check className="size-3.5" /> Add these bullets
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ProfileEditor({ initial }: { initial: ProfileData }) {
  const [p, setP] = useState<ProfileData>(initial);
  const [skillInput, setSkillInput] = useState("");
  const save = useAction();
  const summary = useAction();
  const set = <K extends keyof ProfileData>(k: K, v: ProfileData[K]) => setP((x) => ({ ...x, [k]: v }));
  const dirty = useMemo(() => JSON.stringify(p) !== JSON.stringify(initial), [p, initial]);
  const unconfirmed = p.skills.filter((s) => !s.confirmed).length;

  const skillCats = useMemo(() => {
    const m = new Map<string, number[]>();
    p.skills.forEach((s, i) => m.set(s.category || "General", [...(m.get(s.category || "General") ?? []), i]));
    return [...m.entries()];
  }, [p.skills]);

  return (
    <div className="flex flex-col gap-5 pb-24">
      <Card>
        <CardHeader title="Contact" description="Printed at the top of every resume and used to fill application forms." />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          {(["fullName", "email", "phone", "location"] as const).map((k) => (
            <Label key={k}>
              <LabelText required={k === "fullName" || k === "email"}>{{ fullName: "Full name", email: "Email", phone: "Phone", location: "Location (City, State)" }[k]}</LabelText>
              <Input value={p.contact[k]} onChange={(e) => set("contact", { ...p.contact, [k]: e.target.value })} />
            </Label>
          ))}
          <div className="sm:col-span-2">
            <LabelText>Links</LabelText>
            <div className="mt-1 flex flex-col gap-1.5">
              {p.contact.links.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <Input className="w-40" placeholder="LinkedIn" value={l.label} onChange={(e) => set("contact", { ...p.contact, links: p.contact.links.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
                  <Input placeholder="https://" value={l.url} onChange={(e) => set("contact", { ...p.contact, links: p.contact.links.map((x, k) => (k === i ? { ...x, url: e.target.value } : x)) })} />
                  <Button type="button" variant="ghost" aria-label="Remove link" onClick={() => set("contact", { ...p.contact, links: p.contact.links.filter((_, k) => k !== i) })}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => set("contact", { ...p.contact, links: [...p.contact.links, { label: "", url: "" }] })}>
                <Plus className="size-3.5" /> Add link
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Headline and summary"
          actions={
            <Button
              type="button"
              size="sm"
              disabled={summary.pending}
              onClick={() =>
                summary.run(async () => {
                  const r = await draftSummaryAction(JSON.stringify(p));
                  if (r.ok && r.data) setP((x) => ({ ...x, headline: r.data!.headline, summary: r.data!.summary }));
                  return r.ok ? { ok: true, message: "Draft added. Edit it so it sounds like you." } : r;
                })
              }
            >
              {summary.pending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Draft from my experience
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-3">
          <ResultMessage result={summary.result} />
          <Label>
            <LabelText>Headline</LabelText>
            <Input value={p.headline} onChange={(e) => set("headline", e.target.value)} placeholder="Senior Backend Engineer, Payments" />
          </Label>
          <Label>
            <LabelText>Summary</LabelText>
            <Textarea rows={3} value={p.summary} onChange={(e) => set("summary", e.target.value)} />
          </Label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Experience"
          description="These bullets are the facts every tailored resume must cite. Keep them accurate; tailoring can rephrase and reorder, never add."
          actions={
            <Button type="button" size="sm" onClick={() => set("work", [{ id: newId("w"), company: "", title: "", location: "", startDate: "", endDate: "present", bullets: [] }, ...p.work])}>
              <Plus className="size-3.5" /> Add role
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-5">
          {p.work.length === 0 ? <p className="text-muted">No roles yet. Add your most recent role first.</p> : null}
          {p.work.map((w, i) => {
            const upd = (patch: Partial<typeof w>) => set("work", p.work.map((x, k) => (k === i ? { ...x, ...patch } : x)));
            return (
              <div key={w.id} className="rounded-md border border-border p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_110px_110px_auto]">
                  <Input aria-label="Title" placeholder="Title" value={w.title} onChange={(e) => upd({ title: e.target.value })} />
                  <Input aria-label="Company" placeholder="Company" value={w.company} onChange={(e) => upd({ company: e.target.value })} />
                  <Input aria-label="Location" placeholder="Location" value={w.location} onChange={(e) => upd({ location: e.target.value })} />
                  <Input aria-label="Start" placeholder="2021-03" value={w.startDate} onChange={(e) => upd({ startDate: e.target.value })} />
                  <Input aria-label="End" placeholder="present" value={w.endDate} onChange={(e) => upd({ endDate: e.target.value })} />
                  <div className="flex">
                    <Button type="button" variant="ghost" aria-label="Move role up" onClick={() => set("work", move(p.work, i, -1))}>
                      <ChevronUp className="size-4" />
                    </Button>
                    <Button type="button" variant="ghost" aria-label="Remove role" onClick={() => window.confirm("Remove this role?") && set("work", p.work.filter((_, k) => k !== i))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                <div className="mt-3">
                  <BulletList bullets={w.bullets} onChange={(b) => upd({ bullets: b })} placeholder="What you did and what changed because of it" />
                  <BulletHelper title={w.title} company={w.company} onAdd={(b) => upd({ bullets: [...w.bullets.filter(Boolean), ...b] })} />
                </div>
              </div>
            );
          })}
        </CardBody>
      </Card>

      <Card id="skills">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Skills {unconfirmed ? <Badge tone="warn">{unconfirmed} unconfirmed</Badge> : <Badge tone="ok">All confirmed</Badge>}
            </span>
          }
          description="Confirm only skills you'd be comfortable being interviewed on. Unconfirmed skills never appear on tailored resumes. Aliases help match postings (e.g. K8s for Kubernetes)."
          actions={
            unconfirmed ? (
              <Button type="button" size="sm" onClick={() => set("skills", p.skills.map((s) => ({ ...s, confirmed: true })))}>
                Confirm all
              </Button>
            ) : null
          }
        />
        <CardBody className="flex flex-col gap-4">
          {skillCats.map(([cat, idxs]) => (
            <div key={cat}>
              <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-muted">{cat}</p>
              <div className="flex flex-wrap gap-1.5">
                {idxs.map((i) => {
                  const s = p.skills[i]!;
                  return (
                    <span key={i} className={cn("inline-flex items-center gap-1 rounded-md border py-0.5 pl-2 pr-1 text-[13px]", s.confirmed ? "border-ok/40 bg-ok-soft" : "border-dashed border-warn/60 bg-warn-soft")}>
                      <button
                        type="button"
                        title={s.confirmed ? "Confirmed. Click to unconfirm." : "Click to confirm"}
                        onClick={() => set("skills", p.skills.map((x, k) => (k === i ? { ...x, confirmed: !x.confirmed } : x)))}
                        className="flex items-center gap-1"
                      >
                        {s.confirmed ? <Check className="size-3 text-ok" /> : null}
                        {s.name}
                      </button>
                      <input
                        aria-label={`Aliases for ${s.name}`}
                        className="w-20 rounded bg-transparent px-1 text-[12px] text-muted placeholder:text-muted/60 focus:bg-panel focus:outline-none"
                        placeholder="aliases"
                        value={s.aliases.join(", ")}
                        onChange={(e) => set("skills", p.skills.map((x, k) => (k === i ? { ...x, aliases: e.target.value.split(",").map((a) => a.trim()).filter(Boolean) } : x)))}
                      />
                      <button type="button" aria-label={`Remove ${s.name}`} className="text-muted hover:text-bad" onClick={() => set("skills", p.skills.filter((_, k) => k !== i))}>
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const [name, category] = skillInput.split(":").map((x) => x.trim());
              if (!name) return;
              set("skills", [...p.skills, { name, category: category || "General", aliases: [], confirmed: true }]);
              setSkillInput("");
            }}
          >
            <Input value={skillInput} onChange={(e) => setSkillInput(e.target.value)} placeholder="Add a skill, optionally with a category: Terraform: Cloud" />
            <Button type="submit">Add</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Education"
          actions={
            <Button type="button" size="sm" onClick={() => set("education", [...p.education, { id: newId("e"), institution: "", degree: "", field: "", startDate: "", endDate: "", details: [] }])}>
              <Plus className="size-3.5" /> Add
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-3">
          {p.education.map((e, i) => {
            const upd = (patch: Partial<typeof e>) => set("education", p.education.map((x, k) => (k === i ? { ...x, ...patch } : x)));
            return (
              <div key={e.id} className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_90px_90px_auto]">
                <Input aria-label="Institution" placeholder="Institution" value={e.institution} onChange={(ev) => upd({ institution: ev.target.value })} />
                <Input aria-label="Degree" placeholder="Degree (BS, MBA…)" value={e.degree} onChange={(ev) => upd({ degree: ev.target.value })} />
                <Input aria-label="Field" placeholder="Field of study" value={e.field} onChange={(ev) => upd({ field: ev.target.value })} />
                <Input aria-label="Start" placeholder="Start" value={e.startDate} onChange={(ev) => upd({ startDate: ev.target.value })} />
                <Input aria-label="End" placeholder="End" value={e.endDate} onChange={(ev) => upd({ endDate: ev.target.value })} />
                <Button type="button" variant="ghost" aria-label="Remove education" onClick={() => set("education", p.education.filter((_, k) => k !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            );
          })}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Certifications"
          actions={
            <Button type="button" size="sm" onClick={() => set("certifications", [...p.certifications, { name: "", issuer: "", date: "" }])}>
              <Plus className="size-3.5" /> Add
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-2">
          {p.certifications.map((c, i) => {
            const upd = (patch: Partial<typeof c>) => set("certifications", p.certifications.map((x, k) => (k === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[1.5fr_1fr_110px_auto]">
                <Input aria-label="Certification" placeholder="Certification" value={c.name} onChange={(e) => upd({ name: e.target.value })} />
                <Input aria-label="Issuer" placeholder="Issuer" value={c.issuer} onChange={(e) => upd({ issuer: e.target.value })} />
                <Input aria-label="Date" placeholder="2023" value={c.date} onChange={(e) => upd({ date: e.target.value })} />
                <Button type="button" variant="ghost" aria-label="Remove certification" onClick={() => set("certifications", p.certifications.filter((_, k) => k !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            );
          })}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Projects"
          actions={
            <Button type="button" size="sm" onClick={() => set("projects", [...p.projects, { id: newId("p"), name: "", description: "", bullets: [], url: "" }])}>
              <Plus className="size-3.5" /> Add
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-4">
          {p.projects.map((pr, i) => {
            const upd = (patch: Partial<typeof pr>) => set("projects", p.projects.map((x, k) => (k === i ? { ...x, ...patch } : x)));
            return (
              <div key={pr.id} className="rounded-md border border-border p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <Input aria-label="Project name" placeholder="Project name" value={pr.name} onChange={(e) => upd({ name: e.target.value })} />
                  <Input aria-label="URL" placeholder="https://" value={pr.url} onChange={(e) => upd({ url: e.target.value })} />
                  <Button type="button" variant="ghost" aria-label="Remove project" onClick={() => set("projects", p.projects.filter((_, k) => k !== i))}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <Textarea className="mt-2" rows={2} placeholder="One-line description" value={pr.description} onChange={(e) => upd({ description: e.target.value })} />
                <div className="mt-2">
                  <BulletList bullets={pr.bullets} onChange={(b) => upd({ bullets: b })} placeholder="What you built and the result" />
                </div>
              </div>
            );
          })}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Private context" description="Never printed. Helps answer application questions truthfully, e.g. visa status, clearance, why you're looking, relocation constraints." />
        <CardBody>
          <Textarea rows={4} value={p.additionalContext} onChange={(e) => set("additionalContext", e.target.value)} />
        </CardBody>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-panel/95 backdrop-blur md:left-56">
        <div className="mx-auto flex max-w-[1200px] items-center gap-3 px-4 py-3 md:px-8">
          <Button variant="primary" disabled={save.pending || !dirty} onClick={() => save.run(() => saveProfile(JSON.stringify(p)))}>
            {save.pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save profile
          </Button>
          <span className="text-[13px] text-muted">{dirty ? "Unsaved changes" : "All changes saved"}</span>
          <ResultMessage result={save.result} />
        </div>
      </div>
    </div>
  );
}
