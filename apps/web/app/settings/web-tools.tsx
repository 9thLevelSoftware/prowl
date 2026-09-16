"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Checkbox, Input, Label, LabelText } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { saveFirecrawlAction, testFirecrawlAction } from "@/lib/actions/interview";

export function WebToolsCard({ initial, nativeSearch }: { initial: { enabled: boolean; baseUrl: string; hasApiKey: boolean }; nativeSearch: string | null }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const save = useAction();
  const test = useAction();
  return (
    <Card>
      <CardHeader
        title="Web tools"
        description="Used to find employers and job boards, and to read careers pages that need JavaScript."
      />
      <CardBody className="flex flex-col gap-4">
        <p className="text-[13px]">
          <span className="font-medium">Web search: </span>
          {nativeSearch ? (
            <span className="text-ok">built into your AI connection ({nativeSearch})</span>
          ) : enabled ? (
            <span className="text-muted">Firecrawl, if its server has search configured</span>
          ) : (
            <span className="text-muted">not available. Source suggestions use AI knowledge and jobs you've already found.</span>
          )}
        </p>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.run(() => saveFirecrawlAction({ enabled, baseUrl, apiKey }), () => setApiKey(""));
          }}
        >
          <div className="sm:col-span-2">
            <Checkbox
              label="Use a Firecrawl server"
              hint="Self-hosted Firecrawl (github.com/firecrawl/firecrawl) renders careers pages and, with a search backend such as SearXNG, adds web search."
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
          </div>
          <Label>
            <LabelText>Server address</LabelText>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:3002" disabled={!enabled} />
          </Label>
          <Label hint={initial.hasApiKey ? "A key is saved. Leave blank to keep it." : "Only needed if your server requires one."}>
            <LabelText>API key</LabelText>
            <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={!enabled} />
          </Label>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={save.pending}>
              Save
            </Button>
            <Button type="button" disabled={!enabled || test.pending} onClick={() => test.run(testFirecrawlAction)}>
              {test.pending ? <Loader2 className="size-4 animate-spin" /> : null} Test
            </Button>
            <ResultMessage result={save.result} />
            <ResultMessage result={test.result} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
