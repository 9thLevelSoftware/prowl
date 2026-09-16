import { getSetting } from "@jh/db";
import { LLM_SETTINGS_KEY, resolveProviderConfig, type ProviderConfig } from "@jh/llm";
import { dataDir } from "@jh/shared";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { db, USER } from "@/lib/server";
import { LlmForm } from "./llm-form";
import { DangerZone } from "./danger-zone";

export default function SettingsPage() {
  const saved = getSetting<Partial<ProviderConfig>>(db(), LLM_SETTINGS_KEY, {}, USER);
  const resolved = resolveProviderConfig(saved);
  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-5">
        <LlmForm
          envProvider={process.env.JH_LLM_PROVIDER ?? "gemini-oauth"}
          initial={{
            provider: resolved.provider,
            smartModel: saved.smartModel ?? "",
            fastModel: saved.fastModel ?? "",
            baseURL: saved.baseURL ?? "",
            googleProject: saved.googleProject ?? "",
            concurrency: resolved.concurrency,
          }}
        />
        <Card>
          <CardHeader title="Local data" />
          <CardBody className="space-y-1 text-[13px] text-muted">
            <p>
              Everything lives on this computer in <code className="font-mono text-text">{dataDir()}</code>: the database, generated resumes and cover letters, application screenshots, and the browser profile that holds your job-site sign-ins.
            </p>
            <p>Nothing is uploaded anywhere except the AI requests needed to analyze postings and write documents, and the applications you approve.</p>
          </CardBody>
        </Card>
        <DangerZone />
      </div>
    </>
  );
}
