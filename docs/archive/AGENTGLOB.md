# Havaya × AgentGlob — Integration Notes & Feedback

This document captures how [Havaya](./PLAN.md) uses AgentGlob's public chat API today, the integration constraints we worked around, and concrete recommendations for improving the integration experience for any web app embedding an AgentGlob agent. It also pre-stages the code changes Havaya will make when each recommendation lands.

It serves three audiences:
- **The AgentGlob team** — as actionable product feedback
- **Future Havaya contributors** — as a record of our integration thinking
- **Other AgentGlob integrators** — as a worked example of the same patterns

---

## 1. How Havaya uses AgentGlob

### Integration shape
- A **single agent** (`life`) embedded as the primary product surface
- Signed-in users via Clerk — we own the user identity, AgentGlob does not
- Conversation transcripts **mirrored in our own Postgres** (`Conversation` + `Message` tables — see [ARCHITECTURE.md](./ARCHITECTURE.md))
- Cross-domain: app at `app.havaya.me`, AgentGlob at `app.agentglob.com`
- Mobile-first chat UI; treated as a quasi-PWA

### Usage pattern
1. Browser → our `/api/chat` proxy → AgentGlob. No direct browser-to-AgentGlob calls.
2. Deterministic `sessionKey = "app:havaya:<userId>:<conversationId>"` so each user-conversation pair owns its own AgentGlob context.
3. Transcript mirrored in our DB for display, history (`?cid=<id>` deep links), and analytics.
4. **Section CTA hack**: when a user lands on `/chat?ctx=pricing`, we prepend a delimited block to the first message:

```
<<<context>>>
The user came from the Pricing page. They likely want plan/upgrade help.
<<<end_context>>>

User said: ${message}
```

This is the workaround for the absent system-prompt / context field (see §3.3).

---

## 2. What works well

- ✅ **`sessionKey`-based conversation memory** — clean abstraction; integrator owns the namespace
- ✅ **Synchronous JSON response** — easy to reason about, no SDK required to get started
- ✅ **Metadata GET** — lets us render agent emoji/name/description without hard-coding
- ✅ **Models endpoint** — future-proofs a picker
- ✅ **Public endpoints** — no auth setup needed to ship a v1

---

## 3. Constraints we worked around (and the cost)

### 3.1. No CORS headers
Browser cannot POST cross-origin. We **must** run a proxy. For Havaya that's fine — we want server-side rate limits and auth — but it blocks pure no-backend integrations (static sites, simple SPAs).

**Cost**: every integrator implements the same route handler. Small static sites can't integrate at all.

### 3.2. No streaming
Replies take 2–30s. We render a 3-dot typing indicator and surface "Still thinking…" at 15s elapsed. Progressive output would dramatically reduce perceived latency.

**Cost**: poor perceived performance; integrators bolt on artificial UX (typing dots) to fill the void.

### 3.3. No system-prompt / context field on POST
Section preamble has to be jammed into the first user message with a delimiter (see §1). This:
- Pollutes the agent's context with a fake "user said" wrapper
- Cannot be updated mid-conversation
- Is indistinguishable from user input in agent logs

**Cost**: ugly, brittle, leaks impl detail into the conversation state.

### 3.4. No history-fetch
We can't ask "give me the messages for sessionKey X". So we mirror the transcript in our DB — duplicating data the agent already has.

**Cost**: extra DB writes per turn; restore-on-load needs a DB query; AgentGlob and our DB can drift.

### 3.5. No abort endpoint
Once a POST is in flight, there's no way to cancel server-side. Our client closes the fetch at 35s but the agent run continues — wasted compute and confusing UX ("stopped or not?").

**Cost**: honest UX requires saying "we stopped waiting" rather than "we stopped the agent". Wasted compute on abandoned conversations.

### 3.6. No webhook / completion push
Pure request/response. For long agent work, the client must hold the connection open. No async notification when results arrive.

**Cost**: no good UX for "kick off a task, ping me when done" patterns.

### 3.7. No rate limits provided
Each integrator builds their own. Recipe is trivial but everyone repeats it.

**Cost**: duplication; new integrators ship without rate limits and get bitten later.

---

## 4. Recommendations for AgentGlob

Prioritized by impact on integration quality. Each includes a proposed API shape.

### High impact

#### 4.1. Streaming responses via SSE

```http
POST /api/public/chat/<agent>
Accept: text/event-stream
Content-Type: application/json

{ "message": "...", "sessionKey": "..." }
```

Response (text/event-stream):
```
data: { "type": "delta", "text": "Hello! " }
data: { "type": "delta", "text": "How can I..." }
data: { "type": "complete", "messageId": "msg_abc" }
```

Negotiation: if `Accept: text/event-stream` is sent → stream; otherwise current synchronous JSON. Backwards compatible.

**Why it matters**: turns a 15s "loading" into a 1s "Hello! ...". Single biggest UX upgrade.

#### 4.2. CORS support with origin allowlist

Agent settings expose allowed origins. Matching `Origin` headers get the right CORS response.

```
Agent Settings → CORS Origins
  • https://app.havaya.me
  • https://staging.havaya.me
```

Default: empty (current behavior preserved).

**Why**: enables no-backend integrations (static sites, SPAs). Server-side integrators benefit too (no need to handle CORS in their own proxy).

#### 4.3. Context field on POST

```http
POST /api/public/chat/<agent>
{
  "message": "...",
  "sessionKey": "...",
  "context": {
    "origin": "pricing",
    "hint": "User came from pricing page; favor plan comparisons.",
    "scope": "first-message"
  }
}
```

`scope` values: `"first-message"` (current Havaya pattern), `"conversation"` (apply to every subsequent turn), `"single-message"` (this turn only, useful for routing nudges).

**Why**: removes the delimiter hack; keeps context separate from user input in agent state, logs, and analytics; supports use cases beyond first-message preamble.

### Medium impact

#### 4.4. Conversation API

```
POST   /api/public/conversations              → { conversationId, sessionKey }
GET    /api/public/conversations/:id          → { metadata, messageCount, createdAt }
GET    /api/public/conversations/:id/messages → { messages: [{ role, content, ts }] }
DELETE /api/public/conversations/:id          → 204
```

**Why**: stops integrators from reinventing conversation IDs, transcripts, and history loading. Eliminates the AgentGlob ↔ integrator-DB drift problem.

#### 4.5. Abort endpoint

```
DELETE /api/public/runs/:runId
```

`runId` returned in the initial POST response (or as the first SSE event when streaming).

**Why**: real cancellation when users navigate away or hit "stop"; saves compute; supports honest UX.

#### 4.6. Per-agent rate limits

Configurable in agent settings:
- N requests / minute / user (user = explicit `userId` field or hash of `sessionKey`)
- Standard `429 Retry-After` response

**Why**: stops every integrator rebuilding `Map<userId, count>`. Centrally enforced means fairer compute distribution.

### Lower priority (but high value)

#### 4.7. Attachments

```http
POST /api/public/chat/<agent>
{
  "message": "Look at this",
  "sessionKey": "...",
  "attachments": [
    { "type": "image", "url": "https://...", "mimeType": "image/png" }
  ]
}
```

Plus a presigned upload endpoint:
```
POST /api/public/uploads → { uploadUrl, fileUrl, expiresAt }
```

#### 4.8. Webhook on conversation events

Agent settings → webhook URL. POSTs on:
- `conversation.created`
- `message.received`
- `agent.responded`
- `conversation.expired`

Replaces polling; enables async UX (e.g. "run this analysis, ping me when done").

#### 4.9. Structured output

```http
POST /api/public/chat/<agent>
{
  "message": "...",
  "sessionKey": "...",
  "responseSchema": { "type": "object", "properties": { ... } }
}
```

Returns structured JSON instead of (or alongside) free-text reply. For decisions, form generation, routing.

#### 4.10. Official SDK

\`@agentglob/client\` for JavaScript/TypeScript:

```ts
import { AgentGlob } from '@agentglob/client';

const agent = new AgentGlob({ agentName: 'life', sessionKey });
for await (const delta of agent.chat({ message })) {
  console.log(delta.text);
}
```

Handles: auth, retries, streaming negotiation, types, conversation lifecycle, abort.

#### 4.11. Embeddable widget

For sites that just want "an AgentGlob agent in the corner":

```html
<script src="https://app.agentglob.com/widget.js"
        data-agent="life"
        data-theme="dark"></script>
```

Renders a floating chat bubble. Conversation lifecycle, persistence, and UX handled by AgentGlob. Configurable via agent settings.

#### 4.12. Read per-user workspace-file sections (app-key scoped)

**Havaya's current blocker.** The home hub reads named sections from each user's per-user workspace file — `User_D_Prompt` (5 prompts) and `app_note` — scoped by an **app API key + userId**. Read-only.

Full handoff spec: [AGENTGLOB_USER_FILE_API.md](./AGENTGLOB_USER_FILE_API.md).

```
GET /api/public/chat/<agent>/user-file?userId=<appUserId>&section=<name>
Authorization: Bearer <APP_API_KEY>
```

Sections live as HTML-comment-delimited blocks (`<!-- app:User_D_Prompt:start -->…<!-- app:User_D_Prompt:end -->`) inside the per-user file, keyed by the same `userId` as the chat `sessionKey`. **Security:** the app key authorizes that app's users only; per-agent section allowlist (default empty); return only the marked section's bytes; `404` (not `403`) for not-allowlisted / not-found. Havaya consumes this via `getUserSection()` in [`src/lib/agentglob.ts`](./src/lib/agentglob.ts). **✅ Shipped 2026-06-01** — reader endpoint live, `AGENTGLOB_APP_API_KEY` set on both sides, writer (`save_user_section` tool) deployed to the `life` agent. See [AGENTGLOB_INTEGRATION_STATUS.md](./AGENTGLOB_INTEGRATION_STATUS.md).

---

## 5. Recipes for any web app integrating AgentGlob today

These are the patterns Havaya implemented and recommends to other integrators.

### 5.1. Always proxy through your backend
Because of §3.1 (no CORS), browser code can't talk to AgentGlob. Build a thin route handler that:
- Authenticates the caller
- Rate-limits per user
- Validates message length
- Forwards to AgentGlob with the `sessionKey`

Reference implementation: [`src/app/api/chat/route.ts`](./src/app/api/chat/route.ts).

### 5.2. Make `sessionKey` deterministic and namespaced
Format: `<app-prefix>:<userId>:<conversationId>`. Prevents collisions across apps, lets you reconstruct identity from the key, and makes server-side logs greppable.

### 5.3. Mirror the transcript locally
Until §4.4 (Conversation API) lands, store every `user` and `assistant` message in your own DB on the same write path as the AgentGlob call. Without this, you can't render history on page reload.

### 5.4. Mask the latency with a typing indicator and a "still thinking" hint at 15s
Until §4.1 (streaming) lands, 2–30s waits feel broken without affordances. Pattern in [`src/hooks/useChat.ts`](./src/hooks/useChat.ts):
- Optimistic placeholder bubble with animated dots
- 15s: append a one-liner "Still thinking…"
- 35s: abort the client fetch, leave the user message in transcript, offer retry

### 5.5. Section CTA preamble pattern
Until §4.3 (context field) lands, smuggle origin context via a delimited block on the first user message. See [`src/lib/sectionHints.ts`](./src/lib/sectionHints.ts) and the `isFirstMessage` branch in `route.ts`.

### 5.6. Cache the metadata GET
The `GET /api/public/chat/<agent>` response (display name, emoji, description) changes rarely. Cache it 5+ minutes server-side. See [`src/lib/agentglob.ts`](./src/lib/agentglob.ts).

### 5.7. Enforce the message cap on both sides
3000 chars max. Block in the composer (better UX), validate in the route handler (security boundary).

---

## 6. What Havaya rebuilds when each recommendation lands

Internal roadmap tied to AgentGlob's roadmap. Each backlog item in [ROADMAP.md](./ROADMAP.md) that's blocked on AgentGlob references this section.

| AgentGlob delivers | Havaya changes |
|---|---|
| **4.1 Streaming (SSE)** | Rewrite `/api/chat/route.ts` as a streaming proxy; update `useChat.ts` to consume `ReadableStream` deltas; remove typing-indicator-as-loading-state pattern |
| **4.2 CORS** | Keep proxy for auth + rate limits, but ship a lightweight `<AgentGlobEmbed>` component for marketing pages that talks direct |
| **4.3 Context field** | Delete the `<<<context>>>` preamble injection in `route.ts`; pass `context.hint` field directly; expand `SECTION_HINTS` to use `scope: "conversation"` where appropriate |
| **4.4 Conversation API** | Stop mirroring full transcripts on every write — fetch from AgentGlob on `/chat?cid=<id>` load; keep only Conversation metadata (title, sectionContext) in our DB; simplify `/api/chat/history/route.ts` to a thin proxy |
| **4.5 Abort endpoint** | Real cancellation in `useChat.ts`; honest "stopped" UI; abort on route navigation |
| **4.6 Per-agent rate limits** | Delete `src/lib/ratelimit.ts`; surface AgentGlob's `429` + `Retry-After` as a toast in `useChat` |
| **4.7 Attachments** | Composer affordances (paperclip, drag-drop); presigned upload flow; `MessageBubble` rendering for images |
| **4.8 Webhooks** | New API route `/api/agentglob-webhook`; long-running task UX (e.g. "I'll think about this and ping you") |
| **4.9 Structured output** | Type-safe parsed responses; first use case = onboarding form generation |
| **4.10 SDK** | Replace [`src/lib/agentglob.ts`](./src/lib/agentglob.ts) with `@agentglob/client`; drop hand-rolled fetch + timeout logic |
| **4.11 Widget** | On the marketing site, replace `SectionCTA` links with the embed snippet for inline-on-page chat; keep `/chat` route for deep conversations |
| **4.12 User-file sections** | ✅ **Shipped 2026-06-01.** Home hub prompts (`User_D_Prompt`) + per-user note (`app_note`) live via `getUserSection()`. See [AGENTGLOB_INTEGRATION_STATUS.md](./AGENTGLOB_INTEGRATION_STATUS.md). |

---

## 7. Sharing this with AgentGlob

This file is the source of truth. Easiest ways to deliver it:

1. **Link to the file on GitHub** — `https://github.com/cryptolir/app.havaya/blob/main/AGENTGLOB.md`
2. **Open as a GitHub issue** on the AgentGlob repo (if public)
3. **Paste into a doc** for an async review meeting

Updates over time live in git history.
