"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Input, Label, LabelText, Notice, cn } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { addSourceAction } from "@/lib/actions/system";

export interface AdapterMeta {
  type: string;
  label: string;
  description: string;
  usesBrowser: boolean;
  configFields: { key: string; label: string; placeholder?: string; required?: boolean; help?: string }[];
}

export function AddSource({ adapters }: { adapters: AdapterMeta[] }) {
  const [type, setType] = useState(adapters[0]!.type);
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const { pending, result, run } = useAction();
  const a = adapters.find((x) => x.type === type)!;

  return (
    <Card>
      <CardHeader title="Add a source" />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {adapters.map((x) => (
            <button
              key={x.type}
              type="button"
              role="tab"
              aria-selected={x.type === type}
              onClick={() => {
                setType(x.type);
                setValues({});
              }}
              className={cn("rounded-md border px-2.5 py-1 text-[13px]", x.type === type ? "border-accent bg-accent-soft font-medium text-accent" : "border-border text-muted hover:text-text")}
            >
              {x.label}
            </button>
          ))}
        </div>
        <p className="text-muted">{a.description}</p>
        {a.usesBrowser ? (
          <Notice tone="warn" title="Read this first">
            LinkedIn and Indeed prohibit automated access in their terms and can restrict accounts. This source only reads search results, slowly and in small numbers, from your own signed-in browser. It never applies on those sites. Sign in with “Open browser to sign in” below before the first run.
          </Notice>
        ) : null}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => addSourceAction(type, values, name), () => {
              setValues({});
              setName("");
            });
          }}
        >
          {a.configFields.map((f) => (
            <Label key={f.key} hint={f.help}>
              <LabelText required={f.required}>{f.label}</LabelText>
              <Input value={values[f.key] ?? ""} placeholder={f.placeholder} required={f.required} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            </Label>
          ))}
          <Label hint="Optional display name">
            <LabelText>Name</LabelText>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Label>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Add and run
            </Button>
            <ResultMessage result={result} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
