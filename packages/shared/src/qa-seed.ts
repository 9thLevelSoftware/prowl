/**
 * Common screening questions offered during onboarding. Answering these once removes most
 * first-time pauses. Keys must match questionKey() normalization of typical labels; the
 * answer planner also lets the model map differently worded questions onto these.
 *
 * Lives in @prowl/shared so core/interview and the web QA page can use it without depending
 * on browser-bound packages (@prowl/applier / @prowl/browser).
 */
export type CommonQuestion = {
  key: string;
  text: string;
  type: "text" | "select" | "boolean";
  options?: string[];
  help?: string;
};

export const COMMON_QUESTIONS: CommonQuestion[] = [
  { key: "are you legally authorized to work in the united states", text: "Are you legally authorized to work in the United States?", type: "boolean" },
  { key: "will you now or in the future require sponsorship for employment visa status", text: "Will you now or in the future require visa sponsorship?", type: "boolean" },
  { key: "are you at least 18 years of age", text: "Are you at least 18 years old?", type: "boolean" },
  { key: "are you willing to relocate", text: "Are you willing to relocate?", type: "boolean" },
  { key: "what are your salary expectations", text: "What are your salary expectations?", type: "text", help: "e.g. $150,000 to $170,000 base, flexible depending on total compensation" },
  { key: "when can you start", text: "When can you start / what is your notice period?", type: "text", help: "e.g. Two weeks after an offer" },
  { key: "how did you hear about this job", text: "How did you hear about this job?", type: "text", help: "e.g. Company careers page" },
  { key: "have you previously worked for this company", text: "Have you previously worked for this company?", type: "boolean" },
  { key: "do you have a security clearance", text: "Do you have an active security clearance?", type: "text", help: "e.g. No" },
  { key: "i acknowledge the privacy policy", text: "Acknowledge the applicant privacy policy / data processing consent", type: "boolean", help: "Answering Yes lets the applier tick required privacy acknowledgments" },
  { key: "eeo:gender", text: "Gender (voluntary self-identification)", type: "select", options: ["Decline to self-identify", "Male", "Female", "Non-binary"] },
  { key: "eeo:race", text: "Race / ethnicity (voluntary)", type: "select", options: ["Decline to self-identify"], help: "Leave as decline, or type the exact category you want used" },
  { key: "eeo:hispanic", text: "Hispanic or Latino? (voluntary)", type: "select", options: ["Decline to self-identify", "Yes", "No"] },
  { key: "eeo:veteran", text: "Veteran status (voluntary)", type: "select", options: ["Decline to self-identify", "I am not a protected veteran", "I identify as one or more of the classifications of protected veteran"] },
  { key: "eeo:disability", text: "Disability status (voluntary)", type: "select", options: ["Decline to self-identify", "No, I do not have a disability", "Yes, I have a disability"] },
];
