# Plusim — Architecture

How the app is wired together. For project vision see [PLAN.md](./PLAN.md). For day-to-day backlog see [ROADMAP.md](./ROADMAP.md). For deployment see [DEPLOY.md](./DEPLOY.md).

## What AgentGlob gives us

The chat is powered by AgentGlob's public HTTP API on `https://app.agentglob.com`. Our agent slug is `onlyclaw`.

| Endpoint | Method | What it does |
|---|---|---|
| `/api/public/chat/<agent>` | POST | Send `{message, sessionKey?, model?, appUserId?}`, get back `{reply, message}`. Synchronous JSON. Conversation history is server-side, keyed by `sessionKey`. ~2–30s latency. |
| `/api/public/chat/<agent>` | GET | Agent metadata: `displayName`, `emoji`, `description`, … |
| `/api/public/chat/<agent>/user-file` | GET | Read an allowlisted **per-user file section** (app key + userId). Used for the greeting name (`app_profile`); see [docs/archive/AGENTGLOB_USER_FILE_API.md](./docs/archive/AGENTGLOB_USER_FILE_API.md). |

### Constraints that drove the design

1. **No CORS headers.** Browser cannot POST cross-origin → we proxy through a Next.js route handler (`/api/chat`).
2. **No streaming.** UX accepts multi-second waits with a typing indicator. See `src/lib/plusimRuntime.ts`.
3. **No history-fetch.** AgentGlob remembers conversations via `sessionKey`, but we cannot pull old turns back. We mirror the transcript in our own DB.
4. **No abort endpoint.** Once a POST is in flight it finishes or times out (client-side cap).
5. **No system-prompt field.** Steering is conveyed by prepending a delimited block to the *first* user message (see [Chat preamble](#chat-preamble)).
6. **No rate limits enforced by AgentGlob.** We rate-limit per user in our proxy.
7. **Message cap: 3000 chars.** Enforced client- and server-side (`/api/chat/route.ts`).

## Request flow (chat)

```
[Browser  /  or  /chat]
   |  fetch('/api/chat', { conversationId, message })       ← same origin
   v
[Next.js Route Handler /api/chat]
   |  1. auth → 401 if not logged in
   |  2. rate-limit (per-user)
   |  3. find/create Conversation (owns sessionKey)
   |  4. insert user Message
   |  5. (first message) build the invisible preamble
   |  6. POST to AgentGlob with sessionKey + appUserId
   v
[AgentGlob /api/public/chat/onlyclaw]   ← returns { reply, message }
   |
   v
[Route handler] insert assistant Message, return both rows to browser
```

Boundaries:
- **Browser never talks to AgentGlob directly.** CORS + secret hygiene.
- **`sessionKey` lives server-side only.** Format: `app:plusim:<userId>:<conversationId>` (app-namespaced; conversations created before the namespace change keep their stored 3-part key). Stored on the `Conversation` row. AgentGlob holds the live LLM context; our DB holds the displayable transcript.
- **`AGENTGLOB_AGENT_NAME` is a single env var** (`onlyclaw`). Multi-agent picker is future work.

## Chat preamble

On the **first** message of a conversation, `/api/chat` may prepend an invisible, delimited context block to the outbound message (the user only ever sees their own raw text). Precedence (`src/app/api/chat/route.ts`):

- `sectionContext === "past_meeting"` → the user's latest Drive meeting-summary context (`buildLinkedFolderContext`, `src/lib/pastMeeting.ts`).
- otherwise → the admin-set global **chat guidance** (`chat_preamble` setting) **prepended to** that same linked-folder context. The preamble augments, never replaces it, so a blank `chat_preamble` reproduces prior behavior exactly.

The chat guidance is edited in `/admin/settings` (see [Settings control panel](#settings-control-panel)).

## The home hub

Signed-in `/` (`src/app/page.tsx`, a Server Component) is the product hub. It fetches content server-side, then hands it to the client `HomeHub`:

- **Chat** (`src/components/home/HomeHub.tsx`) — owns one `usePlusimRuntime()` instance and renders assistant-ui's `<Thread>` inside `<AssistantRuntimeProvider>`. Lazy: no conversation is created until the first message is sent.
- **Prompts panel** (`PromptsPanel.tsx`) — clickable prompt chips from the admin-set `home_prompts` setting (`getSetting` → `parsePrompts`). Blank → hidden.
- **Owner note** (`OwnerNote.tsx`) — a slim markdown banner from the admin-set `home_note` setting. Blank → hidden.
- **Recent chats** (`RecentChatsPanel.tsx`) — the user's 5 most recent conversations with an unread dot (`ConversationView`).
- **Greeting name** — from the per-user `app_profile` file section (`getUserSection`), seeded once from the Clerk first name.
- **Bottom nav** (`BottomNav.tsx`) — Community · Home · Report.

Signed-out `/` is a simple landing with sign-in / sign-up.

## Route map

| Route | Method | Source | Purpose |
|---|---|---|---|
| `/` | GET (page) | `src/app/page.tsx` | Signed-out: landing. Signed-in: the **home hub**. |
| `/chat` | GET (page) | `src/app/chat/page.tsx` | Full-screen chat. Reads `?p=<seed>&ctx=<sectionId>&autosend=1&cid=<id>`. |
| `/community` | GET (page) | `src/app/community/page.tsx` | The Plusim Facebook page, embedded. |
| `/report` | GET (page) | `src/app/report/page.tsx` | The signed-in user's published statement reports. |
| `/api/chat` | POST | `src/app/api/chat/route.ts` | Main chat proxy. |
| `/api/chat/new-session`, `/history`, `/agent-info`, `/mark-viewed` | — | `src/app/api/chat/*` | Session creation, DB transcript fetch, agent metadata, view marker. |
| `/admin/**` | — | `src/app/admin/*` | Admin dashboard (Users, Drive, Reports, Settings) + its APIs. Gated by `requireAdmin` / `ADMIN_EMAILS`. |
| `/api/agent/**` | — | `src/app/api/agent/*` | Agent-facing reports routes (manifest / files / result). Middleware-public; guarded by a static runtime bearer + per-job token. See [docs/REPORTS_PIPELINE.md](./docs/REPORTS_PIPELINE.md). |
| `/api/reports/[jobId]/download` | GET | `src/app/api/reports/*` | Client xlsx download (Clerk-gated, ownership-checked). |

## Data model

Defined in `prisma/schema.prisma`. Money is stored as **agorot integers**, never floats.

- **`Conversation`** / **`ConversationView`** / **`Message`** — chat transcripts + per-user last-viewed marker. `sessionKey` (unique) generated on creation via `makeSessionKey()`.
- **`AppSetting`** — a key/value store (`key` PK, `value`). Holds the encrypted Drive OAuth token *and* the plaintext admin settings (`summary_instructions`, `chat_preamble`, `home_prompts`, `home_note`, `report_rules`). Accessed via `src/lib/appSettings.ts`.
- **`UserDriveFolder`** — `userId → folderId`, the client's assigned Drive subfolder.
- **Reports pipeline** — `ReportJob`, `StatementFile` (`driveFileId`+`driveFolderId`, no bytes), `ReportArtifact`, `ReportTransaction`, `MerchantMapping`. See [docs/REPORTS_PIPELINE.md](./docs/REPORTS_PIPELINE.md).

## Settings control panel

`/admin/settings` (`src/app/admin/(dash)/settings/page.tsx`) manages the agent's behavior levers from the app rather than the AgentGlob dashboard. Every field is an `AppSetting` row edited through one generic component + route:

- `src/lib/appSettings.ts` — `getSetting`/`setSetting` + the `SETTING_KEYS` allowlist (the trust boundary).
- `src/app/admin/api/settings/[key]/route.ts` — generic PUT, gated by `authorizeDriveRequest`; a key not on the allowlist is rejected (400).
- `src/components/admin/SettingEditor.tsx` — the reusable textarea editor.

Sections: **chat guidance** (`chat_preamble`), **home prompts** (`home_prompts`), **owner note** (`home_note`), **report categorization rules** (`report_rules`, carried into each job manifest and applied by the skill), **meeting summary method** (`summary_instructions`), a read-only **merchant dictionary**, and a static **agent & skills** note (skill files live on AgentGlob, not editable here).

## Section CTA pattern

Links to `/chat` can seed-and-send (`?p=<message>&autosend=1`) and/or set a context (`?ctx=<sectionId>`). Helper: `src/components/SectionCTA.tsx`. The `ctx` is stored as `Conversation.sectionContext` and drives the first-message preamble (today: the `past_meeting` pin).

## Reports pipeline

Admin upload → `onlyclaw` (the `plusim-reports` skill) → client `/report`. Raw statements live in the client's Google Drive folder (never Postgres); `/api/agent/**` is gated by a static runtime bearer + a per-job token; ingestion is independently re-verified and fails closed. Full design: [docs/REPORTS_PIPELINE.md](./docs/REPORTS_PIPELINE.md). Skill source of truth: `agent/skills/plusim-reports/`.

## Google Drive integration (admin meeting-transcripts)

An admin browses a shared Drive folder, assigns a subfolder per user, and summarizes a transcript with the `onlyclaw` agent (saved back to Drive). A home **"פגישה קודמת"** prompt then resumes chat grounded in the latest summary. Full runbook: [docs/DRIVE_INTEGRATION.md](./docs/DRIVE_INTEGRATION.md).

- **Auth**: OAuth as the **owner** (one-time connect at `/admin/drive`). Refresh token stored AES-256-GCM-encrypted in `AppSetting["drive_oauth"]`.
- **Containment**: every caller-supplied id passes `assertEntryUnderRoot()` (walks `parents` to `PLUSIM_DRIVE_ROOT_FOLDER_ID`) before any read/write. The reports pipeline reuses this and adds tighter per-folder confinement.
- **Summaries** are `text/plain` files tagged with Drive `appProperties` (`havayaSummary=true` — a legacy tag string kept so existing files stay discoverable, `meetingDate`, `meetingTitle`), driving idempotency + "past meeting" detection.
- **Summary method** — `AppSetting.summary_instructions`, edited on `/admin/settings`; `getSummaryInstructions()` returns it or the built-in financial-meeting default.

## Mobile UX rules

- Layout root: `h-[100dvh]` / `min-h-[100dvh]` (use `dvh`, not `vh` — handles iOS URL-bar collapse).
- Bottom nav: `pb-[env(safe-area-inset-bottom)]`. Tap targets `min-h-11` (44px).
- Composer textarea ≥16px so iOS doesn't zoom on focus. Hebrew text uses `dir="auto"`.

## Rate limiting

`src/lib/ratelimit.ts` — in-memory `Map<userId, {count, windowStart}>`, 20 messages/minute/user. Single-instance; resets on deploy. Upgrade path: Upstash Redis (tracked in [ROADMAP.md](./ROADMAP.md)).

The code is the source of truth — this doc is the map.
