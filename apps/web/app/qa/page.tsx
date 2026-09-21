import { desc, eq, schema as s } from "@prowl/db";
import { COMMON_QUESTIONS } from "@prowl/applier/qa-seed";
import { PageHeader } from "@/components/ui";
import { db, USER } from "@/lib/server";
import { CommonQuestions, SavedAnswers } from "./qa-form";

export default function QaPage() {
  const saved = db().select().from(s.qaBank).where(eq(s.qaBank.userId, USER)).orderBy(desc(s.qaBank.updatedAt)).all();
  const byKey = new Map(saved.map((q) => [q.questionKey, q]));
  const common = COMMON_QUESTIONS.map((q) => ({ ...q, answer: byKey.get(q.key)?.answer ?? "" }));
  const commonKeys = new Set(COMMON_QUESTIONS.map((q) => q.key));
  return (
    <>
      <PageHeader
        title="Saved answers"
        description="Answers the applier may use on your behalf. Nothing drafted by AI is used until you approve it here or on the Needs you page."
      />
      <div className="flex flex-col gap-5">
        <CommonQuestions questions={common} />
        <SavedAnswers
          saved={saved
            .filter((q) => !commonKeys.has(q.questionKey))
            .map((q) => ({ id: q.id, questionKey: q.questionKey, questionText: q.questionText, answer: q.answer, approved: q.approved, timesUsed: q.timesUsed }))}
        />
      </div>
    </>
  );
}
