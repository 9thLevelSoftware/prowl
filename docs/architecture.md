# Architecture

## Processes

- **Web** (`apps/web`, Next.js). Server components read SQLite directly. Mutations are server actions that write to the DB and enqueue tasks. Live updates come from the worker's event stream, proxied at `/api/events`. The page refreshes on events, throttled.
- **Worker** (`apps/worker`). Polls the `queue_tasks` table in two lanes. **Executable authority** (`apps/worker/src/index.ts`): `BROWSER_TYPES = ["apply"]` and `LLM_TYPES = ["discover_all", "discover_source", "process_job", "tailor", "build_sources"]`.
  - Browser lane (concurrency 1): **applications only** (`apply`).
  - LLM lane (concurrency 2): discovery, matching, tailoring, source building — including LinkedIn/Indeed discovery (`discover_source`). Those adapters take `withBrowserLock` (`@prowl/browser`) so they serialize with apply on the shared Chrome profile; they are **not** browser-lane queue types.
  - A local control API on 127.0.0.1:3031 exposes `GET /health`, `GET /events`, `POST /browser/login`, `POST /browser/close`, `POST /llm/ping`, and `POST /schedule/reload`. Web proxies events at `/api/events`. Control POSTs pass Origin/Host checks (PR 3); when `PROWL_WORKER_TOKEN` is set (bootstrap generates it into `.env`), web also sends `X-Prowl-Worker-Token` and the worker rejects POSTs that omit or mismatch it (PR 10).

Both processes open the same SQLite file in WAL mode with a busy timeout. The queue claims tasks with an `UPDATE … WHERE id = (SELECT …)` in an immediate transaction, so a task cannot be claimed twice. Queue tasks left `running` by a crashed worker are recovered at startup (`recoverStaleTasks`). Interrupted **applications** follow the recovery contract below — they are not silently re-submitted.

## Data model

See `packages/db/src/schema.ts`. Every row carries `user_id`, with `local` for now. IDs are text UUIDs, timestamps are ISO text, and JSON is stored as text. Porting to Postgres/Supabase is a dialect switch in Drizzle.

Application states are the hard machine in `packages/shared/src/states.ts` (executable authority). Statuses come from `APPLICATION_STATUSES` in `packages/shared/src/schemas.ts`. The adjacency list below is generated from `TRANSITIONS` — every edge listed is legal; anything else throws.

```
matched          → tailoring | skipped | rejected_by_user
tailoring        → ready_for_review | failed | matched
ready_for_review → approved | rejected_by_user | tailoring
approved         → applying | ready_for_review | skipped
applying         → submitted | needs_input | failed | approved
needs_input      → approved | applying | failed | skipped | submitted
submitted        → (terminal; no outgoing edges)
failed           → approved | tailoring | skipped | matched
skipped          → matched
rejected_by_user → matched
```

Happy path sketch (not the full machine):

```
matched → tailoring → ready_for_review → approved → applying → submitted
```

Notes:

- **Identity transitions**: `canTransition(from, to)` is true when `from === to`. Same-status writes are legal (re-log / re-patch) and are not illegal machine moves.
- **`skipped` / `failed` are first-class**: not dead ends. `skipped` and `rejected_by_user` can return to `matched`; `failed` can re-enter approve/tailor/skip/match.
- **`needs_input` exits** are broader than “wait for user answer”: also `applying`, `failed`, `skipped`, and `submitted` (besides `approved`).
- **`applying → approved`** is a legal edge for explicit user re-approve only. Crash recovery must not use it.
- **Recovery contract (PR 2)**: worker startup calls `recoverInterruptedApplies` (`packages/db/src/repo.ts`). Interrupted applies (`status = applying`, dry-run or real) move to `needs_input` via `transitionApplication` (fallback `failed` if that edge is rejected). Recovery ignores `dryRun` for the transition choice, logs `recovery:interrupted` + `status:needs_input` (or `failed`), and never auto-re-submits. Re-apply only after a fresh `approveApplication`.
- Every legal status change — including recovery — goes through `transitionApplication`, which enforces the state machine and appends an `application_events` row.

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

`packages/llm` wraps the Vercel AI SDK so one interface serves every provider.

**Connections** (`llm_connections` table). Each row holds one provider, one credential, and saved choices: `selections.main` and `selections.fast` store `{ model, effort }`, and `selections.effortByModel` stores the last effort per model. The active connection id lives in `settings` under `llm.activeConnectionId`. `LlmClient.reload()` resolves it before each worker task, so changes apply to the next task.

| SDK | Used for | Effort sent as |
| --- | --- | --- |
| `openai` | OpenAI API keys (Responses API) | `providerOptions.openai.reasoningEffort` |
| `openai-chatgpt` | ChatGPT sign-in, `chatgpt.com/backend-api/codex` | body rewrite: `reasoning.effort`, `store: false`, `stream: true`, `instructions` |
| `anthropic` | Anthropic keys | `anthropic.effort`, or `thinking` budgets for older models |
| `google` | Gemini keys and Google sign-in | `thinkingConfig.thinkingLevel` or `thinkingBudget` |
| `openai-compatible` | Catalog providers with an OpenAI-style API, local servers, custom endpoints | `reasoning_effort` |

- **Catalog** (`catalog.ts`): models.dev data for provider base URLs, model names, context sizes, prices, and effort options. It is cached in the data dir, refreshed daily, and falls back to the bundled `catalog-snapshot.json.gz`. Refresh the snapshot with `node scripts/update-catalog.mjs`.
- **Models** (`models.ts`): the live model list from the provider (ChatGPT `/models` with `supported_reasoning_levels`, OpenAI, Anthropic, Gemini, or `{base}/models`), merged with catalog metadata into `ModelInfo` and cached on the connection. When the live list fails, catalog models are shown with the error.
- **Sign-in** (`oauth/`): PKCE plus a one-shot loopback server on 127.0.0.1.
  - ChatGPT uses the Codex OAuth client and its registered `http://localhost:1455/auth/callback`.
  - Gemini uses the user's own Desktop OAuth client on a random loopback port.
  - A connection is created only after sign-in succeeds.
  - Access tokens refresh 2 minutes before expiry and once on a 401. Refreshes are serialized across the web and worker processes with a DB lock (`refresh_lock_until`), because refresh tokens rotate.
- **Secrets** (`secrets.ts`): Windows Credential Manager caps entries at 1,280 characters, which is too short for OAuth tokens. So one random 256-bit master key is stored in the OS keychain **outside the data directory** (service `prowl`, account `master-key` — Windows Credential Manager / macOS login keychain / Linux Secret Service), and secrets are AES-256-GCM encrypted in `data/secrets.json`. Without a keychain, the master key is kept in `data/secrets.key` and Settings shows a warning. **Settings → Delete all data** wipes the data dir (SQLite + wal/shm, secrets.key, secrets.json, documents, evidence, browser profile, embedding model cache) but does **not** remove the OS keychain entry — clear it yourself in the OS credential UI if you want the key gone.
- **Legacy:** `.env` variables create a read-only "From .env" connection only when no connection exists and credentials are set.
- A semaphore caps concurrency per connection. Every call is recorded in `llm_calls` with the model and effort, tokens, duration, errors, and estimated cost from catalog prices. Cost is not tracked for ChatGPT sign-in.

Prompts keep a stable prefix (system prompt plus fact ledger) ahead of per-job content, so providers with implicit prompt caching reuse it across jobs.

## Interview

`packages/core/src/interview.ts` runs three structured calls on the main model. Effort is picked per task: `interview_analyze` and `interview_summarize` at high, `interview_turn` at medium. The draft lives in the `interviews` table as JSON until the user applies the review.

Deterministic guards sit between the model and the draft:

- Preference patches are validated field by field. Invalid values are dropped, not guessed. Omitted fields count as "no change".
- Screening answers and profile additions must carry evidence that appears in the candidate's own messages.
- Only the candidate can skip a topic. The model's "skipped" is accepted only when the latest answer declines, and a covered topic never goes back.
- Near-duplicate additions are merged. Avoided categories such as "crypto companies" move to excluded industries instead of company names.
- `LlmClient.object` retries once when a reply doesn't match the schema.

`applyInterview` (`interview-apply.ts`) saves preferences, approved Q&A, and the checked additions as a new profile version with a new fact ledger. It then adds the checked sources, queues discovery, and re-scores jobs.

## Source builder

`packages/sources/src/builder.ts` runs as the `build_sources` worker task.

1. **Candidates:** AI-suggested employers, board URLs from web search (native search on OpenAI connections, else Firecrawl), boards behind jobs already discovered, and LinkedIn/Indeed/Adzuna searches.
2. **Verification:** known board tokens are fetched from the public ATS APIs. Otherwise slug variants are tried, then the careers page is scanned for embedded boards. Greenhouse board names, posting hosts, and domains confirm identity. Anything unconfirmed is stored as `unconfirmed` and left unchecked.
3. **Counts:** open jobs and jobs passing the title filter, with the closest titles as samples.

Results go to `source_suggestions`, unique per user, type, and board. Added and dismissed rows keep their status across runs.

The title filter (`packages/shared/src/titles.ts`) matches whole words. Level words (senior, staff) are optional. Role words (head, VP) are required when a title has only one other word. Bare role keywords are ignored. Titles in another function (marketing, legal, design, sales, and so on) are skipped unless a target title names that function.

## Not yet built

- Workday: multi-step flows with account creation. Workday postings are listed for manual application.
- Batch-API bulk tailoring, hosted multi-user auth, and Gmail reply detection.
