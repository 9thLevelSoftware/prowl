import { redirect } from "next/navigation";
import { and, eq, getActiveProfile, getOpenInterview, getPreferences, inArray, listSuggestions, schema as s } from "@jh/db";
import { InterviewDraft } from "@jh/core";
import { PageHeader } from "@/components/ui";
import { db, USER } from "@/lib/server";
import { ReviewForm } from "./review-form";

export const dynamic = "force-dynamic";

export default function InterviewReviewPage() {
  const d = db();
  const iv = getOpenInterview(d, USER);
  if (!iv) redirect("/interview");
  if (iv.status !== "review") redirect("/interview");

  const draft = InterviewDraft.parse(iv.draft);
  const saved = getPreferences(d, USER);
  const profile = getActiveProfile(d, USER);
  const suggestions = listSuggestions(d, ["verified", "unconfirmed", "not_found", "pending"], USER);
  const run = iv.sourceRunId ? d.select().from(s.pipelineRuns).where(eq(s.pipelineRuns.id, iv.sourceRunId)).get() : undefined;
  const queued = !!d
    .select({ id: s.queueTasks.id })
    .from(s.queueTasks)
    .where(and(eq(s.queueTasks.type, "build_sources"), inArray(s.queueTasks.status, ["pending", "running"])))
    .get();

  return (
    <>
      <PageHeader
        title="Review your interview"
        description="Everything below is a draft. Edit anything, choose what to keep, then apply. Nothing is saved until you do."
      />
      <ReviewForm
        interviewId={iv.id}
        careerSummary={iv.careerSummary}
        initialDraft={draft}
        savedPreferences={saved}
        roles={Object.fromEntries((profile?.data.work ?? []).map((w) => [w.id, `${w.title}, ${w.company}`]))}
        suggestions={suggestions.map((x) => ({
          id: x.id,
          company: x.company,
          type: x.type,
          origin: x.origin,
          status: x.status,
          why: x.why,
          note: x.note,
          jobsOpen: x.jobsOpen,
          jobsMatching: x.jobsMatching,
          sampleTitles: x.sampleTitles ?? [],
          config: x.config,
        }))}
        sources={{ running: queued || run?.status === "running", message: run?.message ?? (queued ? "Starting…" : null), failed: run?.status === "failed" }}
      />
    </>
  );
}
