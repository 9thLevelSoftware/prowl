import Link from "next/link";
import { Check, Sparkles } from "lucide-react";
import { Card, LinkButton, PageHeader, cn } from "@/components/ui";
import { onboardingSteps, type Step } from "@/lib/onboarding";

function StepNumber({ step, n }: { step: Step; n: number }) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full border text-[13px] font-semibold",
        step.done ? "border-transparent bg-ok text-white dark:text-[#0d1a13]" : "border-border text-muted",
      )}
    >
      {step.done ? <Check className="size-4" /> : n}
    </span>
  );
}

export default function Onboarding() {
  const steps = onboardingSteps();
  const firstGroup = steps.findIndex((s) => s.group === "interview");
  const group = steps.filter((s) => s.group === "interview");
  const groupDone = group.every((s) => s.done);
  const interviewStep = group[0];

  return (
    <>
      <PageHeader
        title="Get started"
        description="After setup, discovery and tailoring run on their own, and nothing is submitted until you approve it."
      />
      <ol className="flex flex-col gap-3">
        {steps.map((step, i) => {
          if (step.group === "interview") {
            if (i !== firstGroup) return null;
            return (
              <li key="interview">
                <Card className={cn("p-4", groupDone && "opacity-75")}>
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                      <Sparkles className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">Let AI interview you</p>
                      <p className="text-muted">A short conversation based on your resume covers the next three steps: what you're looking for, screening answers, and where to find jobs.</p>
                    </div>
                    {interviewStep ? (
                      <LinkButton href={interviewStep.href} variant={groupDone ? "secondary" : "primary"}>
                        {groupDone ? "Interview again" : interviewStep.cta}
                      </LinkButton>
                    ) : null}
                  </div>
                  <ol className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
                    {group.map((g, k) => (
                      <li key={g.key} className="flex flex-wrap items-center gap-3">
                        <StepNumber step={g} n={firstGroup + k + 1} />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{g.title}</p>
                          <p className="text-[13px] text-muted">{g.description}</p>
                        </div>
                        {g.manualHref ? (
                          <Link href={g.manualHref} className="text-[13px] text-muted underline hover:text-text">
                            {g.done ? "Review" : "Set up manually"}
                          </Link>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </Card>
              </li>
            );
          }
          return (
            <li key={step.key}>
              <Card className={cn("flex flex-wrap items-center gap-4 p-4", step.done && "opacity-75")}>
                <StepNumber step={step} n={i + 1} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{step.title}</p>
                  <p className="text-muted">{step.description}</p>
                </div>
                <LinkButton href={step.href} variant={step.done ? "secondary" : "primary"}>
                  {step.done ? "Review" : step.cta}
                </LinkButton>
              </Card>
            </li>
          );
        })}
      </ol>
      <Card className="mt-6 p-4 text-[13px] text-muted">
        <p className="font-medium text-text">How applying works</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>New postings are scored against your profile. Strong matches get a tailored resume and cover letter automatically.</li>
          <li>Every tailored claim is checked against your confirmed facts. Anything unsupported is flagged and blocks approval.</li>
          <li>You approve in the Review queue. Dry run mode (on by default) fills the form and stops before submitting so you can check it.</li>
          <li>Applications are submitted from your own browser on Greenhouse, Lever, and Ashby. LinkedIn and Indeed are used only to find jobs.</li>
        </ul>
      </Card>
    </>
  );
}
