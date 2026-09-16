"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Input, Label, LabelText, Notice, Select } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { saveLlmSettingsAction, testLlmAction } from "@/lib/actions/system";

export interface LlmFormValues {
  provider: string;
  smartModel: string;
  fastModel: string;
  baseURL: string;
  googleProject: string;
  concurrency: number;
}

const PROVIDER_HELP: Record<string, string> = {
  "gemini-oauth":
    "Uses a Google OAuth access token (from gcloud or the Gemini CLI login). Set JH_LLM_TOKEN_CMD (for example: gcloud auth application-default print-access-token) or JH_LLM_TOKEN_FILE in .env, and your Google Cloud project below.",
  "chatgpt-oauth":
    "Uses the token written by a ChatGPT sign-in (for example the Codex CLI's auth.json via JH_LLM_TOKEN_FILE). This path is experimental: ChatGPT subscription access for third-party apps may be limited or change, and may be subject to OpenAI's terms. Test the connection before relying on it.",
  gemini: "Uses GEMINI_API_KEY from .env.",
  openai: "Uses OPENAI_API_KEY from .env.",
  anthropic: "Uses ANTHROPIC_API_KEY from .env.",
};

export function LlmForm({ initial, envProvider }: { initial: LlmFormValues; envProvider: string }) {
  const [v, setV] = useState(initial);
  const save = useAction();
  const test = useAction();
  const set = <K extends keyof LlmFormValues>(k: K, val: LlmFormValues[K]) => setV((x) => ({ ...x, [k]: val }));

  return (
    <Card>
      <CardHeader title="AI provider" description={`Credentials stay in your local .env and are never stored in the database. Default from .env: ${envProvider}.`} />
      <CardBody>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.run(() => saveLlmSettingsAction({ ...v, concurrency: Number(v.concurrency) } as never));
          }}
        >
          <Label>
            <LabelText>Provider</LabelText>
            <Select value={v.provider} onChange={(e) => set("provider", e.target.value)}>
              <option value="gemini-oauth">Gemini (Google sign-in)</option>
              <option value="chatgpt-oauth">ChatGPT (sign-in, experimental)</option>
              <option value="gemini">Gemini (API key)</option>
              <option value="openai">OpenAI (API key)</option>
              <option value="anthropic">Anthropic (API key)</option>
            </Select>
          </Label>
          <Label hint="Parallel AI requests. Keep low for subscription sign-ins.">
            <LabelText>Concurrency</LabelText>
            <Input type="number" min={1} max={8} value={v.concurrency} onChange={(e) => set("concurrency", Number(e.target.value))} />
          </Label>
          <div className="sm:col-span-2">
            <Notice tone={v.provider === "chatgpt-oauth" ? "warn" : "neutral"}>{PROVIDER_HELP[v.provider]}</Notice>
          </div>
          <Label hint="Tailoring, cover letters, fact-checking, form answers. Blank uses the provider default.">
            <LabelText>Main model</LabelText>
            <Input value={v.smartModel} onChange={(e) => set("smartModel", e.target.value)} placeholder="provider default" />
          </Label>
          <Label hint="Requirement extraction and quick checks.">
            <LabelText>Fast model</LabelText>
            <Input value={v.fastModel} onChange={(e) => set("fastModel", e.target.value)} placeholder="provider default" />
          </Label>
          {v.provider.startsWith("gemini") ? (
            <Label hint="Billed project for OAuth calls (x-goog-user-project). Needs the Generative Language API enabled.">
              <LabelText>Google Cloud project</LabelText>
              <Input value={v.googleProject} onChange={(e) => set("googleProject", e.target.value)} />
            </Label>
          ) : null}
          <Label hint="Only for proxies or custom endpoints.">
            <LabelText>Base URL override</LabelText>
            <Input value={v.baseURL} onChange={(e) => set("baseURL", e.target.value)} placeholder="default" />
          </Label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" variant="primary" disabled={save.pending}>
              {save.pending ? <Loader2 className="size-4 animate-spin" /> : null} Save
            </Button>
            <Button type="button" disabled={test.pending} onClick={() => test.run(testLlmAction)}>
              {test.pending ? <Loader2 className="size-4 animate-spin" /> : null} Test connection
            </Button>
            <ResultMessage result={save.result} />
            <ResultMessage result={test.result} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
