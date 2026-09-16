# Job Hunter

A local-first job application system. It reads your resume, finds matching jobs, tailors a truthful ATS-friendly resume and cover letter for each one, applies from your own browser after you approve, and records every application.

Everything runs on your computer. Nothing is submitted until you approve it.

## How it works

1. **Profile.** Upload a resume (PDF, DOCX, TXT) or build one in the editor. The AI copies it into a structured profile. You confirm which skills are real. The confirmed profile becomes a ledger of numbered facts.
2. **Discovery.** Sources run on a schedule: Greenhouse, Lever, and Ashby company boards, Adzuna search, company career pages, and optional LinkedIn/Indeed discovery. Postings are filtered by your target titles before any AI work.
3. **Matching.** Each posting's requirements are extracted and scored against your profile and preferences. The score combines skills, semantic similarity from a local embedding model, experience, and preferences.
4. **Tailoring.** Strong matches get a tailored resume and cover letter. Every bullet must cite the fact IDs it comes from. Deterministic checks strip unconfirmed skills and reject numbers that aren't in the cited facts. A separate AI auditor then labels every claim as entailed, exaggerated, or fabricated.
5. **Review.** You see the original and tailored resume side by side, with flagged claims highlighted and keyword coverage before and after. Flags block approval until you edit the content or explicitly accept them.
6. **Applying.** Approved applications are filled in a real Chrome window on Greenhouse, Lever, and Ashby. Dry run mode, on by default, fills the form and stops before submitting. Unknown screening questions pause for your answer once and are saved for reuse. CAPTCHAs and verification checks always pause for you.
7. **Tracking.** Each application stores the company, position, date, apply URL, the exact PDF files sent with SHA-256 hashes, every answer given, screenshots, the confirmation text, and a timeline. You record outcomes such as interviews and offers. CSV export is available.

## Setup

Requirements: Node 22+, pnpm 9, Google Chrome (recommended), Windows, macOS, or Linux.

```bash
pnpm install
pnpm setup          # creates .env, installs Chromium for PDFs, creates the database
pnpm dev            # web UI on http://localhost:3000 plus the background worker
```

Then open http://localhost:3000 and follow **Get started**.

### AI provider credentials

Set `JH_LLM_PROVIDER` in `.env`. Credentials are read from the environment and never stored in the database.

| Provider | Setting | How to authenticate |
| --- | --- | --- |
| Gemini, Google sign-in | `gemini-oauth` | Set `JH_LLM_TOKEN_CMD` to a command that prints an access token, for example `gcloud auth application-default print-access-token`. Set `JH_GOOGLE_PROJECT` to a project with the Generative Language API enabled. |
| ChatGPT sign-in (experimental) | `chatgpt-oauth` | Set `JH_LLM_TOKEN_FILE` to the auth file written by a ChatGPT CLI login, for example `~/.codex/auth.json`. |
| Gemini API key | `gemini` | `GEMINI_API_KEY` |
| OpenAI API key | `openai` | `OPENAI_API_KEY` |
| Anthropic API key | `anthropic` | `ANTHROPIC_API_KEY` |

Models can be overridden with `JH_MODEL_SMART` and `JH_MODEL_FAST`, or on the Settings page. Use **Test connection** on Settings to verify access.

The ChatGPT sign-in path is untested against the live service. Using subscription sign-ins from third-party apps may be limited or restricted by the provider's terms.

### Optional

- **Adzuna:** a free app ID and key from developer.adzuna.com, set as `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`.
- **LinkedIn and Indeed discovery:** use **Open browser to sign in** on the Sources page once. These sites prohibit automation in their terms, so the adapters only read search results, slowly and with caps, and never apply there.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Migrates the database and starts the web app and worker |
| `pnpm test` | Unit and integration tests. The applier tests use a local mock ATS; no network or AI needed. |
| `pnpm test:golden` | Real-AI tests for extraction fidelity, zero fabrications, and whether the auditor catches injected fabrications. Uses your configured provider. |
| `pnpm typecheck` | Type-checks every package |
| `pnpm seed:demo` | Loads demo data without any AI calls. Use `JH_DATA_DIR=./data-demo` to keep it separate. |
| `pnpm db:generate` | Generates a migration after changing `packages/db/src/schema.ts` |

## Project layout

```
apps/web          Next.js UI and server actions
apps/worker       Background queue: discovery, matching, tailoring, applying; local control API on :3031
packages/shared   Zod schemas, config, application state machine
packages/db       Drizzle schema (SQLite now, Postgres-ready), queue, repositories
packages/llm      Provider-agnostic AI client (Vercel AI SDK) with OAuth bearer support and a usage ledger
packages/core     Profile facts, matching, tailoring, validation, audit, cover letters, pipeline
packages/documents Resume parsing and ATS-safe PDF/DOCX rendering
packages/sources  Job source adapters
packages/browser  Shared persistent Chrome profile
packages/applier  Form extraction, answer planning, filling, submission, evidence
```

See `docs/architecture.md` for design details.

## Guardrails

- Tailoring never changes employers, titles, or dates. These are rendered from your profile, not from AI output.
- Only skills you confirmed can appear. Numbers must exist in the cited facts. Every claim is independently audited.
- AI-drafted answers to required application questions always wait for your approval the first time.
- Optional demographic questions default to "decline to self-identify" unless you save a different answer.
- A daily cap and randomized spacing limit real submissions. Dry run is on by default.
- No CAPTCHA solving. No automated applying on LinkedIn or Indeed.

## Data

All data lives in `JH_DATA_DIR`, `./data` by default. That includes the SQLite database, generated documents, screenshots, embedding model cache, and the browser profile holding your job-site sign-ins. **Settings → Delete all data** removes everything.
