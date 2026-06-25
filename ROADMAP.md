# Havaya — Roadmap

A running list of features by status. Each entry is a title only — details / specs live in PRs, [ARCHITECTURE.md](./ARCHITECTURE.md), or linked design files.

## Shipped

- Initial Next.js 16 + TypeScript + Tailwind 4 scaffold
- Clerk auth (proxy/middleware, ClerkProvider, sign-in/sign-up controls on home)
- Prisma 5.22 + Postgres schema (Conversation + Message)
- AgentGlob proxy route handler (`/api/chat`) with `life` agent
- Chat UI on [assistant-ui](https://github.com/assistant-ui/assistant-ui) (Radix primitives, shadcn-themed components owned in-repo)
- Custom runtime adapter `src/lib/havayaRuntime.ts` bridging assistant-ui to our /api/chat proxy (no backend changes)
- Section CTA pattern (URL params: `p`, `ctx`, `autosend`, `cid`)
- Section hints (first-message preamble injection per origin)
- In-memory rate limiting (20 msg/min/user)
- Conversation history loading (`/chat?cid=<id>`)
- Mobile-first layout (dvh, safe-area, iOS zoom fix, 44px tap targets)
- Home page with auth-aware controls
- Coolify deployment pipeline (auto-deploy on push to `main`)
- `./deploy.sh` — one-command commit + push + auto-deploy
- Core docs: PLAN, ROADMAP, ARCHITECTURE, DEPLOY, AGENTS, README, .env.example
- Voice input (dictation / STT) — browser Web Speech API via assistant-ui's `WebSpeechDictationAdapter`
- TLS / Let's Encrypt certificate for `app.havaya.me` (Coolify / Traefik)
- **Home hub** (signed-in `/`) — embedded chat + clickable prompts panel + latest videos + owner-note slot + bottom nav
- **YouTube latest-videos section** — public channel RSS (no API key), `@talcrolltraining`, click-to-load lite embed (`src/lib/youtube.ts`)
- **Bottom navigation** (journey · home · community) + `/journey` and `/community` stub pages
- **AgentGlob per-user-section consumer** (`getUserSection` in `src/lib/agentglob.ts`) — shipped ✅
- **Prompts panel + per-user note content** — live as of 2026-06-01 ✅ (`User_D_Prompt` → clickable home-hub prompts; `app_note` → owner note). Powered by the `save_user_section` agent tool on the `life` agent + `GET /api/public/chat/life/user-file` reader on the AgentGlob dashboard. App key set in Coolify; provisioning is lazy (content appears after the first conversation per user).

- **Google Drive meeting-transcripts admin** — **live as of 2026-06 ✅** browse the shared Drive folder, assign a subfolder per user, summarize a transcript with the `life` agent (saved back to Drive), view/edit raw transcripts, delete (trash) files, and a home **"Past meeting"** prompt that resumes chat grounded in the latest summary. OAuth-as-owner (`src/lib/googleDrive.ts`), `AppSetting` (encrypted refresh token) + `UserDriveFolder` models, admin pages under `/admin/drive`. The **summary method is admin-editable** (`/admin/settings` + a field below the browser on `/admin/drive`, stored in `AppSetting.summary_instructions`; default = the TAL method). See [docs/DRIVE_INTEGRATION.md](./docs/DRIVE_INTEGRATION.md).

## In progress

- _Nothing actively in development._

## Backlog

- **Interface-scoped agent instructions** (app vs Telegram `AGENTS.md`) — see [docs/AGENTS_INTERFACE_SPLIT_PLAN.md](./docs/AGENTS_INTERFACE_SPLIT_PLAN.md) *(agent-side / openclaw, not app code)*
- Streaming responses
- Message attachments
- Multi-agent picker
- Conversation history sidebar
- Persistent rate limiting (Upstash Redis)
- Marketing / landing pages
- Community page content
- Journey page content
- PWA install
- Dark mode polish
- Hebrew / RTL polish (the `life` agent replies in Hebrew)
- Voice output (TTS / agent speaks replies) — on-demand per-message replay + global toggle in header
- Server-side context reset (when AgentGlob `sessionKey` expires)
- Conversation export

## Feature dependencies

Each backlog / in-progress item's blockers / prereqs:

- **Prompts panel + per-user note content** — ✅ shipped 2026-06-01 (see [AGENTGLOB_INTEGRATION_STATUS.md](./AGENTGLOB_INTEGRATION_STATUS.md))
- **Community / Journey pages** — depends on: product + design direction for each page *(internal)*
- **Streaming responses** — depends on: AgentGlob exposing SSE on the public route *(external)*
- **Message attachments** — depends on: presigned upload infrastructure, MIME validation, AgentGlob attachment support *(partially external)*
- **Multi-agent picker** — depends on: agent registry / metadata API *(internal)*, `agentName` column on `Conversation` *(already in schema)*, config UI *(internal)*
- **Conversation history sidebar** — depends on: nothing *(straight build on the existing `Conversation` table)*
- **Interface-scoped agent instructions** — depends on: an `agent:bootstrap` hook in `openclaw` (versioned) + edits to the `life` agent workspace on the agent host *(external — openclaw/agent side, not app code)*. Full explanation + plan: [docs/AGENTS_INTERFACE_SPLIT_PLAN.md](./docs/AGENTS_INTERFACE_SPLIT_PLAN.md).
- **Persistent rate limiting** — depends on: Upstash Redis account + env vars *(external setup)*
- **Marketing pages** — depends on: copy, design direction, real `SECTION_HINTS` per page *(internal)*
- **PWA install** — depends on: manifest, icons, service worker *(internal)*
- **Hebrew RTL polish** — depends on: language detection per message, `dir="rtl"` toggling in the thread container *(internal)*
- **Voice output (TTS)** — depends on: nothing *(browser Web Speech API; assistant-ui ships `WebSpeechSynthesisAdapter`; UX decision needed for the toggle + per-message replay button)*
- **Server-side context reset** — depends on: AgentGlob exposing session-expiry signal, OR a UI "reset agent memory" button calling a fresh `sessionKey` *(workaround possible)*
- **Conversation export** — depends on: nothing *(straight build — render transcript as markdown or JSON download)*
