import { Check } from "lucide-react";
import { Card, LinkButton, PageHeader, cn } from "@/components/ui";
import { onboardingSteps } from "@/lib/onboarding";

export default function Onboarding() {
  const steps = onboardingSteps();
  return (
    <>
      <PageHeader
        title="Get started"
        description="Six steps. After this, discovery and tailoring run on their own, and nothing is submitted until you approve it."
      />
      <ol className="flex flex-col gap-3">
        {steps.map((step, i) => (
          <li key={step.key}>
            <Card className={cn("flex flex-wrap items-center gap-4 p-4", step.done && "opacity-75")}>
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full border text-[13px] font-semibold",
                  step.done ? "border-transparent bg-ok text-white dark:text-[#0d1a13]" : "border-border text-muted",
                )}
              >
                {step.done ? <Check className="size-4" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{step.title}</p>
                <p className="text-muted">{step.description}</p>
              </div>
              <LinkButton href={step.href} variant={step.done ? "secondary" : "primary"}>
                {step.done ? "Review" : step.cta}
              </LinkButton>
            </Card>
          </li>
        ))}
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
