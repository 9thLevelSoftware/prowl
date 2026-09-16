"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { SENIORITIES, type Preferences } from "@jh/shared/schemas";
import { Button, Card, CardBody, CardHeader, Checkbox, Input, Label, LabelText, Select, cn } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { savePreferencesAction } from "@/lib/actions/pipeline";

const list = (v: string[]) => v.join(", ");
const parseList = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

function ListInput({ label, hint, value, onChange, placeholder }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(list(value));
  return (
    <Label hint={hint}>
      <LabelText>{label}</LabelText>
      <Input value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(parseList(text))} />
    </Label>
  );
}

export function PreferencesForm({ initial }: { initial: Preferences }) {
  const [p, setP] = useState(initial);
  const { pending, result, run } = useAction();
  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setP((x) => ({ ...x, [k]: v }));

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => savePreferencesAction(JSON.stringify(p)));
      }}
    >
      <Card>
        <CardHeader title="What you're looking for" description="Used to filter company boards before any AI work, and to score matches." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <ListInput label="Target job titles" hint="Comma separated. A posting passes if its title contains all the meaningful words of one target." value={p.targetTitles} onChange={(v) => set("targetTitles", v)} placeholder="Backend Engineer, Platform Engineer" />
          <ListInput label="Extra title keywords" hint="Any posting whose title contains one of these also passes." value={p.keywords} onChange={(v) => set("keywords", v)} placeholder="payments, infrastructure" />
          <ListInput label="Locations" hint="Cities, states, or countries. Remote roles always pass." value={p.locations} onChange={(v) => set("locations", v)} placeholder="Austin, Texas, United States" />
          <Label>
            <LabelText>Remote policy</LabelText>
            <Select value={p.remotePolicy} onChange={(e) => set("remotePolicy", e.target.value as Preferences["remotePolicy"])}>
              <option value="any">Any arrangement</option>
              <option value="remote_only">Remote only</option>
              <option value="hybrid_ok">Remote or hybrid</option>
              <option value="onsite_ok">Onsite is fine</option>
            </Select>
          </Label>
          <Label hint="Annual base. Postings whose top of range is below this score lower. 0 to ignore.">
            <LabelText>Salary floor</LabelText>
            <Input type="number" min={0} step={5000} value={p.salaryFloor} onChange={(e) => set("salaryFloor", Number(e.target.value) || 0)} />
          </Label>
          <div>
            <LabelText>Seniority levels</LabelText>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {SENIORITIES.map((lvl) => {
                const on = p.seniority.includes(lvl);
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => set("seniority", on ? p.seniority.filter((x) => x !== lvl) : [...p.seniority, lvl])}
                    className={cn("rounded-md border px-2 py-0.5 text-[13px] capitalize", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted")}
                  >
                    {lvl}
                  </button>
                );
              })}
            </div>
          </div>
          <ListInput label="Industries to prefer" value={p.industriesInclude} onChange={(v) => set("industriesInclude", v)} placeholder="Fintech, Healthcare" />
          <ListInput label="Industries to avoid" value={p.industriesExclude} onChange={(v) => set("industriesExclude", v)} placeholder="Gambling" />
          <ListInput label="Companies to never apply to" hint="Current employer, companies you've left recently, etc." value={p.companyExclude} onChange={(v) => set("companyExclude", v)} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Eligibility" description="Used to filter out roles you can't take and to answer authorization questions." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Label hint="e.g. US citizen; Green card holder; H-1B (transfer needed)">
            <LabelText>Work authorization</LabelText>
            <Input value={p.workAuthorization} onChange={(e) => set("workAuthorization", e.target.value)} />
          </Label>
          <div className="pt-6">
            <Checkbox label="I require visa sponsorship" checked={p.requiresSponsorship} onChange={(e) => set("requiresSponsorship", e.target.checked)} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Automation" description="How aggressively the pipeline runs on its own." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Label hint="Jobs scoring at or above this are tailored automatically.">
            <LabelText>Minimum match score to tailor</LabelText>
            <Input type="number" min={0} max={100} value={p.minMatchScore} onChange={(e) => set("minMatchScore", Number(e.target.value))} />
          </Label>
          <Label hint="Real submissions per day. Extra approvals wait until tomorrow.">
            <LabelText>Daily application cap</LabelText>
            <Input type="number" min={0} max={200} value={p.dailyApplyCap} onChange={(e) => set("dailyApplyCap", Number(e.target.value))} />
          </Label>
          <Label hint="Random pause between submissions, in seconds.">
            <LabelText>Spacing between applications</LabelText>
            <div className="flex items-center gap-2">
              <Input type="number" min={0} value={p.applyDelaySecondsMin} onChange={(e) => set("applyDelaySecondsMin", Number(e.target.value))} />
              <span className="text-muted">to</span>
              <Input type="number" min={0} value={p.applyDelaySecondsMax} onChange={(e) => set("applyDelaySecondsMax", Number(e.target.value))} />
            </div>
          </Label>
          <Label>
            <LabelText>Check for new jobs every</LabelText>
            <Select value={p.discoveryIntervalHours} onChange={(e) => set("discoveryIntervalHours", Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 8, 12].map((h) => (
                <option key={h} value={h}>
                  {h} hour{h === 1 ? "" : "s"}
                </option>
              ))}
            </Select>
          </Label>
          <div className="flex flex-col gap-3 sm:col-span-2">
            <Checkbox label="Tailor strong matches automatically" hint="Off: you pick which jobs to tailor from the Jobs page." checked={p.autoTailor} onChange={(e) => set("autoTailor", e.target.checked)} />
            <Checkbox
              label="Dry run by default"
              hint="Approved applications are filled out but not submitted. You check the filled form, then choose Submit for real. Recommended until you trust the results."
              checked={p.dryRun}
              onChange={(e) => set("dryRun", e.target.checked)}
            />
            <Checkbox label="Run the browser hidden (headless)" hint="Off: you can watch applications being filled in a real Chrome window, and finish CAPTCHAs yourself." checked={p.headlessBrowser} onChange={(e) => set("headlessBrowser", e.target.checked)} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Cover letters" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Label>
            <LabelText>Tone</LabelText>
            <Select value={p.coverLetterTone} onChange={(e) => set("coverLetterTone", e.target.value as Preferences["coverLetterTone"])}>
              <option value="professional">Professional</option>
              <option value="warm">Warm</option>
              <option value="direct">Direct</option>
            </Select>
          </Label>
          <Label>
            <LabelText>Length</LabelText>
            <Select value={p.coverLetterLength} onChange={(e) => set("coverLetterLength", e.target.value as Preferences["coverLetterLength"])}>
              <option value="short">Short (180-250 words)</option>
              <option value="medium">Medium (280-380 words)</option>
            </Select>
          </Label>
        </CardBody>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save preferences
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}
