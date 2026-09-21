import { redirect } from "next/navigation";
import { getActiveProfile, getOpenInterview } from "@prowl/db";
import { InterviewDraft, TOPICS } from "@prowl/core";
import { Card, CardBody, LinkButton, PageHeader } from "@/components/ui";
import { db, USER } from "@/lib/server";
import { InterviewChat } from "./chat";
import { StartInterview } from "./start";

export default function InterviewPage() {
  const d = db();
  const profile = getActiveProfile(d, USER);
  const iv = getOpenInterview(d, USER);
  if (iv?.status === "review") redirect("/interview/review");

  if (!iv) {
    return (
      <>
        <PageHeader
          title="Your job search interview"
          description="A short conversation about what you want next. The interviewer has read your resume, so it asks about what's missing instead of starting from scratch."
        />
        <Card className="max-w-3xl">
          <CardBody className="flex flex-col gap-4">
            <ul className="list-disc space-y-1 pl-5 text-[14px]">
              <li>Covers target roles, seniority, location and remote work, pay, work authorization, and the screening questions applications ask.</li>
              <li>Usually 8 to 15 questions. Tap a suggested answer or type your own. Skip anything you'd rather not answer.</li>
              <li>If you mention skills or experience that aren't on your resume, they're listed for you to confirm. Nothing is added without your approval.</li>
              <li>At the end you review everything, plus suggested employers and job boards, before anything is saved.</li>
            </ul>
            {profile ? (
              <StartInterview />
            ) : (
              <div className="flex items-center gap-3">
                <LinkButton href="/profile" variant="primary">
                  Add your resume first
                </LinkButton>
                <span className="text-muted">The interview builds on your resume.</span>
              </div>
            )}
          </CardBody>
        </Card>
      </>
    );
  }

  const draft = InterviewDraft.parse(iv.draft);
  return (
    <>
      <PageHeader title="Your job search interview" description={iv.careerSummary || undefined} />
      <InterviewChat
        interviewId={iv.id}
        messages={iv.messages}
        draft={draft}
        topics={TOPICS.map((t) => ({ key: t.key, label: t.label, required: t.required }))}
        roles={Object.fromEntries((profile?.data.work ?? []).map((w) => [w.id, `${w.title}, ${w.company}`]))}
      />
    </>
  );
}
