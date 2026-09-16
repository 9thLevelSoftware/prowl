"use client";

import { useMemo, useState } from "react";
import { Loader2, RefreshCw, Check, ExternalLink } from "lucide-react";
import type { LlmConnection, ModelInfo } from "@jh/db/schema";
import { EFFORT_LABELS } from "@jh/llm/effort";
import { Badge, Button, Input, Label, LabelText, Notice, Select, cn, formatDateTime, timeAgo } from "@/components/ui";
import { Combobox } from "@/components/combobox";
import { ResultMessage, useAction } from "@/components/action";
import {
  deleteConnectionAction,
  refreshModelsAction,
  saveSelectionAction,
  setActiveConnectionAction,
  startChatGptSignInAction,
  startGoogleSignInAction,
  testConnectionAction,
  updateConnectionAction,
} from "@/lib/actions/llm";
import { useSignIn } from "./use-sign-in";
import { StatusBadge } from "./status";

const formatContext = (n: number | null) => (!n ? "" : n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`);

function SlotPicker({
  conn,
  slot,
  models,
  effortByModel,
  onEffortMemory,
}: {
  conn: LlmConnection;
  slot: "main" | "fast";
  models: ModelInfo[];
  effortByModel: Record<string, string>;
  onEffortMemory: (model: string, effort: string) => void;
}) {
  const saved = conn.selections[slot];
  const [model, setModel] = useState<string | null>(saved?.model ?? null);
  const [effort, setEffort] = useState<string | null>(saved?.effort ?? null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const info = models.find((m) => m.id === model);
  const unknownSaved = model && !info;

  const options = useMemo(
    () =>
      models.map((m) => ({
        value: m.id,
        label: m.name,
        keywords: m.id,
        meta: (
          <span className="flex items-center gap-1.5">
            {m.efforts.length ? <span className="rounded bg-busy-soft px-1 text-[11px] text-busy">reasoning</span> : null}
            {m.contextWindow ? <span className="tabular">{formatContext(m.contextWindow)}</span> : null}
            {m.name !== m.id ? <span className="hidden font-mono text-[11px] sm:inline">{m.id}</span> : null}
          </span>
        ),
      })),
    [models],
  );

  async function persist(nextModel: string, nextEffort: string | null) {
    setStatus("saving");
    const r = await saveSelectionAction(conn.id, slot, nextModel, nextEffort);
    if (r.ok) {
      setStatus("saved");
      setError(null);
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } else {
      setStatus("error");
      setError(r.error);
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <LabelText>{slot === "main" ? "Main model" : "Fast model"}</LabelText>
          <span className="text-[12px] text-muted" aria-live="polite">
            {status === "saving" ? "Saving…" : status === "saved" ? (
              <span className="inline-flex items-center gap-1 text-ok">
                <Check className="size-3" /> Saved
              </span>
            ) : null}
          </span>
        </div>
        <Combobox
          ariaLabel={slot === "main" ? "Main model" : "Fast model"}
          options={options}
          value={model}
          placeholder={slot === "fast" && !saved ? "Same as main model" : "Choose a model"}
          emptyText="No models match. Try Refresh models."
          onChange={(m) => {
            const next = models.find((x) => x.id === m);
            const remembered = effortByModel[m];
            const e = next?.efforts.length ? (remembered && next.efforts.includes(remembered) ? remembered : next.defaultEffort) : null;
            setModel(m);
            setEffort(e);
            void persist(m, e);
          }}
        />
        <p className="mt-1 text-[12px] text-muted">
          {slot === "main" ? "Used for tailoring, fact-checking, cover letters, and form answers." : "Used for reading job postings and quick checks."}
          {unknownSaved ? " The saved model isn't in the current list." : ""}
        </p>
      </div>
      <div>
        <LabelText>Reasoning effort</LabelText>
        {info?.efforts.length ? (
          <Select
            aria-label={`${slot === "main" ? "Main" : "Fast"} model reasoning effort`}
            className="mt-1 h-9"
            value={effort ?? info.defaultEffort ?? ""}
            onChange={(e) => {
              setEffort(e.target.value);
              onEffortMemory(model!, e.target.value);
              void persist(model!, e.target.value);
            }}
          >
            {info.efforts.map((x) => (
              <option key={x} value={x}>
                {EFFORT_LABELS[x] ?? x}
                {x === info.defaultEffort ? " (default)" : ""}
              </option>
            ))}
          </Select>
        ) : (
          <p className="mt-1 flex h-9 items-center rounded-md border border-dashed border-border px-2.5 text-[13px] text-muted">{model ? "Not adjustable" : slot === "fast" ? "Same as main" : "Pick a model"}</p>
        )}
      </div>
      {error ? <p className="text-[13px] text-bad sm:col-span-2">{error}</p> : null}
    </div>
  );
}

export function ConnectionDetail({ conn, isActive, onRemoved }: { conn: LlmConnection; isActive: boolean; onRemoved: () => void }) {
  const models = conn.modelsCache ?? [];
  const [effortByModel, setEffortByModel] = useState(conn.selections.effortByModel ?? {});
  const action = useAction();
  const [label, setLabel] = useState(conn.label);
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [project, setProject] = useState(conn.googleProject ?? "");
  const [concurrency, setConcurrency] = useState(conn.concurrency);
  const signIn = useSignIn(() => undefined);
  const isOauth = conn.authType === "oauth";
  const isEnv = conn.kind === "env";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {conn.label} <StatusBadge status={conn.status} />
            {isActive ? <Badge tone="ok">In use</Badge> : null}
          </h3>
          <p className="text-[13px] text-muted">
            {isEnv ? "Configured in .env" : isOauth ? (conn.accountLabel ? `Signed in as ${conn.accountLabel}` : "Not signed in") : conn.keyHint ? `API key ${conn.keyHint}` : "No API key"}
            {conn.baseUrl ? ` · ${conn.baseUrl}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isActive ? (
            <Button variant="primary" disabled={action.pending} onClick={() => action.run(() => setActiveConnectionAction(conn.id))}>
              Use this connection
            </Button>
          ) : null}
          <Button disabled={action.pending} onClick={() => action.run(() => testConnectionAction(conn.id))}>
            {action.pending ? <Loader2 className="size-4 animate-spin" /> : null} Test
          </Button>
        </div>
      </div>
      <ResultMessage result={action.result} />

      {conn.status === "needs_signin" || (conn.status === "error" && conn.lastError) ? (
        <Notice tone={conn.status === "needs_signin" ? "warn" : "bad"} title={conn.status === "needs_signin" ? "Sign in to use this connection" : "Last check failed"}>
          {conn.lastError ? <p className="break-words">{conn.lastError}</p> : null}
          {isOauth ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={signIn.state.phase === "waiting"}
                onClick={() => signIn.start(() => (conn.kind === "gemini-oauth" ? startGoogleSignInAction(conn.id) : startChatGptSignInAction(conn.id)))}
              >
                {signIn.state.phase === "waiting" ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {conn.kind === "gemini-oauth" ? "Sign in with Google" : "Sign in with ChatGPT"}
              </Button>
              {signIn.state.message ? <span className={cn("text-[13px]", signIn.state.phase === "error" ? "text-bad" : "text-muted")}>{signIn.state.message}</span> : null}
              {signIn.state.phase === "waiting" && signIn.state.authorizeUrl ? (
                <a className="inline-flex items-center gap-1 text-[13px] underline" href={signIn.state.authorizeUrl} target="_blank" rel="noreferrer">
                  Open sign-in page <ExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
          ) : null}
        </Notice>
      ) : null}

      {isEnv ? (
        <Notice tone="neutral" title="Models are set in .env">
          This connection comes from <code className="font-mono">JH_LLM_PROVIDER</code> in your .env file. Add a connection to pick models and effort here instead.
        </Notice>
      ) : (
        <section className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-muted">
              {models.length} models
              {conn.modelsFetchedAt ? ` · updated ${timeAgo(conn.modelsFetchedAt)}` : ""}
              {models.length && models.every((m) => m.source === "catalog") ? " · from the model catalog" : ""}
            </p>
            <Button size="sm" variant="ghost" disabled={action.pending} onClick={() => action.run(() => refreshModelsAction(conn.id))}>
              <RefreshCw className="size-3.5" /> Refresh models
            </Button>
          </div>
          {conn.modelsError ? (
            <Notice tone="warn" title={models.length ? "Showing models from the public catalog" : "No models available"}>
              {models.length
                ? `The provider's own model list couldn't be loaded, so these come from the models.dev catalog. Some may not be available to this account. Reason: ${conn.modelsError}`
                : `The provider's model list couldn't be loaded. Reason: ${conn.modelsError}`}
            </Notice>
          ) : null}
          <SlotPicker key={`${conn.id}-main`} conn={conn} slot="main" models={models} effortByModel={effortByModel} onEffortMemory={(m, e) => setEffortByModel((x) => ({ ...x, [m]: e }))} />
          <SlotPicker key={`${conn.id}-fast`} conn={conn} slot="fast" models={models} effortByModel={effortByModel} onEffortMemory={(m, e) => setEffortByModel((x) => ({ ...x, [m]: e }))} />
          <p className="text-[12px] text-muted">Choices are saved to this connection. Switching away and back restores them.</p>
        </section>
      )}

      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium">Connection details</summary>
        <form
          className="grid gap-3 border-t border-border p-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(() =>
              updateConnectionAction(conn.id, {
                label,
                baseUrl: !isOauth && !isEnv && baseUrl !== (conn.baseUrl ?? "") ? baseUrl : undefined,
                apiKey: apiKey || undefined,
                googleProject: conn.kind === "gemini-oauth" ? project : undefined,
                concurrency,
              }),
            );
            setApiKey("");
          }}
        >
          <Label>
            <LabelText>Name</LabelText>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Label>
          <Label hint="How many AI requests may run at once. Keep low for subscription sign-ins.">
            <LabelText>Parallel requests</LabelText>
            <Input type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
          </Label>
          {!isOauth && !isEnv ? (
            <>
              <Label hint="Leave as is unless you use a proxy or a self-hosted endpoint.">
                <LabelText>API base URL</LabelText>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Provider default" />
              </Label>
              <Label hint="Leave blank to keep the current key.">
                <LabelText>Replace API key</LabelText>
                <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={conn.keyHint ?? "Paste a new key"} />
              </Label>
            </>
          ) : null}
          {conn.kind === "gemini-oauth" ? (
            <Label>
              <LabelText>Google Cloud project ID</LabelText>
              <Input value={project} onChange={(e) => setProject(e.target.value)} />
            </Label>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={action.pending}>
              Save details
            </Button>
            {isOauth ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={signIn.state.phase === "waiting"}
                onClick={() => signIn.start(() => (conn.kind === "gemini-oauth" ? startGoogleSignInAction(conn.id) : startChatGptSignInAction(conn.id)))}
              >
                Sign in again
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="danger"
              className="ml-auto"
              disabled={action.pending}
              onClick={() => {
                if (!window.confirm(`Remove "${conn.label}"? ${isOauth ? "You'll be signed out." : "Its API key is deleted from this computer."}`)) return;
                action.run(() => deleteConnectionAction(conn.id), onRemoved);
              }}
            >
              Remove connection
            </Button>
          </div>
          <p className="text-[12px] text-muted sm:col-span-2">
            {conn.lastTestedAt ? `Last checked ${formatDateTime(conn.lastTestedAt)}.` : "Not checked yet."} Keys and tokens are encrypted on this computer and never shown again.
          </p>
        </form>
      </details>
    </div>
  );
}
