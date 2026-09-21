# Prowl

A local-first job application system. It reads your resume, finds matching jobs, tailors a truthful ATS-friendly resume and cover letter for each one, applies from your own browser after you approve, and records every application.

Everything runs on your computer. Nothing is submitted until you approve it.

## How it works

1. **Profile.** Upload a resume (PDF, DOCX, TXT) or build one in the editor. The AI copies it into a structured profile. You confirm which skills are real. The confirmed profile becomes a ledger of numbered facts.
2. **Interview.** An AI interviewer reads your confirmed profile and asks short questions about target roles, seniority, location, pay, work authorization, and sponsorship, with tap-to-answer replies. Screening answers and new profile facts are kept only when they quote your own words. One review screen shows everything, and nothing is saved until you apply it. Mentioned skills or accomplishments become proposed profile additions that you confirm one at a time.
3. **Sources.** The source builder suggests employers from your profile and interview, finds boards through web search, and learns boards from jobs already found. Every Greenhouse, Lever, and Ashby board is checked live and shows open and matching job counts. Boards that can't be confirmed as the right company are marked unconfirmed.
4. **Discovery.** Sources run on a schedule: Greenhouse, Lever, and Ashby company boards, Adzuna search, company career pages, and optional LinkedIn/Indeed discovery. Postings are filtered by your target titles before any AI work.
5. **Matching.** Each posting's requirements are extracted and scored against your profile and preferences. The score combines skills, semantic similarity from a local embedding model, experience, and preferences.
6. **Tailoring.** Strong matches get a tailored resume and cover letter. Every bullet must cite the fact IDs it comes from. Deterministic checks strip unconfirmed skills and reject numbers that aren't in the cited facts. A separate AI auditor then labels every claim as entailed, exaggerated, or fabricated.
7. **Review.** You see the original and tailored resume side by side, with flagged claims highlighted and keyword coverage before and after. Flags block approval until you edit the content or explicitly accept them.
8. **Applying.** Approved applications are filled in a real Chrome window on Greenhouse, Lever, and Ashby. Dry run mode, on by default, fills the form and stops before submitting. Unknown screening questions pause for your answer once and are saved for reuse. CAPTCHAs and verification checks always pause for you.
9. **Tracking.** Each application stores the company, position, date, apply URL, the exact PDF files sent with SHA-256 hashes, every answer given, screenshots, the confirmation text, and a timeline. You record outcomes such as interviews and offers. CSV export is available.

## Setup

Requirements: Node 22+, pnpm 9, Google Chrome (recommended), Windows, macOS, or Linux.

```bash
pnpm install
pnpm bootstrap      # creates .env, installs Chromium for PDFs, creates the database
pnpm dev            # web UI on http://localhost:3000 plus the background worker
```

Then open http://localhost:3000 and follow **Get started**.

### AI connections

Open **Settings → AI connections → Add connection**. You can add several and choose which one is in use.

| Connection | How it signs in |
| --- | --- |
| ChatGPT | **Sign in with ChatGPT** on OpenAI's own page, the same sign-in Codex uses. Uses your ChatGPT plan. The sign-in returns to this computer on port 1455. |
| Gemini (Google sign-in) | Google's official Gemini API OAuth. A one-time guide walks you through creating a Desktop OAuth client in your Google Cloud project, then **Sign in with Google**. |
| API key providers | OpenAI, Gemini, Anthropic, OpenRouter, xAI, Mistral, DeepSeek, Groq, and about 200 more from the [models.dev](https://models.dev) catalog. |
| Local and custom | Ollama, LM Studio, or any OpenAI-compatible endpoint. |

After connecting, pick a **main model** and a **fast model**. Each dropdown lists the provider's live models. The **reasoning effort** menu shows only the levels that model supports, such as Low through Extra high. Choices are saved per connection: switching to another connection and back restores them, and each model remembers its last effort.

API keys and sign-in tokens are encrypted on this computer with a key held in the system keychain. The ChatGPT sign-in is subject to OpenAI's terms and counts against your plan's limits.

Legacy `.env` configuration (`PROWL_LLM_PROVIDER` plus credentials) still works when no connection has been added.

### Optional

- **Web search for sources:** ChatGPT and OpenAI API connections use their built-in web search automatically. Otherwise, a self-hosted [Firecrawl](https://github.com/firecrawl/firecrawl) server can be added in **Settings → Web tools**. It also renders careers pages that need JavaScript. Firecrawl search needs a search backend such as SearXNG on that server.
- **Adzuna:** a free app ID and key from developer.adzuna.com, set as `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`.
- **LinkedIn and Indeed discovery:** use **Open browser to sign in** on the Sources page once. These sites prohibit automation in their terms, so the adapters only read search results, slowly and with caps, and never apply there.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Migrates the database and starts the web app and worker |
| `pnpm test` | Unit and integration tests. The applier tests use a local mock ATS; no network or AI needed. |
| `pnpm test:golden` | Real-AI tests (`PROWL_GOLDEN=1`) for extraction fidelity, zero fabrications, and auditor behavior. Uses your configured provider. |
| `pnpm typecheck` | Type-checks every package |
| `pnpm --filter @prowl/<pkg> typecheck` | Type-checks one package |
| `pnpm seed:demo` then `pnpm dev:demo` | Loads demo data into `./data-demo` without any AI calls and runs the app against it, separate from your real data. |
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

Workspace packages are named `@prowl/*`.

See `docs/architecture.md` for design details.

## Guardrails

- Tailoring never changes employers, titles, or dates. These are rendered from your profile, not from AI output.
- Only skills you confirmed can appear. Numbers must exist in the cited facts. Every claim is independently audited.
- AI-drafted answers to required application questions always wait for your approval the first time.
- Optional demographic questions default to "decline to self-identify" unless you save a different answer.
- A daily cap and randomized spacing limit real submissions. Dry run is on by default.
- No CAPTCHA solving. No automated applying on LinkedIn or Indeed.

## Data

All data lives in `PROWL_DATA_DIR`, `./data` by default. That includes the SQLite database (`prowl.sqlite`), generated documents, screenshots, embedding model cache, and the browser profile holding your job-site sign-ins. **Settings → Delete all data** removes everything.

## Migration from Job Hunter

Prowl rebrands the previous **Job Hunter** product. Identifier changes are a **clean break**:

1. Update `.env`: rename every `PROWL_*` variable to `PROWL_*` (see `.env.example`).
2. The data directory still defaults to `./data`, but the database file is now `prowl.sqlite`.
   - To keep existing data: copy/rename `data/prowl.sqlite` (and `-wal`/`-shm` if present) to `data/prowl.sqlite`, or set `PROWL_DB_PATH` to the old file.
3. OS keychain service name is now `prowl`. Previously encrypted secrets may not decrypt under the new master-key entry — re-add AI connections in Settings.
4. Workspace packages are `@prowl/*` (not `@prowl/*`).
5. Second web instance (for example demo data): set `PROWL_NEXT_DIST_DIR`.
6. Golden tests: `PROWL_GOLDEN=1 pnpm test:golden`.
7. The git remote / local folder may still be named `job-hunter` until you rename them; that does not affect runtime identifiers above.
