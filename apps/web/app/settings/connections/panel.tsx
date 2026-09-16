"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { LlmConnection } from "@jh/db/schema";
import type { ProviderSummary } from "@jh/llm/catalog";
import { Badge, Button, Card, EmptyState, cn } from "@/components/ui";
import { AddConnectionDialog } from "./add-dialog";
import { ConnectionDetail } from "./detail";
import { StatusDot } from "./status";

function describe(c: LlmConnection): string {
  if (c.kind === "env") return "From .env";
  const model = c.selections.main?.model;
  const who = c.authType === "oauth" ? (c.accountLabel ?? "Not signed in") : (c.keyHint ?? (c.authType === "none" ? "No key" : "API key"));
  return model ? `${model} · ${c.selections.main?.effort && c.selections.main.effort !== "auto" ? c.selections.main.effort : "auto effort"}` : who;
}

export function ConnectionsPanel({ connections, activeId, providers }: { connections: LlmConnection[]; activeId: string | null; providers: ProviderSummary[] }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(activeId ?? connections[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  // A just-added connection may not be in `connections` until the refresh lands; keep its id and
  // fall back to the active connection meanwhile, so the selection switches as soon as it arrives.
  const selected = connections.find((c) => c.id === selectedId) ?? connections.find((c) => c.id === activeId) ?? connections[0];

  return (
    <>
      {connections.length === 0 ? (
        <EmptyState
          title="No AI connection yet"
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add a connection
            </Button>
          }
        >
          Sign in with ChatGPT or Google, or add an API key from almost any provider. Job Hunter uses it to read resumes, analyze postings, and write tailored documents.
        </EmptyState>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <nav aria-label="AI connections" className="flex flex-col gap-1.5">
            {connections.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-current={c.id === selected?.id ? "true" : undefined}
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  c.id === selected?.id ? "border-accent bg-accent-soft/50" : "border-border hover:bg-panel-2",
                )}
              >
                <span className="mt-1.5">
                  <StatusDot status={c.status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{c.label}</span>
                    {c.id === activeId ? <Badge tone="ok">In use</Badge> : null}
                  </span>
                  <span className="block truncate text-[12px] text-muted">{describe(c)}</span>
                </span>
              </button>
            ))}
            <Button variant="ghost" className="mt-1 justify-start" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add connection
            </Button>
          </nav>
          <Card className="min-w-0 p-5">{selected ? <ConnectionDetail key={selected.id} conn={selected} isActive={selected.id === activeId} onRemoved={() => setSelectedId(null)} /> : null}</Card>
        </div>
      )}
      {adding ? (
        <AddConnectionDialog
          providers={providers}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            setSelectedId(id);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
