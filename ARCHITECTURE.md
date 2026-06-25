# Havaya — Architecture

How the app is wired together. For project vision see [PLAN.md](./PLAN.md). For day-to-day backlog see [ROADMAP.md](./ROADMAP.md). For deployment see [DEPLOY.md](./DEPLOY.md).

## What AgentGlob gives us

The chat is powered by AgentGlob's public HTTP API on `https://app.agentglob.com`. Our agent slug is `life`.

| Endpoint | Method | What it does |
|---|---|---|
| `/api/public/chat/<agent>` | POST | Send `{message, sessionKey?, model?}`, get back `{reply, message}`. Synchronous JSON. Conversation history is server-side, keyed by `sessionKey`. ~2–30s latency. |
| `/api/public/chat/<agent>` | GET | Agent metadata: `displayName`, `emoji`, `description`, plus newer fields (`status`, `landingPage`, …). |
| `/api/public/chat/<agent>/user-file` | GET | **Proposed (not yet live).** Read an allowlisted **per-user file section** (app key + userId). Consumed by `getUserSection()`; see [AGENTGLOB_USER_FILE_API.md](./AGENTGLOB_USER_FILE_API.md). |

### Constraints that drove the design

1. **No CORS headers.** Browser cannot POST cross-origin → we proxy through a Next.js route handler.
2. **No streaming.** UX accepts multi-second waits with a typing indicator. See `src/lib/havayaRuntime.ts`.
3. **No history-fetch.** AgentGlob remembers conversations via `sessionKey`, but we cannot pull old turns back from them. We mirror the transcript in our own DB.
4. **No abort endpoint.** Once a POST is in flight it finishes or times out (35s client-side cap).
5. **No system-prompt field.** Section preamble is conveyed by prepending a delimited block to the *first* user message sent to AgentGlob.
6. **No rate limits enforced by AgentGlob.** We rate-limit per user in our proxy.
7. **Message cap: 3000 chars.** Enforced both client-side (assistant-ui composer) and server-side (`/api/chat/route.ts`).
8. **No per-user file API yet.** The home hub's prompts + per-user note are built against a proposed endpoint (§4.12 / AGENTGLOB_USER_FILE_API.md); until it ships `getUserSection()` returns null and those sections render empty.

## Request flow

```
[Browser  /  or  /chat]
   |  fetch('/api/chat', { conversationId, message })       ← same origin
   v
[Next.js Route Handler /api/chat]
   |  1. auth → 401 if not logged in
   |  2. rate-limit (per-user)
   |  3. find/create Conversation (owns sessionKey)
   |  4. insert user Message
   |  5. POST to AgentGlob with sessionKey
   v
[AgentGlob /api/public/chat/life]   ← returns { reply, message }
   |
   v
[Route handler] insert assistant Message, return both rows to browser
```

Boundaries:
- **Browser never talks to AgentGlob directly.** CORS + secret hygiene.
- **`sessionKey` lives server-side only.** Format: `app:havaya:<userId>:<conversationId>` (app-namespaced; conversations created before the namespace change keep their stored 3-part key). Stored on the `Conversation` row. AgentGlob holds the live LLM context; our DB holds the displayable transcript.
- **`AGENTGLOB_AGENT_NAME` is a single env var.** Multi-agent picker is future work — tracked in [ROADMAP.md](./ROADMAP.md).

## The home hub

Signed-in `/` (`src/app/page.tsx`, a Server Component) is the product hub. It fetches content server-side, then hands it to the client `HomeHub`:

- **Chat** (`src/components/home/HomeHub.tsx`) — owns one `useHavayaRuntime()` instance and renders assistant-ui's `<Thread>` inside `<AssistantRuntimeProvider>`. Lazy: no conversation is created until the first message is sent.
- **Prompts panel** (`PromptsPanel.tsx`) — to the left of the chat (a chip row on mobile). Clicking a prompt calls the runtime's `sendMessage` so it goes straight into the chat. Prompts come from the `User_D_Prompt` section of the user's per-user file via `getUserSection()` → `parsePrompts()`; renders nothing until that exists.
- **Latest videos** (`VideosSection.tsx`) — the channel's newest videos from `getLatestVideos()` (`src/lib/youtube.ts`, public RSS, no API key). Click loads a `youtube-nocookie` embed.
- **Per-user note** (`OwnerNote.tsx`) — a slim banner rendering the `app_note` section of the user's per-user file (markdown); hidden until it exists.
- **Bottom nav** (`BottomNav.tsx`) — fixed: journey (left) · home (center) · community (right).

Signed-out `/` is a simple landing with sign-in / sign-up.

## Route map

| Route | Method | Source | Purpose |
|---|---|---|---|
| `/` | GET (page) | `src/app/page.tsx` | Signed-out: landing. Signed-in: the **home hub** (chat + prompts + videos + owner-note + bottom nav). Fetches videos (RSS) and agent-workspace files server-side. |
| `/chat` | GET (page) | `src/app/chat/page.tsx` | Full-screen chat. Reads URL params `?p=<seed>&ctx=<sectionId>&autosend=1&cid=<id>`. |
| `/journey`, `/community` | GET (page) | `src/app/journey/page.tsx`, `src/app/community/page.tsx` | Bottom-nav stub pages ("coming soon"). |
| `/api/chat` | POST | `src/app/api/chat/route.ts` | Main proxy: `{conversationId?, message, sectionContext?}` → `{conversationId, userMessage, assistantMessage}`. |
| `/api/chat/new-session` | POST | `src/app/api/chat/new-session/route.ts` | `{sectionContext?}` → `{conversationId, agentInfo}`. Creates a Conversation, returns metadata. |
| `/api/chat/history` | GET | `src/app/api/chat/history/route.ts` | `?conversationId=<id>` → `{messages[]}` from our DB. |
| `/api/chat/agent-info` | GET | `src/app/api/chat/agent-info/route.ts` | Proxies AgentGlob's GET metadata. Cached 5 min. |

## Data model

Defined in `prisma/schema.prisma`. Two entities:

**`Conversation`** — `id`, `userId`, `sessionKey` (unique), `agentName`, `sectionContext?`, `title?`, `createdAt`, `updatedAt`. Indexed on `(userId, updatedAt DESC)` for the future history sidebar.

**`Message`** — `id`, `conversationId`, `role` (`"user"` | `"assistant"`), `content`, `agentglobMessageId?`, `createdAt`. Indexed on `(conversationId, createdAt ASC)`. Note: AgentGlob no longer returns a message id, so `agentglobMessageId` is usually null.

`sessionKey` is generated on conversation creation as `app:havaya:<userId>:<conversationId>` (via `makeSessionKey()` in `src/lib/agentglob.ts`) and reused on every subsequent POST so AgentGlob remembers the conversation. Never exposed to the client.

## Section CTA pattern

Links from anywhere in the app to `/chat` can do two things:

1. **Seed-and-send** — `/chat?p=<message>&autosend=1` opens the chat with the message already submitted
2. **Context preamble** — `/chat?ctx=<sectionId>` opens fresh, but the agent is hinted about which section the user came from

Both can combine. The helper is `src/components/SectionCTA.tsx`:

```tsx
<SectionCTA seed="Help me reflect" ctx="onboarding" autosend>
  Try talking it out
</SectionCTA>
```

**Preamble injection** is server-side and first-message-only. On the first user message of a conversation with a `sectionContext`, the route handler (`src/app/api/chat/route.ts`) prepends a delimited block from `SECTION_HINTS` (`src/lib/sectionHints.ts`) to the outbound message to AgentGlob. The user only ever sees their own raw text in the transcript. The hint is not persisted.

## Predefined prompts

Two sources:
- `SUGGESTED_PROMPTS` in `src/config/prompts.ts` — static suggestions available to the chat UI.
- The home hub's prompts panel pulls from the `User_D_Prompt` section of the user's per-user file (via `getUserSection()` + `parsePrompts()` in `src/lib/agentContent.ts`) so the agent controls them per-user without a redeploy — pending the §4.12 / AGENTGLOB_USER_FILE_API.md endpoint.

## Mobile UX rules

Applied in the relevant components:

- Layout root: `flex flex-col h-[100dvh]` / `min-h-[100dvh]` (use `dvh`, not `vh` — handles iOS URL bar collapse)
- Bottom nav: fixed, `pb-[env(safe-area-inset-bottom)]` for the home indicator
- Tap targets: `min-h-11 min-w-11` (44px, Apple HIG)
- Composer textarea (assistant-ui): ≥16px so iOS doesn't zoom on focus
- Content with Hebrew text uses `dir="auto"` so RTL renders correctly

## Loading UX (no streaming)

In `src/lib/havayaRuntime.ts`:

1. On send: optimistically push the user message; `isRunning` drives the composer/typing state
2. assistant-ui renders the in-progress affordance while `isRunning`
3. At 35s: client `AbortSignal` triggers — surface a "we stopped waiting" message, keep the user message in the transcript
4. There is no real server-side abort — closing the client fetch does not stop AgentGlob's run. The UI says "we stopped waiting" rather than implying cancellation.

## Rate limiting

`src/lib/ratelimit.ts` — in-memory `Map<userId, { count, windowStart }>`, 20 messages / minute / user. Good enough for single-instance dev. Resets on deploy.

Upgrade path: `@upstash/ratelimit` + `@upstash/redis` sliding window. Tracked in [ROADMAP.md](./ROADMAP.md).

## File structure

```
prisma/schema.prisma               — DB schema (Conversation, Message)
prisma/migrations/                 — generated migration SQL

src/proxy.ts                       — Clerk middleware (Next.js 16 "proxy" convention)
src/app/layout.tsx                 — root layout with ClerkProvider
src/app/page.tsx                   — signed-in home hub; signed-out landing
src/app/chat/page.tsx              — full-screen chat entry
src/app/journey/page.tsx           — bottom-nav stub
src/app/community/page.tsx         — bottom-nav stub

src/app/api/chat/route.ts          — main proxy (auth, rate-limit, AgentGlob call, DB writes)
src/app/api/chat/new-session/      — creates conversations
src/app/api/chat/history/          — DB-backed transcript fetch
src/app/api/chat/agent-info/       — AgentGlob metadata proxy

src/lib/agentglob.ts               — AgentGlob HTTP client (callAgent, getAgentInfo, getUserSection)
src/lib/havayaRuntime.ts           — assistant-ui ↔ /api/chat runtime adapter (useHavayaRuntime)
src/lib/youtube.ts                 — latest videos via channel RSS
src/lib/agentContent.ts            — parse the User_D_Prompt section → prompts
src/lib/auth.ts                    — getCurrentUser() helper
src/lib/db.ts                      — Prisma singleton
src/lib/ratelimit.ts               — in-memory rate limiter
src/lib/sectionHints.ts            — SECTION_HINTS map
src/lib/utils.ts                   — cn() and helpers
src/config/prompts.ts              — SUGGESTED_PROMPTS

src/components/home/*               — HomeHub, PromptsPanel, VideosSection, OwnerNote, BottomNav
src/components/assistant-ui/*       — assistant-ui themed components (Thread, composer, markdown, etc.)
src/components/ui/*                 — shared shadcn-style primitives (button, dialog, tooltip, …)
src/components/SectionCTA.tsx       — link helper for the /chat URL contract
```

## Google Drive integration (admin meeting-transcripts)

Lets an admin browse a shared Drive folder, assign a subfolder per user, summarize a transcript with the `life` agent, and save the summary back to Drive. A home **"Past meeting"** prompt then resumes chat grounded in the latest summary. Full setup runbook: [docs/DRIVE_INTEGRATION.md](./docs/DRIVE_INTEGRATION.md).

- **Auth model**: OAuth 2.0 as the **owner** (one-time admin connect at `/admin/drive`). Full `drive` scope (browse a pre-existing folder + write into it). The refresh token is stored **AES-256-GCM-encrypted** in `AppSetting["drive_oauth"]`; access tokens are auto-refreshed and cached in-process.
- **Containment**: the owner token can reach the owner's whole Drive, so every caller-supplied id passes `assertEntryUnderRoot()` (walks `parents` to `HAVAYA_DRIVE_ROOT_FOLDER_ID`) before any read/write.
- **Summaries** are written as `text/plain` files tagged with Drive `appProperties` (`havayaSummary=true`, `meetingDate`, `meetingTitle`, `sourceFileId`) — survives rename, queryable, and drives idempotency + the "Past meeting" detection.
- **Summarize path**: `POST /admin/api/drive/summarize` reads the transcript, size-guards it (~24k chars), and calls `callAgent()` with a fresh `app:havaya:admin-summary:<uuid>` session (no `appUserId`) so it runs in isolation. The prompt embeds the **summary method** as a `=== METHOD ===` block and **forbids agent tools/memory** (else graphiti `add_memory` times out → `(no reply)`).
- **Summary method (admin-editable)**: stored in `AppSetting.summary_instructions`, editable in two places against the same setting — `/admin/settings` and a "Summary method (skill)" field below the browser on `/admin/drive`. `getSummaryInstructions()` returns it or the built-in **TAL method** default. It's an embedded copy (not read live from the agent's `skills/`, which the per-user-workspace sandbox blocks).
- **"Past meeting"**: `src/app/page.tsx` shows the pinned card when the user's assigned folder has summaries; clicking sends a friendly Hebrew message with `sectionContext="past_meeting"`. `/api/chat` then injects the latest summary as the invisible first-turn preamble via `buildPastMeetingHint()` (dynamic, unlike the static `SECTION_HINTS`).

```
DB models       AppSetting (encrypted Drive token, kv), UserDriveFolder (userId → folderId)
src/lib/googleDrive.ts     OAuth client, token store, Drive REST (list/get/create/listSummaries), assertEntryUnderRoot
src/lib/driveCrypto.ts     AES-256-GCM for the refresh token (DRIVE_TOKEN_ENCRYPTION_KEY)
src/lib/driveOAuthState.ts mint/verify the OAuth `state` token (DRIVE_OAUTH_STATE_SECRET)
src/lib/driveAuth.ts       authorizeDriveRequest() — drive save-token or admin Clerk session
src/lib/pastMeeting.ts     buildPastMeetingHint() — latest summary → hidden preamble
src/lib/summaryInstructions.ts   summary-method store (AppSetting.summary_instructions) + TAL default
src/app/admin/(dash)/drive/page.tsx          Drive browser (connect state + breadcrumbs) + summary-method editor
src/app/admin/(dash)/settings/page.tsx       summary-method editor (same setting as the Drive-page field)
src/app/admin/(dash)/drive/connect/route.ts  OAuth start (Clerk-gated) → Google consent
src/app/admin/api/drive/callback/route.ts    OAuth callback (state-verified, middleware-public)
src/app/admin/api/drive/file-text|summarize  view text / summarize
src/app/admin/api/settings/summary-instructions/route.ts  PUT save the summary method (drive-scoped token)
src/app/admin/(dash)/users/[userId]/drive/   per-user folder picker + PUT/DELETE route
src/components/admin/DriveBrowser.tsx, DriveFolderPicker.tsx, SummaryInstructionsEditor.tsx
```

The code is the source of truth — this doc is the map.
