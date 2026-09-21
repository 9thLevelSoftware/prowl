import { APPLIABLE_ATS, type AtsType } from "./schemas";

export type AutoSubmitAuditStatus = "pending" | "pass" | "flagged" | "accepted";

export interface AutoSubmitGate {
  atsType: AtsType | string | null | undefined;
  dryRun: boolean | null | undefined;
  auditStatus?: AutoSubmitAuditStatus | null | undefined;
}

/**
 * Policy gate for automatic real submission (Greenhouse / Lever / Ashby only).
 * Fail-closed: missing or non-allowlisted ATS, dry-run, or a flagged audit
 * never auto-submit. Dry-run form-fill is a separate lane — it may still run
 * on an allowlisted ATS after audit checks, but this function stays false
 * until dryRun is explicitly false.
 */
export function canAutoSubmit({ atsType, dryRun, auditStatus }: AutoSubmitGate): boolean {
  if (!atsType || !(APPLIABLE_ATS as readonly string[]).includes(atsType)) return false;
  if (auditStatus === "flagged") return false;
  return dryRun === false;
}
