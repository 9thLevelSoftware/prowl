# Architecture

## Processes

- **Web** (`apps/web`, Next.js). Server components read SQLite directly. Mutations are server actions that write to the DB and enqueue tasks. Live updates come from the worker's event stream, proxied at `/api/events`. The page refreshes on events, throttled.
- **Worker** (`apps/worker`). Polls the `queue_tasks` table in two lanes. The browser lane runs one task at a time for applications. The LLM lane runs two at a time for discovery, matching, and tailoring. Browser-based discovery shares a lock with applications so they never drive the Chrome profile concurrently. A local control API on 127.0.0.1:3031 exposes `/health`, `/events`, `/browser/login`, `/llm/ping`, and `/schedule/reload`.

Both processes open the same SQLite file in WAL mode with a busy timeout. The queue claims tasks with an `UPDATE … WHERE id = (SELECT …)` in an immediate transaction, so a task cannot be claimed twice. Tasks left running by a crashed worker are recovered at startup.

## Data model

See `packages/db/src/schema.ts`. Every row carries `user_id`, with `local` for now. IDs are text UUIDs, timestamps are ISO text, and JSON is stored as text. Porting to Postgres/Supabase is a dialect switch in Drizzle.

Application states (`packages/shared/src/states.ts`):

```
matched → tailoring → ready_for_review → approved → applying → submitted
                ↘ failed        ↘ rejected_by_user        ↘ needs_input ↔ approved
```

Every transition goes through `transitionApplication`, which enforces the state machine and appends an `application_events` row.

## Truthfulness pipeline

1. `buildFacts(profile)` creates a stable, numbered ledger (`W1.2`, `K3`, `E1`…) from the confirmed profile.
2. **Tailor** (LLM). Output is structured. Every bullet and the summary cite fact IDs. The system prompt allows rephrasing and emphasis and forbids new metrics, tools, scope, or outcomes.
3. **Validate** (deterministic, `validate.ts`).
   - Unknown fact IDs and uncited claims are errors.
   - Numbers not present in the cited facts are errors.
   - Unconfirmed or invented skills and certifications are removed.
   - Unknown role IDs are dropped.
   - One repair round re-prompts the model with the exact errors.
4. **Audit** (separate LLM call, adversarial prompt). Each claim is labeled entailed, exaggerated, or fabricated. Deterministic errors override an "entailed" verdict. Claims the auditor skipped are treated as unverified.
5. **Render.** Identity fields (employer, title, dates, education) always come from the profile (`resolveTailored`), never from model output.
6. **Review gate.** `approveApplication` refuses while a resume or cover letter audit is `flagged`. Accepting flags requires a note, which is logged.

## ATS optimization

Screening is modeled as two layers.

- **Keyword filter:** exact hard terms such as tools, certifications, and frameworks. The tailor prompt uses the posting's spelling for skills the candidate truly has; synonyms like K8s and Kubernetes resolve through `skills.ts`.
- **Semantic ranker:** natural, specific language. Keyword stuffing is prohibited.

Coverage before and after tailoring, plus semantic similarity from local MiniLM embeddings with a TF-IDF fallback, is shown in Review. The documents are single column with standard headings, no tables or graphics, and real text, as both PDF and DOCX.

## Applier

`packages/applier` works the same way on every supported ATS.

1. `hooks.applyUrl` normalizes the URL. Greenhouse uses the embed form URL, which works even for companies with custom career sites. `hooks.prepare` reveals the form.
2. `extractQuestions` runs a script in the page. It groups radios and checkboxes, resolves labels (for, aria-labelledby, wrapping label, legend, ancestor heuristic), and tags controls with `data-jh-q`. Combobox options are read with scoping so phone-country widgets don't leak in.
3. `planAnswers` resolves each question in order:
   - standard profile fields
   - the approved Q&A bank
   - EEO questions, which default to decline
   - optional marketing consent, left unchecked
   - LLM drafts, which **pause for approval** when the question is required and blank the answer when it isn't
4. `fillAnswer` types with human-like pacing, uses search-then-choose for comboboxes, force-checks custom inputs, uploads files, and reads each value back.
5. It re-extracts to catch follow-up questions, checks required fields, and runs an optional screenshot review by a vision model.
6. On dry run it stops. Otherwise it submits, detects confirmation by URL or text, and watches for CAPTCHA challenges and validation errors.
7. Evidence recorded: form snapshot, screenshots, log, and SHA-256 hashes of the uploaded files.

Only Greenhouse, Lever, and Ashby submit automatically. Other sites go to Needs you with the files ready.

## LLM layer

`packages/llm` wraps the Vercel AI SDK so one interface serves Gemini, OpenAI, ChatGPT, and Anthropic.

- OAuth providers use `bearerFetch`, which injects a token from `JH_LLM_ACCESS_TOKEN`, `JH_LLM_TOKEN_CMD`, or `JH_LLM_TOKEN_FILE` and retries once on 401 with a refreshed token.
- The ChatGPT backend requires streaming, `store: false`, and top-level `instructions`. The request body is rewritten to match.
- A semaphore caps concurrency.
- Every call is recorded in `llm_calls` with tokens, duration, errors, and estimated cost for API-key providers.

Prompts keep a stable prefix (system prompt plus fact ledger) ahead of per-job content, so providers with implicit prompt caching reuse it across jobs.

## Not yet built

- Workday: multi-step flows with account creation. Workday postings are listed for manual application.
- Batch-API bulk tailoring, hosted multi-user auth, and Gmail reply detection.
