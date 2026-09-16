import type { ApplicationStatus } from "./schemas";

/** Allowed application status transitions. Anything else is a bug. */
export const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  matched: ["tailoring", "skipped", "rejected_by_user"],
  tailoring: ["ready_for_review", "failed", "matched"],
  ready_for_review: ["approved", "rejected_by_user", "tailoring"],
  approved: ["applying", "ready_for_review", "skipped"],
  applying: ["submitted", "needs_input", "failed", "approved"],
  needs_input: ["approved", "applying", "failed", "skipped", "submitted"],
  submitted: [],
  failed: ["approved", "tailoring", "skipped", "matched"],
  skipped: ["matched"],
  rejected_by_user: ["matched"],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}
