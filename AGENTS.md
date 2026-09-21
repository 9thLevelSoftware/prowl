# AGENTS.md

Local-first job application system (**Prowl**). pnpm monorepo (`apps/*`, `packages/*`), packages named `@prowl/*`. Deep design notes: `docs/architecture.md`. Product behavior and command table: `README.md`.

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
| `pnpm test:golden` | Real LLM tests (`PROWL_GOLDEN=1`). Needs a configured AI connection; uses the **real** data dir/DB; serial; 300s timeout. Skipped unless `PROWL_GOLDEN=1` |
| `pnpm typecheck` | `pnpm -r typecheck` (each package runs `tsc -p tsconfig.json`) |
| `pnpm --filter @prowl/<pkg> typecheck` | One package |
| `pnpm db:generate` | After editing `packages/db/src/schema.ts` only |
| `pnpm db:migrate` | Apply migrations (`pnpm dev` also migrates first) |
| `pnpm seed:demo` then `pnpm dev:demo` | Demo dataset in `./data-demo`, no AI; separate from real `./data` |
| `node scripts/update-catalog.mjs` | Refresh bundled models.dev catalog snapshot |
| `pnpm lint` | **Broken:** script is `eslint .` but no ESLint config exists. Do not rely on it |

There is no CI, pre-commit hook, Prettier, or Biome config. Trust `pnpm typecheck` + `pnpm test`.

## Workspace facts agents often miss

- **Packages ship TypeScript source, not build output.** `exports` point at `./src/*.ts`. Next.js lists them in `transpilePackages`. Do not look for `dist/` or run package builds.
- **Workspace scope is `@prowl/*`** (rebranded from `@jh/*`). Do not reintroduce `@jh/` imports.
- **One root `.env`** serves web and worker. Next loads it from the repo root via `@next/env`. Worker uses `tsx --env-file-if-exists=../../.env`.
- **Env prefix is `PROWL_*`** (was `JH_*`). Clean break: no dual-read of old names.
- **Two processes share one SQLite file** (WAL + busy timeout). Mutations are Next server actions that enqueue tasks; the worker claims them from `queue_tasks`. Do not invent a second DB or API layer for local work.
- **All runtime data lives under `PROWL_DATA_DIR`** (default `./data` at repo root): SQLite (`prowl.sqlite`), PDFs, screenshots, embedding cache, Chrome profile, encrypted secrets. Tests override this to a temp dir.
- **Schema conventions** (`packages/db/src/schema.ts`): text UUID PKs, ISO-8601 text timestamps, JSON as text, `user_id` on every row (`"local"` for now). Keep these portable to Postgres.
- **Application status** is a hard state machine in `packages/shared/src/states.ts`. Every status change must go through `transitionApplication` — illegal transitions throw. Crash recovery is included: interrupted applies go `applying → needs_input`/`failed` via `transitionApplication` (`recoverInterruptedApplies`); never silent re-submit.
- **Worker control API** is `http://127.0.0.1:3031` (`GET /health`, `GET /events`, `POST /browser/login`, `POST /browser/close`, `POST /llm/ping`, `POST /schedule/reload`). Web proxies events at `/api/events`.
- **Worker lanes** are executable in `apps/worker/src/index.ts`: `BROWSER_TYPES = ["apply"]` (browser lane, concurrency 1) and `LLM_TYPES` for discovery/match/tailor/sources (LLM lane, concurrency 2). LinkedIn/Indeed discovery is **LLM-lane** `discover_source`; it serializes with apply only via `withBrowserLock` — do not put discovery types in the browser-lane array.
- **Second `pnpm dev` instance** (e.g. against demo data) needs `PROWL_NEXT_DIST_DIR` so Next does not clobber `.next`.
- **PDF/DOCX rendering** launches Playwright Chromium (`packages/documents/src/render.ts`). Missing browser → run `pnpm --filter @prowl/documents exec playwright install chromium`.
- **Browser profile** (`packages/browser`) is a persistent Chrome profile under the data dir. Only the worker may drive it (lock shared with apply + LinkedIn/Indeed discovery). Default channel is installed Chrome; tests force `PROWL_BROWSER_CHANNEL=chromium`.
- **Secrets**: OS keychain service `prowl` holds a master key **outside the data dir** (account `master-key`); AES-encrypted material is in `data/secrets.json` (Windows Credential Manager cannot hold OAuth tokens). Settings → Delete all data wipes data-dir secrets but not the keychain entry. Tests set `PROWL_SECRETS_NO_KEYCHAIN=1` and `PROWL_CATALOG_OFFLINE=1`.
- **Optional `PROWL_WORKER_TOKEN`**: bootstrap generates it into `.env`. When set, web sends `X-Prowl-Worker-Token` on control POSTs and the worker rejects POSTs without it (in addition to Origin/Host checks).

## Testing

- Default suite include (`vitest.config.ts`): `packages/*/test/**/*.test.ts`, `apps/worker/test/**/*.test.ts`, and `apps/web/test/**/*.test.ts`. Golden files (`**/*.golden.test.ts`) are excluded from `pnpm test`.
- Unit tests use temp `PROWL_DATA_DIR` + temp SQLite; applier/e2e tests spin a local mock ATS (`packages/applier/test/mock-ats.ts`) and headless Chromium. No credentials required for `pnpm test`.
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

## Authority when docs disagree (C7)

Executable sources win. Prefer, in order:

1. **Executable**: `package.json` scripts, `vitest.config.ts` / `vitest.golden.config.ts`, `packages/shared/src/states.ts`, `packages/shared/src/schemas.ts`, worker lane constants (`BROWSER_TYPES` / `LLM_TYPES` in `apps/worker/src/index.ts`), and other runtime code.
2. **This file (AGENTS.md)** for agent operating facts — still subordinate to (1) if they conflict.
3. **`docs/architecture.md`**: design intent and narrative, **not** executable authority. Useful for product shape; when its state diagram, lane model, or endpoint list disagrees with code, code wins.
4. **README.md** for product/user prose; least authoritative for machine behavior.

Do not treat incomplete narrative diagrams as the state machine. Do not treat architecture prose as proof of lane membership.
