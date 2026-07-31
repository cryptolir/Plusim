# Plusim — Roadmap

A running list of features by status. Each entry is a title only — details / specs live in PRs, [ARCHITECTURE.md](./ARCHITECTURE.md), or linked design files.

Plusim is a financial-guidance app powered by AgentGlob (agent slug: `onlyclaw`), live at [plusim.xyz](https://plusim.xyz). It was seeded from the Havaya codebase; Havaya-era planning docs live in [docs/archive/](./docs/archive/).

## Shipped

- Next.js 16 + TypeScript + Tailwind 4 scaffold
- Clerk auth (proxy/middleware, ClerkProvider, sign-in/sign-up on home)
- Prisma + Postgres schema (Conversation + Message; reports pipeline models; `AppSetting`; `UserDriveFolder`)
- AgentGlob proxy route handler (`/api/chat`) with the `onlyclaw` agent
- Chat UI on [assistant-ui](https://github.com/assistant-ui/assistant-ui) (Radix primitives, shadcn-themed components owned in-repo)
- Custom runtime adapter `src/lib/plusimRuntime.ts` bridging assistant-ui to the `/api/chat` proxy
- Section CTA pattern (URL params: `p`, `ctx`, `autosend`, `cid`)
- In-memory rate limiting (20 msg/min/user)
- Conversation history loading (`/chat?cid=<id>`) + recent-chats panel
- Mobile-first layout (dvh, safe-area, iOS zoom fix, 44px tap targets), RTL/Hebrew-first
- **Home hub** (signed-in `/`) — embedded chat + clickable prompts panel + owner-note slot + recent chats + bottom nav
- **Bottom navigation** — Community · Home · Report
- **Community tab** — the Plusim Facebook page embedded via the Page Plugin
- Voice input (dictation / STT) — browser Web Speech API via assistant-ui's `WebSpeechDictationAdapter`
- Coolify deployment pipeline (auto-deploy on push to `main`) + `./deploy.sh`
- **Google Drive meeting-transcripts admin** — browse a shared Drive folder, assign a subfolder per user, summarize a transcript with the agent (saved back to Drive), view/edit/delete transcripts, and a home **"פגישה קודמת"** prompt that resumes chat grounded in the latest summary. OAuth-as-owner, encrypted refresh token in `AppSetting`, `UserDriveFolder` model, admin pages under `/admin/drive`. See [docs/DRIVE_INTEGRATION.md](./docs/DRIVE_INTEGRATION.md).
- **Statement-categorization pipeline** — admin uploads Israeli card statements (Isracard/Leumi xlsx, MAX pdf) at `/admin/reports`; the `onlyclaw` agent (per-agent `plusim-reports` skill) parses/dedups/categorizes into the household budget taxonomy and builds a month-sheet xlsx verified to the agora; the target user sees the report at `/report` (RTL tables + xlsx download + Google Sheet). Raw statements live in the client's Drive folder; public `/api/agent/*` routes are gated by a static runtime bearer + per-job token; ingestion fails closed. See [docs/REPORTS_PIPELINE.md](./docs/REPORTS_PIPELINE.md) and [agent/skills/plusim-reports/](./agent/skills/plusim-reports/).
- **Admin settings control panel** (`/admin/settings`) — **live 2026-07 ✅** manage the agent's behavior levers from the app instead of the AgentGlob dashboard: chat guidance (first-message preamble), home prompts + owner note (DB-backed, replacing the old per-user-file source), report categorization rules (carried into each job manifest and applied by the skill's judgment step), the meeting-summary method, and a read-only merchant-dictionary view. The `report_rules` consumer (`run_job.py` + `SKILL.md`) is synced into onlyclaw's workspace. See [docs/plans/settings-control-panel.md](./docs/plans/settings-control-panel.md).
- **Admin panel in Hebrew (RTL)** — **live 2026-07 ✅** the `/admin` section (cloned from Havaya in English) translated to Hebrew in place; wrapper flipped to `dir="rtl"`, status-enum keys kept English for logic.
- **Hebrew user guides** — **2026-07 ✅** operational guides for clients and admins in [docs/guides/](./docs/guides/), versioned with the code; `AGENTS.md` rule 4 requires updating them in the same PR as any user-facing change.
- **Every notification in Hebrew** — **2026-07 ✅** the admin UI prints server messages verbatim (`data.error`, `job.error`, verification `problems`), so English server strings surfaced as English notifications. Translated at the source across `/admin/api/**`, the shared auth/upload helpers, the verification diagnostics and the client report download; `src/app/admin/api/hebrewErrors.test.ts` fails on any new `error:`/`exportNote` literal without a Hebrew character. Machine surfaces (`/api/agent/**`) stay English by design.
- **Online report + reports-table fixes** — **2026-07 ✅** admin-only interactive report at `/admin/reports/<id>/view`, one tab per workbook sheet (ניתוח תוצאות · התפלגות ההוצאות · פירוט תנועות · ללא סיווג); every total opens a side panel with the transactions behind it, copyable as TSV. Numbers are recomputed from the stored transactions in `src/lib/reportAnalysis.ts` and were verified against a real published workbook (455 category×month cells, 0 mismatches). The reports table got its RTL header alignment fixed, he-IL dates, truncation, a **דוח מקוון** column and an inline publish shortcut.

## In progress

- _Nothing actively in development._

## Backlog

- Streaming responses — depends on AgentGlob exposing SSE on the public route *(external)*
- Message attachments — depends on presigned upload infra + AgentGlob attachment support *(partially external)*
- Multi-agent picker — `agentName` column already on `Conversation`; needs config UI *(internal)*
- Conversation history sidebar — straight build on the existing `Conversation` table
- Persistent rate limiting (Upstash Redis) — external setup
- PWA install — manifest exists; needs icons + service worker
- Voice output (TTS / agent speaks replies) — assistant-ui ships `WebSpeechSynthesisAdapter`; UX decision needed
- Conversation export — render transcript as markdown / JSON download
- Server-side context reset (fresh `sessionKey`) when the agent session expires
