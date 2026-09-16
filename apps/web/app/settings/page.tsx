import { getActiveConnection, listConnections } from "@jh/db";
import { ensureEnvConnection, getLlm, keyStorage, listProviders } from "@jh/llm";
import { firecrawlSettings } from "@jh/sources";
import { WebToolsCard } from "./web-tools";
import { dataDir } from "@jh/shared";
import { Card, CardBody, CardHeader, Notice, PageHeader } from "@/components/ui";
import { db, USER } from "@/lib/server";
import { ConnectionsPanel } from "./connections/panel";
import { DangerZone } from "./danger-zone";

export default async function SettingsPage() {
  const d = db();
  ensureEnvConnection(d);
  const connections = listConnections(d, USER).map(({ refreshLockUntil: _lock, ...c }) => ({ ...c, refreshLockUntil: null }));
  const active = getActiveConnection(d, USER);
  const storage = await keyStorage().catch(() => "file" as const);

  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader
            title="AI connections"
            description="Add as many as you like and choose which one Job Hunter uses. Each connection remembers the model and reasoning effort you picked for it."
          />
          <CardBody>
            {storage === "file" ? (
              <Notice tone="warn" className="mb-4">
                The system keychain isn't available, so the encryption key for your API keys and sign-ins is stored in the data folder. Keep that folder private.
              </Notice>
            ) : null}
            <ConnectionsPanel connections={connections} activeId={active?.id ?? null} providers={listProviders()} />
          </CardBody>
        </Card>
        <WebToolsCard initial={firecrawlSettings(d)} nativeSearch={getLlm(d).canSearchWeb() ? (active?.label ?? "AI connection") : null} />
        <Card>
          <CardHeader title="Local data" />
          <CardBody className="space-y-1 text-[13px] text-muted">
            <p>
              Everything lives on this computer in <code className="font-mono text-text">{dataDir()}</code>: the database, generated resumes and cover letters, application screenshots, and the browser profile that holds your job-site sign-ins.
            </p>
            <p>API keys and sign-in tokens are encrypted with a key held in {storage === "keychain" ? "your system keychain" : "the data folder"}. Nothing is uploaded anywhere except the AI requests needed to analyze postings and write documents, and the applications you approve.</p>
          </CardBody>
        </Card>
        <DangerZone />
      </div>
    </>
  );
}
