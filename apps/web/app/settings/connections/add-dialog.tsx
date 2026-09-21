"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Eye, EyeOff, Loader2, Search, X } from "lucide-react";
import type { ProviderSummary } from "@prowl/llm/catalog";
import { Badge, Button, Input, Label, LabelText, Notice, cn } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { createApiKeyConnectionAction, startChatGptSignInAction, startGeminiSignInAction } from "@/lib/actions/llm";
import { useSignIn } from "./use-sign-in";

type Choice =
  | { type: "chatgpt" }
  | { type: "gemini-oauth" }
  | { type: "api"; provider: ProviderSummary | null; title: string; baseUrl: string; local: boolean };

interface Tile {
  key: string;
  title: string;
  subtitle: string;
  choice: (providers: Map<string, ProviderSummary>) => Choice | null;
}

const api = (id: string, title?: string) => (p: Map<string, ProviderSummary>): Choice | null => {
  const provider = p.get(id);
  return provider ? { type: "api", provider, title: title ?? provider.name, baseUrl: provider.baseUrl ?? "", local: provider.local } : null;
};

const TILES: Tile[] = [
  { key: "chatgpt", title: "ChatGPT", subtitle: "Sign in with your ChatGPT account", choice: () => ({ type: "chatgpt" }) },
  { key: "gemini-oauth", title: "Gemini", subtitle: "Sign in with Google", choice: () => ({ type: "gemini-oauth" }) },
  { key: "openai", title: "OpenAI API", subtitle: "API key", choice: api("openai", "OpenAI API") },
  { key: "google", title: "Gemini API", subtitle: "API key", choice: api("google", "Gemini API") },
  { key: "anthropic", title: "Anthropic", subtitle: "API key", choice: api("anthropic") },
  { key: "openrouter", title: "OpenRouter", subtitle: "One key, hundreds of models", choice: api("openrouter") },
  { key: "xai", title: "xAI", subtitle: "API key", choice: api("xai") },
  { key: "mistral", title: "Mistral", subtitle: "API key", choice: api("mistral") },
  { key: "deepseek", title: "DeepSeek", subtitle: "API key", choice: api("deepseek") },
  { key: "groq", title: "Groq", subtitle: "API key", choice: api("groq") },
  {
    key: "ollama",
    title: "Ollama",
    subtitle: "Local models on this computer",
    choice: () => ({ type: "api", provider: null, title: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", local: true }),
  },
  { key: "lmstudio", title: "LM Studio", subtitle: "Local models on this computer", choice: api("lmstudio", "LM Studio (local)") },
  {
    key: "custom",
    title: "Custom endpoint",
    subtitle: "Any OpenAI-compatible API",
    choice: () => ({ type: "api", provider: null, title: "Custom endpoint", baseUrl: "", local: false }),
  },
];

export function AddConnectionDialog({ providers, onClose, onAdded }: { providers: ProviderSummary[]; onClose: () => void; onAdded: (connectionId: string) => void }) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    dialogRef.current?.querySelector<HTMLElement>("input, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, choice]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return providers.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q)).slice(0, 40);
  }, [providers, query]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-conn-title" className="w-full max-w-2xl rounded-xl border border-border bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          {choice ? (
            <Button variant="ghost" size="sm" aria-label="Back" onClick={() => setChoice(null)}>
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <h2 id="add-conn-title" className="flex-1 font-semibold">
            {!choice ? "Add an AI connection" : choice.type === "chatgpt" ? "Sign in with ChatGPT" : choice.type === "gemini-oauth" ? "Sign in with Google for Gemini" : `Connect ${choice.title}`}
          </h2>
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="p-5">
          {!choice ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {TILES.map((t) => {
                  const c = t.choice(byId);
                  return (
                    <button
                      key={t.key}
                      type="button"
                      disabled={!c}
                      onClick={() => c && setChoice(c)}
                      className="flex flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2.5 text-left hover:border-accent hover:bg-accent-soft/40 disabled:opacity-40"
                    >
                      <span className="font-medium">{t.title}</span>
                      <span className="text-[12px] text-muted">{t.subtitle}</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-5">
                <label className="flex h-9 items-center gap-2 rounded-md border border-border px-2.5 focus-within:border-accent">
                  <Search className="size-4 text-muted" />
                  <input className="flex-1 bg-transparent focus:outline-none" placeholder={`Search all ${providers.length} providers`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search providers" />
                </label>
                {matches.length ? (
                  <ul className="mt-2 max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {matches.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          disabled={!p.supported}
                          onClick={() => setChoice({ type: "api", provider: p, title: p.name, baseUrl: p.baseUrl ?? "", local: p.local })}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span className="flex-1">
                            <span className="font-medium">{p.name}</span>
                            <span className="block text-[12px] text-muted">{p.supported ? `${p.modelCount} models` : p.reason}</span>
                          </span>
                          {p.local ? <Badge>Local</Badge> : null}
                          {!p.supported ? <Badge>Not supported yet</Badge> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : query ? (
                  <p className="mt-2 text-[13px] text-muted">No provider matches. Use Custom endpoint for any OpenAI-compatible API.</p>
                ) : null}
              </div>
            </>
          ) : choice.type === "chatgpt" ? (
            <ChatGptStep onAdded={onAdded} />
          ) : choice.type === "gemini-oauth" ? (
            <GeminiOAuthStep onAdded={onAdded} />
          ) : (
            <ApiKeyStep choice={choice} onAdded={onAdded} />
          )}
        </div>
      </div>
    </div>
  );
}

function SignInStatus({ state }: { state: ReturnType<typeof useSignIn>["state"] }) {
  if (state.phase === "idle") return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      {state.phase === "waiting" ? <Loader2 className="size-4 animate-spin text-muted" /> : null}
      <span className={state.phase === "error" ? "text-bad" : state.phase === "done" ? "text-ok" : "text-muted"}>{state.message}</span>
      {state.phase === "waiting" && state.authorizeUrl ? (
        <a className="inline-flex items-center gap-1 underline" href={state.authorizeUrl} target="_blank" rel="noreferrer">
          Tab didn't open? Open sign-in page <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

function ChatGptStep({ onAdded }: { onAdded: (id: string) => void }) {
  const signIn = useSignIn((id) => onAdded(id));
  return (
    <div className="flex flex-col gap-4">
      <p>Use the models included with your ChatGPT plan. You'll sign in on OpenAI's own page; Prowl never sees your password.</p>
      <Notice tone="neutral">
        This uses the ChatGPT sign-in that OpenAI provides for Codex (
        <a className="underline" href="https://learn.chatgpt.com/docs/auth?surface=app" target="_blank" rel="noreferrer">
          how it works
        </a>
        ). Usage counts against your plan's limits and is subject to OpenAI's terms. The sign-in page returns to this computer on port 1455, so close any running <code className="font-mono">codex login</code> first.
      </Notice>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" disabled={signIn.state.phase === "waiting"} onClick={() => signIn.start(() => startChatGptSignInAction())}>
          Sign in with ChatGPT
        </Button>
        <SignInStatus state={signIn.state} />
      </div>
    </div>
  );
}

const GUIDE = [
  { text: "Create or pick a Google Cloud project and note its project ID.", href: "https://console.cloud.google.com/projectcreate" },
  { text: "Enable the Generative Language API in that project.", href: "https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" },
  { text: "Set up the OAuth consent screen: choose External, then add your own Google account under Audience → Test users.", href: "https://console.cloud.google.com/auth/overview" },
  { text: "Create an OAuth client with application type Desktop app.", href: "https://console.cloud.google.com/auth/clients" },
  { text: "Copy the client ID and client secret into the fields below.", href: null },
];

function GeminiOAuthStep({ onAdded }: { onAdded: (id: string) => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [project, setProject] = useState("");
  const signIn = useSignIn((id) => onAdded(id));
  return (
    <div className="flex flex-col gap-4">
      <p>
        Google's official way to use the Gemini API with your Google account (
        <a className="underline" href="https://ai.google.dev/gemini-api/docs/oauth" target="_blank" rel="noreferrer">
          Google's guide
        </a>
        ). It needs a one-time setup in Google Cloud, about five minutes:
      </p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px]">
        {GUIDE.map((g, i) => (
          <li key={i}>
            {g.text}{" "}
            {g.href ? (
              <a className="inline-flex items-center gap-0.5 text-accent underline" href={g.href} target="_blank" rel="noreferrer">
                Open <ExternalLink className="size-3" />
              </a>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label className="sm:col-span-2">
          <LabelText required>OAuth client ID</LabelText>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" autoComplete="off" />
        </Label>
        <Label>
          <LabelText required>Client secret</LabelText>
          <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
        </Label>
        <Label>
          <LabelText required>Project ID</LabelText>
          <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="my-project-123" />
        </Label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="lg"
          disabled={signIn.state.phase === "waiting"}
          onClick={() => signIn.start(() => startGeminiSignInAction({ clientId, clientSecret, project }))}
        >
          Sign in with Google
        </Button>
        <SignInStatus state={signIn.state} />
      </div>
    </div>
  );
}

function ApiKeyStep({ choice, onAdded }: { choice: Extract<Choice, { type: "api" }>; onAdded: (id: string) => void }) {
  const [label, setLabel] = useState(choice.title);
  const [apiKey, setApiKey] = useState("");
  const [show, setShow] = useState(false);
  const [baseUrl, setBaseUrl] = useState(choice.baseUrl);
  const { pending, result, run } = useAction();
  const custom = !choice.provider;
  const keyHint = choice.provider?.keyHint;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => createApiKeyConnectionAction({ providerId: choice.provider?.id ?? null, label, apiKey, baseUrl: custom || choice.local ? baseUrl : "", local: choice.local }),
          (r) => {
            const id = (r as { data?: { connectionId: string } }).data?.connectionId;
            if (id) onAdded(id);
          },
        );
      }}
    >
      {choice.provider?.doc ? (
        <p className="text-[13px] text-muted">
          Get a key from{" "}
          <a className="underline" href={choice.provider.doc} target="_blank" rel="noreferrer">
            {choice.provider.name}'s docs
          </a>
          .
        </p>
      ) : null}
      <Label>
        <LabelText>Name</LabelText>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} />
      </Label>
      {custom || choice.local ? (
        <Label hint={choice.local ? "The address of the local server. Start it before connecting." : "The OpenAI-compatible base URL, usually ending in /v1."}>
          <LabelText required>API base URL</LabelText>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" required />
        </Label>
      ) : null}
      <Label hint={choice.local ? "Usually not needed for local servers." : keyHint ? `The same value you'd put in ${keyHint}. Stored encrypted on this computer.` : "Stored encrypted on this computer."}>
        <LabelText required={!choice.local}>API key</LabelText>
        <div className="flex gap-2">
          <Input type={show ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
          <Button type="button" variant="ghost" aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow((s) => !s)}>
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
      </Label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {pending ? "Connecting and loading models…" : "Connect"}
        </Button>
        <ResultMessage result={result} />
      </div>
      <p className={cn("text-[12px] text-muted")}>Connecting loads the provider's model list. It doesn't send a prompt or use credits.</p>
    </form>
  );
}
