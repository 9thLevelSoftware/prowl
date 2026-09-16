import { emptyProfile } from "@jh/shared";
import { getActiveProfile, getProfileFacts, listProfiles } from "@jh/db";
import { Badge, Card, CardBody, CardHeader, PageHeader, formatDateTime, buttonClass } from "@/components/ui";
import { ActionButton } from "@/components/action";
import { activateProfileVersion } from "@/lib/actions/profile";
import { db, fileUrl, USER } from "@/lib/server";
import { ResumeUpload } from "./upload";
import { ProfileEditor } from "./editor";

export default function ProfilePage() {
  const profile = getActiveProfile(db(), USER);
  const versions = listProfiles(db(), USER);
  const facts = profile ? getProfileFacts(db(), profile.id) : [];

  return (
    <>
      <PageHeader
        title="Profile & resume"
        description="Your confirmed profile is the single source of truth. Tailored resumes and cover letters can only use facts from here."
        actions={
          profile?.baselinePdfPath ? (
            <>
              <a className={buttonClass("secondary")} href={fileUrl(profile.baselinePdfPath)!} target="_blank" rel="noreferrer">
                Baseline PDF
              </a>
              <a className={buttonClass("secondary")} href={fileUrl(profile.baselineDocxPath, true)!}>
                DOCX
              </a>
            </>
          ) : null
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1fr_280px]">
        <div className="flex min-w-0 flex-col gap-5">
          <ResumeUpload hasProfile={!!profile} />
          <ProfileEditor key={profile?.id ?? "empty"} initial={profile?.data ?? emptyProfile()} />
        </div>
        <aside className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Fact ledger" description="What tailoring is allowed to cite" />
            <CardBody className="text-[13px]">
              {profile ? (
                <>
                  <p>
                    <span className="tabular font-semibold">{facts.length}</span> facts from version {profile.version}
                  </p>
                  <ul className="mt-2 space-y-0.5 text-muted">
                    {(
                      [
                        ["role", "Roles"],
                        ["bullet", "Bullets"],
                        ["skill", "Confirmed skills"],
                        ["education", "Education"],
                        ["certification", "Certifications"],
                        ["project", "Projects"],
                      ] as const
                    ).map(([k, label]) => (
                      <li key={k} className="flex justify-between">
                        <span>{label}</span>
                        <span className="tabular">{facts.filter((f) => f.kind === k).length}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-muted">Save a profile to build the ledger.</p>
              )}
            </CardBody>
          </Card>
          {versions.length ? (
            <Card>
              <CardHeader title="Versions" />
              <ul className="divide-y divide-border text-[13px]">
                {versions.slice(0, 12).map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2 px-4 py-2">
                    <div>
                      <p className="font-medium">
                        v{v.version} {v.isActive ? <Badge tone="ok">Active</Badge> : null}
                      </p>
                      <p className="text-muted">{formatDateTime(v.createdAt)}</p>
                    </div>
                    {!v.isActive ? (
                      <ActionButton size="sm" variant="ghost" action={activateProfileVersion.bind(null, v.id)}>
                        Restore
                      </ActionButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </>
  );
}
