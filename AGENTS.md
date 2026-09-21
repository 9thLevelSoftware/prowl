# AGENTS.md

Local-first job application system. pnpm monorepo (`apps/*`, `packages/*`), packages named `@jh/*`. Deep design notes: `docs/architecture.md`. Product behavior and command table: `README.md`.

## Requirements

- Node 22+, pnpm 9 (`packageManager: pnpm@9.15.9`)
- On Windows, locate tools with `Get-Command` / `where.exe` (not Unix paths)
- First-time setup: `pnpm install && pnpm bootstrap` (creates root `.env`, installs Playwright Chromium for PDFs, migrates SQLite)

## Commands

| Command | Notes |
| --- | --- |
| `pnpm dev` | Migrates DB, then runs web (`:3000`) + worker (`:3031`) in parallel |
| `pnpm test` | Unit/integration only. No network or AI. Embeddings disabled via vitest env |
| `pnpm test <path>` | Single file, e.g. `pnpm test packages/core/test/validate.test.ts` |
| `pnpm test:golden` | Real LLM tests (`JH_GOLDEN=1`). Needs a configured AI connection; uses the **real** data dir/DB; serial; 300s timeout. Skipped unless `JH_GOLDEN=1` |
| `pnpm typecheck` | `pnpm -r typecheck` (each package runs `tsc -p tsconfig.json`) |
| `pnpm --filter @jh/<pkg> typecheck` | One package |
| `pnpm db:generate` | After editing `packages/db/src/schema.ts` only |
| `pnpm db:migrate` | Apply migrations (`pnpm dev` also migrates first) |
| `pnpm seed:demo` then `pnpm dev:demo` | Demo dataset in `./data-demo`, no AI; separate from real `./data` |
| `node scripts/update-catalog.mjs` | Refresh bundled models.dev catalog snapshot |
| `pnpm lint` | **Broken:** script is `eslint .` but no ESLint config exists. Do not rely on it |

There is no CI, pre-commit hook, Prettier, or Biome config. Trust `pnpm typecheck` + `pnpm test`.

## Workspace facts agents often miss

- **Packages ship TypeScript source, not build output.** `exports` point at `./src/*.ts`. Next.js lists them in `transpilePackages`. Do not look for `dist/` or run package builds.
- **One root `.env`** serves web and worker. Next loads it from the repo root via `@next/env`. Worker uses `tsx --env-file-if-exists=../../.env`.
- **Two processes share one SQLite file** (WAL + busy timeout). Mutations are Next server actions that enqueue tasks; the worker claims them from `queue_tasks`. Do not invent a second DB or API layer for local work.
- **All runtime data lives under `JH_DATA_DIR`** (default `./data` at repo root): SQLite, PDFs, screenshots, embedding cache, Chrome profile, encrypted secrets. Tests override this to a temp dir.
- **Schema conventions** (`packages/db/src/schema.ts`): text UUID PKs, ISO-8601 text timestamps, JSON as text, `user_id` on every row (`"local"` for now). Keep these portable to Postgres.
- **Application status** is a hard state machine in `packages/shared/src/states.ts`. Every status change must go through `transitionApplication` — illegal transitions throw.
- **Worker control API** is `http://127.0.0.1:3031` (`/health`, `/events`, `/browser/login`, …). Web proxies events at `/api/events`.
- **Second `pnpm dev` instance** (e.g. against demo data) needs `JH_NEXT_DIST_DIR` so Next does not clobber `.next`.
- **PDF/DOCX rendering** launches Playwright Chromium (`packages/documents/src/render.ts`). Missing browser → run `pnpm --filter @jh/documents exec playwright install chromium`.
- **Browser profile** (`packages/browser`) is a persistent Chrome profile under the data dir. Only the worker may drive it (lock shared with apply + LinkedIn/Indeed discovery). Default channel is installed Chrome; tests force `JH_BROWSER_CHANNEL=chromium`.
- **Secrets**: OS keychain holds a master key; AES-encrypted material is in `data/secrets.json` (Windows Credential Manager cannot hold OAuth tokens). Tests set `JH_SECRETS_NO_KEYCHAIN=1` and `JH_CATALOG_OFFLINE=1`.

## Testing

- Default suite include: `packages/*/test/**/*.test.ts` and `apps/worker/test/**/*.test.ts`. Golden files (`**/*.golden.test.ts`) are excluded from `pnpm test`.
- Unit tests use temp `JH_DATA_DIR` + temp SQLite; applier/e2e tests spin a local mock ATS (`packages/applier/test/mock-ats.ts`) and headless Chromium. No credentials required for `pnpm test`.
- Shared fixtures: `packages/core/test/fixtures.ts` (Jordan Rivera profile).
- `packages/sources/test/live.manual.ts` is a live-network manual probe, not part of vitest.

## Product constraints (do not break)

- Tailoring must not invent employers, titles, dates, skills, or metrics. Identity fields render from the profile (`resolveTailored`), never model output. Every bullet cites fact IDs; `validate.ts` strips unconfirmed skills and unsupported numbers; a separate auditor labels claims. `approveApplication` refuses while resume/cover audits are `flagged`.
- Dry run is on by default. Only Greenhouse, Lever, and Ashby auto-submit. No CAPTCHA solving. No automated apply on LinkedIn/Indeed.
- Unconfirmed source-builder boards stay `unconfirmed` and unchecked.

## Resume craft (hardbaked)

- Resume writing/tailoring knowledge from ResumeSkills lives in `packages/core/src/resume-craft.ts` and is injected into LLM system prompts via `tailorSystemPrompt()`, `coverLetterSystemPrompt()`, `bulletDraftSystemPrompt()`, `summaryDraftSystemPrompt()`, and `requirementsSystemPrompt()`.
- Used by `packages/core/src/tailor.ts`, `profile.ts` (guided builder), and `requirements.ts`. Do not re-paste craft prose into individual prompts — extend `resume-craft.ts`.
- Craft is truth-gated: XYZ/achievement bullets, ATS keyword placement, tailor/cover-letter structure are encouraged; estimating or inventing metrics/tools/scope is forbidden because `validate.ts` + the auditor will fail the output.
- Renderer layout (single-column ATS HTML) is in `packages/documents/src/html.ts` — content craft vs layout craft are separate.

## Layout (ownership)

```
apps/web          Next.js UI, server actions, event proxy
apps/worker       Queue consumer (browser lane = apply; LLM lane = discovery/match/tailor)
packages/shared   Zod schemas, config/dataDir, state machine, title filter
packages/db       Drizzle schema + SQLite client + queue/repos
packages/llm      Vercel AI SDK wrapper, OAuth, catalog, secrets, usage ledger
packages/core     Facts, match, tailor, validate, interview, pipeline
packages/documents Resume parse + ATS-safe PDF/DOCX (Playwright)
packages/sources  Board adapters (Greenhouse/Lever/Ashby/Adzuna/career/LinkedIn/Indeed)
packages/browser  Shared persistent Chrome profile (worker-only)
packages/applier  ATS form extract/plan/fill/submit + mock-ats tests
```

Prefer executable sources (`package.json` scripts, vitest configs, `docs/architecture.md`) over README prose if they disagree.
