import fs from "node:fs";
import crypto from "node:crypto";
import type { Page } from "playwright";
import { z } from "zod";
import type { LlmClient } from "@jh/llm";
import { dataPath, logger, sleep, type AtsType } from "@jh/shared";
import { extractQuestions, readComboboxOptions, type FormQuestion } from "./extract";
import { planAnswers, type AnswerContext, type PlannedAnswer } from "./answers";
import { fillAnswer } from "./fill";
import { captchaChallengeVisible, hooksFor, validationErrors } from "./ats";

const log = logger("applier");

export interface EvidenceField {
  label: string;
  name: string;
  type: string;
  value: string;
  required: boolean;
  source: "profile" | "qa_bank" | "file" | "default" | "llm_draft" | "user";
}

export type ApplyOutcome =
  | { kind: "submitted"; confirmationText: string; evidence: Evidence }
  | { kind: "dry_run_complete"; evidence: Evidence }
  | { kind: "needs_input"; reason: string; pending: PlannedAnswer[]; evidence: Evidence; keepPageOpen: boolean }
  | { kind: "failed"; error: string; evidence: Evidence; retryable: boolean };

export interface Evidence {
  url: string;
  fields: EvidenceField[];
  screenshots: { label: string; path: string }[];
  resumeSha256: string;
  coverLetterSha256: string | null;
  log: string[];
}

export interface ApplyInput {
  applicationId: string;
  applyUrl: string;
  atsType: AtsType;
  dryRun: boolean;
  answers: AnswerContext;
  /** Extra user-approved answers for this application only (from the needs-input screen), keyed by questionKey. */
  overrides: Record<string, string>;
  /** Screenshot-based verification with the model before submitting. */
  visionCheck: boolean;
  /** Unknown ATS forms always stop before submit so a human can look. */
  allowGenericSubmit: boolean;
}

const sha256 = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

async function shot(page: Page, applicationId: string, label: string, evidence: Evidence): Promise<string> {
  const p = dataPath("evidence", applicationId, `${Date.now()}-${label}.jpg`);
  await page.screenshot({ path: p, fullPage: true, type: "jpeg", quality: 70 }).catch(async () => page.screenshot({ path: p, type: "jpeg", quality: 70 }));
  evidence.screenshots.push({ label, path: p });
  return p;
}

const VisionOut = z.object({
  looksComplete: z.boolean(),
  problems: z.array(z.object({ field: z.string(), problem: z.string() })),
});

async function visionReview(llm: LlmClient, page: Page, applicationId: string): Promise<z.infer<typeof VisionOut> | null> {
  try {
    const buf = await page.screenshot({ fullPage: true, type: "jpeg", quality: 60 });
    return await llm.object({ task: "vision_form_check", tier: "fast", applicationId, maxOutputTokens: 2000 }, VisionOut, {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: buf, mediaType: "image/jpeg" },
            {
              type: "text",
              text: "This is a filled-in job application form just before submission. List required fields that still look empty, visible validation errors, or values that are obviously in the wrong field. Ignore optional demographic questions. Do not judge answer quality.",
            },
          ],
        },
      ],
    });
  } catch (err) {
    log.warn(`vision check skipped: ${(err as Error).message}`);
    return null;
  }
}

export async function applyOnPage(page: Page, llm: LlmClient | null, input: ApplyInput): Promise<ApplyOutcome> {
  const hooks = hooksFor(input.atsType);
  const evidence: Evidence = {
    url: "",
    fields: [],
    screenshots: [],
    resumeSha256: sha256(input.answers.resumePath),
    coverLetterSha256: input.answers.coverLetterPath ? sha256(input.answers.coverLetterPath) : null,
    log: [],
  };
  const note = (m: string) => {
    evidence.log.push(`${new Date().toISOString()} ${m}`);
    log.info(`[${input.applicationId.slice(0, 8)}] ${m}`);
  };

  const url = hooks.applyUrl(input.applyUrl);
  note(`Opening ${url}`);
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e: Error) => e);
  if (resp instanceof Error) return { kind: "failed", error: `Could not open the application page: ${resp.message}`, evidence, retryable: true };
  if (resp && resp.status() === 404) return { kind: "failed", error: "The posting no longer exists (404)", evidence, retryable: false };
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await hooks.prepare(page);
  evidence.url = page.url();

  if (await captchaChallengeVisible(page)) {
    await shot(page, input.applicationId, "captcha", evidence);
    return { kind: "needs_input", reason: "A human verification check appeared before the form. Complete it in the open browser window.", pending: [], evidence, keepPageOpen: true };
  }

  let questions = await extractQuestions(page);
  if (questions.filter((q) => q.type !== "file").length < 2) {
    await shot(page, input.applicationId, "no-form", evidence);
    return { kind: "failed", error: "No application form was found on the page (the posting may be closed or require sign-in)", evidence, retryable: false };
  }
  // Comboboxes load options lazily; read them so answers can be matched to real choices.
  for (const q of questions) {
    if (q.type === "combobox" && !q.options.length && !/location|city/i.test(q.label)) q.options = await readComboboxOptions(page, q);
  }
  note(`Found ${questions.length} questions`);

  const plans = await planAnswers(llm, questions, input.answers, { applicationId: input.applicationId });
  for (const p of plans) {
    const override = input.overrides[p.questionKey];
    if (override !== undefined) {
      p.value = p.options.length ? override : override;
      p.source = "user";
      p.needsUser = false;
    }
  }

  const blocking = plans.filter((p) => p.needsUser);
  if (blocking.length) {
    await shot(page, input.applicationId, "questions", evidence);
    evidence.fields = toEvidence(questions, plans);
    return {
      kind: "needs_input",
      reason: `${blocking.length} question${blocking.length === 1 ? "" : "s"} need your answer before this application can be submitted.`,
      pending: blocking,
      evidence,
      keepPageOpen: false,
    };
  }

  // Fill in DOM order.
  const byHandle = new Map(questions.map((q) => [q.handle, q]));
  const failures: string[] = [];
  for (const p of plans) {
    const q = byHandle.get(p.handle);
    if (!q || (!p.value && !p.filePath)) continue;
    const r = await fillAnswer(page, q, p);
    if (!r.ok) failures.push(`${q.label || q.handle}: ${r.error}`);
  }

  // Re-read the form: some answers reveal follow-up questions (e.g. "If yes, explain").
  await sleep(800);
  const after = await extractQuestions(page);
  const newQuestions = after.filter((q) => !byHandle.has(q.handle));
  if (newQuestions.length) {
    note(`${newQuestions.length} follow-up questions appeared`);
    const more = await planAnswers(llm, newQuestions, input.answers, { applicationId: input.applicationId });
    for (const p of more) {
      const override = input.overrides[p.questionKey];
      if (override !== undefined) Object.assign(p, { value: override, source: "user", needsUser: false });
    }
    const moreBlocking = more.filter((p) => p.needsUser);
    plans.push(...more);
    questions = [...questions, ...newQuestions];
    if (moreBlocking.length) {
      evidence.fields = toEvidence(questions, plans);
      await shot(page, input.applicationId, "followups", evidence);
      return { kind: "needs_input", reason: "Follow-up questions need your answer.", pending: moreBlocking, evidence, keepPageOpen: false };
    }
    for (const p of more) {
      const q = newQuestions.find((x) => x.handle === p.handle);
      if (q && (p.value || p.filePath)) {
        const r = await fillAnswer(page, q, p);
        if (!r.ok) failures.push(`${q.label}: ${r.error}`);
      }
    }
  }

  const finalQs = await extractQuestions(page);
  const emptyRequired = finalQs.filter((q) => q.required && !q.currentValue && q.type !== "file" && q.type !== "combobox");
  if (failures.length || emptyRequired.length) {
    note(`Fill problems: ${[...failures, ...emptyRequired.map((q) => `${q.label}: still empty`)].join("; ")}`);
  }
  evidence.fields = toEvidence(finalQs.length ? mergeCurrent(questions, finalQs) : questions, plans);

  if (input.visionCheck && llm) {
    const review = await visionReview(llm, page, input.applicationId);
    if (review && !review.looksComplete && review.problems.length) {
      note(`Visual check found: ${review.problems.map((p) => `${p.field}: ${p.problem}`).join("; ")}`);
      failures.push(...review.problems.map((p) => `${p.field}: ${p.problem}`));
    }
  }
  await shot(page, input.applicationId, "before-submit", evidence);

  if (failures.length) {
    return { kind: "needs_input", reason: `Some fields could not be filled reliably: ${failures.slice(0, 6).join("; ")}. Check the open browser window.`, pending: [], evidence, keepPageOpen: true };
  }

  if (input.dryRun) {
    note("Dry run: stopping before submit");
    return { kind: "dry_run_complete", evidence };
  }
  if (hooks.type === "other" && !input.allowGenericSubmit) {
    return { kind: "needs_input", reason: "This form is on an unrecognized site. Review the filled form in the browser and submit it yourself, then mark it submitted.", pending: [], evidence, keepPageOpen: true };
  }

  note("Submitting");
  await hooks.submit(page);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const conf = await hooks.confirmation(page);
    if (conf) {
      await shot(page, input.applicationId, "confirmation", evidence);
      note("Confirmation detected");
      return { kind: "submitted", confirmationText: conf, evidence };
    }
    if (await captchaChallengeVisible(page)) {
      await shot(page, input.applicationId, "captcha-on-submit", evidence);
      return { kind: "needs_input", reason: "A human verification check appeared on submit. Complete it in the open browser window, then mark the application submitted.", pending: [], evidence, keepPageOpen: true };
    }
  }
  const errors = await validationErrors(page);
  await shot(page, input.applicationId, "after-submit", evidence);
  if (errors.length) {
    return { kind: "needs_input", reason: `The form reported: ${errors.slice(0, 5).join("; ")}`, pending: [], evidence, keepPageOpen: true };
  }
  return { kind: "needs_input", reason: "Submitted, but no confirmation page was detected. Check the browser window or your email, then mark the result.", pending: [], evidence, keepPageOpen: true };
}

function mergeCurrent(orig: FormQuestion[], latest: FormQuestion[]): FormQuestion[] {
  const cur = new Map(latest.map((q) => [q.handle, q]));
  return [...orig.map((q) => ({ ...q, currentValue: cur.get(q.handle)?.currentValue ?? q.currentValue })), ...latest.filter((q) => !orig.some((o) => o.handle === q.handle))];
}

function toEvidence(questions: FormQuestion[], plans: PlannedAnswer[]): EvidenceField[] {
  const plan = new Map(plans.map((p) => [p.handle, p]));
  return questions.map((q) => {
    const p = plan.get(q.handle);
    return {
      label: q.label,
      name: q.name || q.id,
      type: q.type,
      value: p?.filePath ? `${p.value}: ${p.filePath.split(/[\\/]/).pop()}` : q.currentValue || p?.value || "",
      required: q.required,
      source: p?.source ?? "default",
    };
  });
}
