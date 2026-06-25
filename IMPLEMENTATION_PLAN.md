<!--
  Havaya — cumulative implementation plan (working doc).
  Shared for external review (e.g. Codex). Newest work is last.
-->

> **Havaya — cumulative implementation plan.** Built across the project, **newest work last**. Sections marked done are shipped to `https://app.havaya.me`.
>
> **Current focus: Addendum 4** (home hub + per-user agent-file sections). Phase 1 (embedded chat, prompts panel, YouTube auto-latest, owner-note slot, bottom nav, `/journey` + `/community` stubs) is **shipped**; Phase 2 (prompts + per-user note content) is **blocked on a new AgentGlob API** — full spec in [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md). **Addendum 5** maps the agent↔app integration boundary; AgentGlob-side implementation guidance is in [`AGENTGLOB_PERUSER_GUIDANCE.md`](./AGENTGLOB_PERUSER_GUIDANCE.md).
>
> Companion docs: project vision [`PLAN.md`](./PLAN.md) · architecture [`ARCHITECTURE.md`](./ARCHITECTURE.md) · roadmap [`ROADMAP.md`](./ROADMAP.md) · integration notes [`AGENTGLOB.md`](./AGENTGLOB.md) · agent-side API spec [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md) · per-user persistence guidance [`AGENTGLOB_PERUSER_GUIDANCE.md`](./AGENTGLOB_PERUSER_GUIDANCE.md). Reviewers: the most useful sections to critique are **Addendum 4** (home hub), **Addendum 5** (agent↔app integration boundary), and the AgentGlob per-user-file API spec + guidance.

---

# Havaya App — Initial Build Plan

## Context
Building the Havaya app from scratch: a Next.js 14 web app with an AgentGlob-powered chat experience. All work runs on the dev server (`root@204.168.223.245` via `~/.ssh/hetzner-openclaw`). The repo is already cloned at `/root/projects/Havaya_App/`. The existing plan doc at `/Users/liranperetz/.claude/plans/i-m-building-a-web-drifting-pumpkin.md` defines the architecture in detail — this plan operationalizes it.

**Decisions:**
- Agent slug: `life`
- Stack: Next.js 14 App Router + TypeScript + Tailwind CSS
- Auth: Clerk
- DB: Neon (Postgres) + Prisma
- Rate limiting: in-memory v1 (no Upstash yet)
- Dev env: everything via SSH on 204.168.223.245

---

## Prerequisites (user must supply before execution)

These values are needed as `.env.local` entries — collect them before writing any code:

| Var | Where to get it |
|---|---|
| `AGENTGLOB_AGENT_NAME` | Already known: `life` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API Keys |
| `CLERK_SECRET_KEY` | Clerk dashboard → API Keys |
| `DATABASE_URL` | Neon dashboard → Connection string (pooled) |
| `DIRECT_URL` | Neon dashboard → Connection string (direct, for migrations) |

Smoke-test the agent before writing any app code:
```bash
curl -sS -X POST 'https://app.agentglob.com/api/public/chat/life' \
  -H 'content-type: application/json' \
  --data '{"message":"hello","sessionKey":"build-smoke-1"}'
```
Expect HTTP 200 with a `reply` field.

---

## Phase 1 — Scaffold the Next.js app

On the dev server inside `/root/projects/Havaya_App/`:

```bash
pnpm create next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --yes
```

This overwrites the bare repo dir with a full Next.js scaffold. Git preserves the history; README/ROADMAP can be re-committed.

Then install additional dependencies:
```bash
pnpm add @clerk/nextjs @prisma/client react-markdown
pnpm add -D prisma
```

---

## Phase 2 — Prisma schema + Neon DB

Create `prisma/schema.prisma`:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Conversation {
  id             String    @id @default(cuid())
  userId         String
  sessionKey     String    @unique
  agentName      String
  sectionContext String?
  title          String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  messages       Message[]

  @@index([userId, updatedAt(sort: Desc)])
}

model Message {
  id                 String       @id @default(cuid())
  conversationId     String
  role               String       // "user" | "assistant"
  content            String
  agentglobMessageId String?
  createdAt          DateTime     @default(now())
  conversation       Conversation @relation(fields: [conversationId], references: [id])

  @@index([conversationId, createdAt(sort: Asc)])
}
```

Run:
```bash
pnpm prisma migrate dev --name init
pnpm prisma generate
```

---

## Phase 3 — Clerk auth setup

`src/middleware.ts`:
```ts
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
const isPublic = createRouteMatcher(["/", "/api/chat/agent-info"]);
export default clerkMiddleware((auth, req) => {
  if (!isPublic(req)) auth().protect();
});
export const config = { matcher: ["/((?!_next|.*\\..*).*)"] };
```

`src/app/layout.tsx` — wrap `<html>` with `<ClerkProvider>`.

`src/lib/auth.ts`:
```ts
import { auth } from "@clerk/nextjs/server";
export async function getCurrentUser() {
  const { userId } = auth();
  return userId ?? null;
}
```

---

## Phase 4 — Core library files

**`src/lib/agentglob.ts`** — server-only wrapper (matches plan doc verbatim):
- `callAgent({ sessionKey, message, model? })` → `{ reply, messageId? }`
- `getAgentInfo()` → cached agent metadata

**`src/lib/ratelimit.ts`** — in-memory v1:
- `Map<userId, { count, windowStart }>`, 20 msgs/min/user
- Returns `{ ok: boolean, retryAfter?: number }`

**`src/lib/sectionHints.ts`** — `SECTION_HINTS` record (start with a placeholder, add real ones per CTA)

**`src/config/prompts.ts`** — `SUGGESTED_PROMPTS` array (start with 3 generic prompts, refine with user later)

**`src/lib/db.ts`** — singleton Prisma client:
```ts
import { PrismaClient } from "@prisma/client";
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
export const db = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
```

---

## Phase 5 — API routes

Build in dependency order:

1. **`/api/chat/agent-info/route.ts`** — GET, proxies `getAgentInfo()`, no auth required
2. **`/api/chat/new-session/route.ts`** — POST `{sectionContext?}` → creates `Conversation`, returns `{conversationId, agentInfo}`
3. **`/api/chat/history/route.ts`** — GET `?conversationId=` → returns `Message[]` for user's conversation (auth-gated, ownership check)
4. **`/api/chat/route.ts`** — POST proxy (the main handler):
   - auth → 401
   - rate-limit → 429
   - validate message length ≤ 3000 → 400
   - find/create Conversation
   - insert user Message
   - build outbound (prepend hint on first turn if sectionContext)
   - `callAgent()`
   - insert assistant Message
   - return `{conversationId, userMessage, assistantMessage}`

---

## Phase 6 — Chat components

Build in this order (each depends on the previous):

1. `src/components/chat/TypingIndicator.tsx` — animated 3-dot
2. `src/components/chat/MessageBubble.tsx` — role-styled bubble, `react-markdown` for assistant content
3. `src/components/chat/MessageList.tsx` — scroll container, auto-scroll ref, `overscroll-contain`
4. `src/components/chat/Composer.tsx` — auto-grow textarea, 16px font (no iOS zoom), char counter at 2800+, disabled while pending
5. `src/components/chat/PromptSuggestions.tsx` — chip row from `SUGGESTED_PROMPTS`, hidden once `messages.length > 0`
6. `src/components/chat/ChatHeader.tsx` — agent name + emoji, "New chat" button
7. `src/hooks/useChat.ts` — encapsulates: conversation state, `sendMessage`, optimistic updates, retry, 15s "still thinking" timer, 35s abort
8. `src/app/chat/page.tsx` — client component, reads URL params (`p`, `ctx`, `autosend`, `cid`), wires `useChat` + all components
9. `src/components/marketing/SectionCTA.tsx` — link builder component

Mobile UX specifics (applied in relevant components):
- Layout: `flex flex-col h-[100dvh]`
- Composer: `sticky bottom-0 pb-[env(safe-area-inset-bottom)]`
- Header: `pt-[env(safe-area-inset-top)]`
- Tap targets: `min-h-11 min-w-11`

---

## Phase 7 — Environment + .env.local

Create `/root/projects/Havaya_App/.env.local`:
```
AGENTGLOB_AGENT_NAME=life
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<from Clerk>
CLERK_SECRET_KEY=<from Clerk>
DATABASE_URL=<neon pooled url>
DIRECT_URL=<neon direct url>
```

---

## Verification

Run the app on the dev server:
```bash
cd /root/projects/Havaya_App && pnpm dev --port 3000
```

Access via SSH tunnel locally:
```bash
ssh -i ~/.ssh/hetzner-openclaw -L 3000:localhost:3000 root@204.168.223.245 -N
```
Then open `http://localhost:3000` in browser.

**Checklist:**
- [ ] A. `curl` smoke test against `life` agent returns 200 + `reply`
- [ ] B. Log in, go to `/chat`, send "hi" — typing indicator appears, reply within 30s
- [ ] C. DevTools Network: POST goes to `/api/chat`, NOT to `app.agentglob.com`
- [ ] D. DB: `Conversation` row with correct `sessionKey`, two `Message` rows
- [ ] E. Reload `/chat?cid=<id>` — history renders
- [ ] F. "New chat" button → fresh conversation, empty transcript
- [ ] G. Section CTA: `/chat?p=Hello&autosend=1` → message auto-fires
- [ ] H. 3001-char message → client blocks at composer level

---

## Files to create (summary)

```
prisma/schema.prisma
src/middleware.ts
src/app/layout.tsx                          (modify scaffold)
src/app/page.tsx                            (modify scaffold — home page)
src/app/chat/page.tsx
src/app/api/chat/route.ts
src/app/api/chat/new-session/route.ts
src/app/api/chat/history/route.ts
src/app/api/chat/agent-info/route.ts
src/lib/agentglob.ts
src/lib/auth.ts
src/lib/db.ts
src/lib/ratelimit.ts
src/lib/sectionHints.ts
src/config/prompts.ts
src/hooks/useChat.ts
src/components/chat/TypingIndicator.tsx
src/components/chat/MessageBubble.tsx
src/components/chat/MessageList.tsx
src/components/chat/Composer.tsx
src/components/chat/PromptSuggestions.tsx
src/components/chat/ChatHeader.tsx
src/components/marketing/SectionCTA.tsx
.env.local                                  (on dev server only, not committed)
```

---

# Addendum — Project Documentation & Structural Prep

## Context

The initial build phase is complete and the app is mid-deployment to Coolify at `app.havaya.me`. Before we open the next round of feature work, the repo needs proper directional docs so the project can be picked up by any agent (human or AI) without re-reading session transcripts. Three problems to solve:

1. **No project guide.** Anyone landing on the repo today sees a default `create-next-app` README. There is no canonical "what is Havaya, what are we building, what are the principles" doc.
2. **No usable roadmap.** `ROADMAP.md` is a stub. We have substantial shipped work and clear backlog items from this session — none of it is recorded.
3. **Architecture lives outside the repo.** The deep design (AgentGlob constraints, route map, data model, section CTA pattern, mobile UX rules) is in `/Users/liranperetz/.claude/plans/i-m-building-a-web-drifting-pumpkin.md` — a local file that does not travel with the code.

Outcome: a clean documentation foundation in the repo so the next phase of work can start from a known state.

## Files to create or update

All edits happen on the dev server (`/root/projects/Havaya_App/`) and ship through `./deploy.sh` per the core principles in `AGENTS.md` / `DEPLOY.md`.

### 1. `PLAN.md` (new) — high-level project guide

The north-star doc. Sections:
- **What Havaya is** — a chat-based AI life companion powered by the AgentGlob `life` agent, accessed at `https://app.havaya.me`
- **Why** — one-paragraph product framing (on-demand access to life guidance / reflection)
- **Core principles** — short pointer to the three rules in `AGENTS.md` (git as source of truth, deploy through git, dev on server); do not duplicate
- **Scope (v1)** — what's in the first cut: chat page, Clerk auth, conversation persistence, section CTA pattern. What's explicitly out: streaming, attachments, multi-agent picker, conversation history page.
- **Tech stack at a glance** — Next.js 16 + React 19 + TypeScript + Tailwind 4 + Clerk + Prisma 5.22 + Postgres + Coolify
- **Documentation map** — links to ROADMAP, ARCHITECTURE, DEPLOY, AGENTS

### 2. `ROADMAP.md` (replace existing stub)

Four sections in this order:

- **Shipped** — populated from this session's actual work (initial build, Clerk auth, Prisma + Postgres schema, chat UI, AgentGlob proxy, rate limiting, Coolify deploy pipeline, core docs)
- **In progress** — currently: Coolify production deploy debugging (SSL cert provisioning, Clerk dashboard origin config)
- **Backlog** — known future features: streaming responses, message attachments, multi-agent picker, conversation history sidebar, persistent rate limiting (Upstash), marketing/landing pages with real section CTAs, PWA install, dark mode polish, Hebrew RTL polish (agent replies in Hebrew per smoke test)
- **Feature dependencies** — inline annotation on each backlog item using the format `(depends on: …)`. Examples:
  - `Streaming responses (depends on: AgentGlob exposing SSE on public route — external)`
  - `Multi-agent picker (depends on: agent metadata API — internal — and config UI)`
  - `Conversation history sidebar (depends on: nothing — straight build on existing Conversation table)`

Each entry is a feature title only — details/specs live in separate files, as ROADMAP itself says today.

### 3. `README.md` (replace scaffold default)

Currently the default "This is a Next.js project bootstrapped with create-next-app" text. Replace with a concise repo entry point:
- Title + one-line description
- Live URL: `https://app.havaya.me`
- "Start here" links: PLAN.md (vision), ROADMAP.md (what's next), ARCHITECTURE.md (how it works), DEPLOY.md (how to ship), AGENTS.md (working rules)
- Tech stack one-liner
- "Working on this" pointer to dev server SSH + `./deploy.sh` workflow

### 4. `.env.example` (new)

Lists every env var the app needs with empty values + a comment on where to get each. Critical for onboarding and for the next agent that needs to set this up fresh. Content:

```
# AgentGlob agent slug — already set to "life"
AGENTGLOB_AGENT_NAME=life

# Clerk auth — get from https://dashboard.clerk.com → API Keys
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

# Postgres connection string
# Dev: postgresql://havaya:havaya_dev_pass@localhost:5432/havaya  (havaya-postgres-dev container)
# Prod: internal URL from Coolify Havaya_DB service
DATABASE_URL=
```

The real values stay in `.env` / `.env.local` (gitignored) and Coolify env config.

### 5. `ARCHITECTURE.md` (new)

Extract content from the local plan file `/Users/liranperetz/.claude/plans/i-m-building-a-web-drifting-pumpkin.md` into the repo. Sections to lift:
- What AgentGlob actually gives us (endpoints + constraints table)
- Architecture diagram (browser → `/api/chat` → AgentGlob)
- Route map (page + API routes table)
- Data model (Conversation + Message schemas)
- Session key generation (`app:havaya:<userId>:<conversationId>`)
- Section CTA pattern (URL shapes, preamble injection, `<SectionCTA>` component)
- Predefined prompts (`SUGGESTED_PROMPTS` location)
- Mobile UX must-haves (dvh, safe-area, tap targets)
- Loading UX (typing indicator, 15s/35s timers)
- Rate limiting (in-memory v1, Upstash v2)
- File structure overview

Reference real source paths (`src/lib/agentglob.ts`, `src/app/api/chat/route.ts`, etc.) rather than copying code — the code is the source of truth, the doc is the map.

## Execution order

1. Write `PLAN.md`, `ROADMAP.md`, `README.md`, `.env.example`, `ARCHITECTURE.md` on the dev server
2. `./deploy.sh "docs: add PLAN, ROADMAP, ARCHITECTURE, README, .env.example"` — one commit, ships via Coolify webhook
3. Confirm on GitHub that all five files render correctly in the repo view

## Verification

- [ ] `ls /root/projects/Havaya_App/*.md` shows: PLAN, ROADMAP, ARCHITECTURE, README, DEPLOY, AGENTS, CLAUDE
- [ ] `.env.example` exists at repo root
- [ ] `git log -1` shows the docs commit on `main`
- [ ] `https://github.com/cryptolir/app.havaya` repo view shows the new README as the landing content
- [ ] README links to all four other docs without 404s
- [ ] ROADMAP "Shipped" section lists everything from this session's actual commit history
- [ ] ARCHITECTURE.md references real source paths that exist in the repo

## Suggested follow-ups (not in this batch)

These are structural niceties to consider once the docs land — not blocking:
- Branch protection on `main` (prevent force-pushes, since git is the source of truth)
- GitHub repo description + topics for discoverability
- A `.github/PULL_REQUEST_TEMPLATE.md` — only if/when we move off direct-push to PRs
- CI workflow for typecheck/lint on push — only if Coolify build feedback becomes too slow as a signal

---

# Addendum 3 — Chat UI on assistant-ui (full replace)

## Context

The hand-rolled chat UI (six components + `useChat.ts` + `chat/page.tsx`) was the right call to ship v1 fast, but the maintenance surface grows quickly: streaming, attachments, voice, accessibility, branching, tool calls, retries. None of that is differentiated work for Havaya — it's chat-UX infrastructure better adopted from a mature library.

We evaluated two open-source candidates and picked **[assistant-ui](https://github.com/assistant-ui/assistant-ui)** (10.3k stars, YC-backed, MIT, used in prod by LangChain / Mastra / Browser-Use / Helicone). The runner-up — [deep-chat](https://github.com/ovidijusparsiunas/deep-chat) (3.6k stars) — is a framework-agnostic web component, more "configure-this-monolith" than "compose-primitives." It would be a regression for our React/TypeScript/Tailwind 4 stack.

Why assistant-ui specifically:
- **Native React/TypeScript**, Next.js App Router compatible
- **Radix-style primitives**: `Thread`, `Message`, `Composer`, `ThreadList`, `ActionBar` compose freely — we keep full control of layout and styling
- **shadcn/ui-style install** via CLI: themed components copied into our repo, we own them
- **Tailwind-friendly** — matches our existing styling approach
- **Production UX in the box**: streaming, auto-scroll, retries, markdown, code highlighting, voice dictation, keyboard shortcuts, accessibility
- **Generative UI**: tool calls render as React components — useful when AgentGlob exposes tool visibility (see [AGENTGLOB.md](./AGENTGLOB.md) §4)
- **Custom backend support** via `useExternalStoreRuntime` / `@assistant-ui/react-data-stream` — works with our existing `/api/chat` proxy without changing AgentGlob

User decision: **full in-place replace**. The existing chat UI is disposable. Backend, auth, DB, deploy pipeline, and docs all stay.

## Decisions baked in

- **Library**: `@assistant-ui/react` + `useExternalStoreRuntime` (or `@assistant-ui/react-data-stream` if we adapt the backend to emit the AI SDK data-stream format later)
- **Scaffold**: `npx assistant-ui@latest init` — copies styled shadcn-themed components into `src/components/assistant-ui/`
- **Backend integration**: custom runtime adapter (`src/lib/havayaRuntime.ts`) that POSTs to our existing `/api/chat`. No backend changes required.
- **DB**: keep `Conversation` + `Message` schema; the runtime adapter translates between assistant-ui's thread model and our rows.
- **Streaming-ready shape**: the adapter is structured so that the day AgentGlob ships SSE ([AGENTGLOB.md](./AGENTGLOB.md) §4.1), we swap the data path to consume deltas without touching the UI.
- **RTL/Hebrew**: detect Hebrew on first message; set `dir="rtl"` on the Thread container. Tailwind 4's RTL utilities handle the rest.

## What stays (do not touch)

| Layer | Files |
|---|---|
| Auth | `src/proxy.ts`, `src/lib/auth.ts`, `src/app/layout.tsx` (ClerkProvider) |
| AgentGlob proxy | `src/app/api/chat/route.ts`, `src/app/api/chat/new-session/route.ts`, `src/app/api/chat/history/route.ts`, `src/app/api/chat/agent-info/route.ts` |
| Backend libs | `src/lib/agentglob.ts`, `src/lib/db.ts`, `src/lib/ratelimit.ts`, `src/lib/sectionHints.ts`, `src/config/prompts.ts` |
| DB | `prisma/schema.prisma`, `prisma/migrations/*` |
| Home + meta | `src/app/page.tsx`, `src/app/globals.css` |
| Infra | `prisma.config.ts` (none — removed in earlier phase), Coolify config, `deploy.sh` |
| Docs | `PLAN.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `DEPLOY.md`, `AGENTS.md`, `AGENTGLOB.md`, `README.md`, `.env.example` (updated for new structure, not rewritten) |

## What goes (delete)

- `src/components/chat/*` — all six hand-rolled components
- `src/components/marketing/SectionCTA.tsx` — rebuild as a trivial 10-line link helper if still needed; the URL contract stays
- `src/hooks/useChat.ts`
- `src/app/chat/page.tsx` — replaced entirely

## Execution

### Step 1 — Install assistant-ui

On the dev server (SSH):

```bash
cd /root/projects/Havaya_App
pnpm dlx assistant-ui@latest init
```

The CLI may be interactive. If it stalls over SSH, fall back to manual install + manual component copy from the [starter repo](https://github.com/assistant-ui/assistant-ui-starter):

```bash
pnpm add @assistant-ui/react
# Then manually create the styled components in src/components/assistant-ui/
```

Verify post-install:
- `package.json` lists `@assistant-ui/react`
- `src/components/assistant-ui/` exists with `thread.tsx`, `markdown-text.tsx`, etc.

### Step 2 — Custom runtime adapter

Create `src/lib/havayaRuntime.ts`:

- Uses `useExternalStoreRuntime` from `@assistant-ui/react`
- State: `messages[]`, `conversationId`, `isRunning`
- `onNew({ message })`: POST `/api/chat` with `{ conversationId, message: message.content.text, sectionContext }`; optimistically push the user message; on response, push the assistant message; update `conversationId` if newly created
- `onCancel`: closes the in-flight fetch; surfaces honest "stopped waiting" message (rule from current `useChat.ts` — see [AGENTGLOB.md](./AGENTGLOB.md) §3.5)
- Hydration: `hydrate(messages, conversationId)` for loading from `/api/chat/history`
- Error handling: 429 → toast with retry-after; 500/502 → bubble with retry button
- Hebrew detection: if the assistant's reply contains Hebrew characters (`/[֐-׿]/`), set a `dir="rtl"` hint that the Thread container can consume

### Step 3 — Replace the chat page

Rewrite `src/app/chat/page.tsx`:

```tsx
"use client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useHavayaRuntime } from "@/lib/havayaRuntime";
import { Thread } from "@/components/assistant-ui/thread";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";

function ChatInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const seed = sp.get("p") ?? "";
  const ctx = sp.get("ctx");
  const autosend = sp.get("autosend") === "1";
  const cid = sp.get("cid");

  const runtime = useHavayaRuntime({ initialConversationId: cid, sectionContext: ctx });

  useEffect(() => {
    // bootstrap: load history if cid, else create new session
    // autosend seed message if autosend=1
    // ...
  }, []);

  return (
    <div className="flex flex-col h-[100dvh]">
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>
    </div>
  );
}

export default function ChatPage() {
  return <Suspense><ChatInner /></Suspense>;
}
```

URL contract unchanged: `/chat?p=&ctx=&autosend=1&cid=`.

### Step 4 — Theme the assistant-ui components

The CLI scaffold puts styled components in `src/components/assistant-ui/`. Edit them to:
- Reskin to Havaya's visual identity (minimal: neutral palette, rounded bubbles, no background patterns)
- Wire `SUGGESTED_PROMPTS` from `src/config/prompts.ts` into the ThreadWelcome / empty state
- Pull agent metadata (emoji, name, description) from `/api/chat/agent-info` and render in the header
- Apply mobile rules: `min-h-11 min-w-11` on tap targets, `text-base` on composer textarea, `pb-[env(safe-area-inset-bottom)]` on composer container, `pt-[env(safe-area-inset-top)]` on header

### Step 5 — Section CTA helper (replacement)

Create a fresh `src/components/SectionCTA.tsx` — a thin link builder, same URL contract:

```tsx
import Link from "next/link";

export function SectionCTA({ seed, ctx, autosend, children, className }) {
  const p = new URLSearchParams();
  if (seed) p.set("p", seed);
  if (ctx) p.set("ctx", ctx);
  if (autosend) p.set("autosend", "1");
  return <Link href={`/chat?${p}`} className={className}>{children}</Link>;
}
```

(Marketing/ directory is empty after the chat components are gone — flatten to `src/components/SectionCTA.tsx`.)

### Step 6 — Delete the old code

```bash
rm -rf src/components/chat
rm -rf src/components/marketing
rm src/hooks/useChat.ts
```

### Step 7 — Update the docs

- `ARCHITECTURE.md` — replace the "Chat UI" section's component list with the assistant-ui structure; reference `src/lib/havayaRuntime.ts` as the integration point
- `ROADMAP.md` — under "Shipped" add: "Chat UI migrated to assistant-ui (custom runtime adapter)"; remove the now-obsolete entries about specific component files
- `PLAN.md` — tech stack line: append `+ assistant-ui`
- `AGENTGLOB.md` §6 — update file references (e.g. "Rewrite `/api/chat/route.ts` as a streaming proxy; update `havayaRuntime.ts` to consume deltas")

### Step 8 — Ship

```bash
./deploy.sh "feat: migrate chat UI to assistant-ui with custom runtime adapter"
```

Coolify auto-deploys. Verify via the checklist below before considering the migration done.

## Verification

Run on the dev server first (`pnpm dev --port 3000` + SSH tunnel), then re-verify on prod after deploy.

- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm build` clean (Coolify build runs the same)
- [ ] Home page → "Open Chat" → renders assistant-ui Thread with our theming
- [ ] Empty thread shows `SUGGESTED_PROMPTS` as chips; clicking one fills the composer
- [ ] Header shows agent emoji + display name (from `/api/chat/agent-info`)
- [ ] Send "hi" → typing/streaming pattern → reply within 30s
- [ ] DevTools Network: POST to `/api/chat` (NOT direct to `app.agentglob.com`)
- [ ] DB: one `Conversation` row + two `Message` rows after the round-trip
- [ ] Reload `/chat?cid=<id>` → history hydrates into the new Thread
- [ ] "New chat" / equivalent in the Thread UI → fresh session, empty transcript
- [ ] `/chat?p=Hello&autosend=1` → composer auto-fires the seed message
- [ ] `/chat?ctx=pricing` → first user message includes the section preamble (server-side, invisible in transcript) — verify in DB that user `Message.content` is the raw user text
- [ ] Hebrew reply: container flips to `dir="rtl"`, bubble alignment is correct
- [ ] Mobile (iOS Safari real device or DevTools): 100dvh works, composer respects safe-area, textarea does not trigger zoom on focus, tap targets ≥ 44px
- [ ] Composer enforces 3000-char cap (client-side); 3001 chars over /api/chat returns 400
- [ ] Hammer 21 messages in a minute → 21st gets `429` surfaced (toast/inline error)

## Deferred (not in this batch)

These come "for free" with assistant-ui but adopting them later keeps the migration focused:

- **Tool calls / generative UI** — pending AgentGlob exposing tool visibility
- **Voice dictation** — assistant-ui has it; turn on in composer when wanted
- **Attachments** — pending AgentGlob attachment support ([AGENTGLOB.md](./AGENTGLOB.md) §4.7)
- **ThreadList sidebar** — depends on conversation list UX decision; build when wanted
- **Branching / regenerate** — useful but not v1
- **Switch to AI SDK data-stream format on `/api/chat`** — only after AgentGlob exposes SSE; until then `useExternalStoreRuntime` with JSON is simpler

## Known risks

- **Next.js 16 + assistant-ui** — assistant-ui's docs target Next.js 14/15; we're on 16. Minor adjustments may be needed (e.g. async `auth()`, `proxy.ts` vs `middleware.ts`). Have already navigated these for Clerk, same patterns apply.
- **Interactive CLI over SSH** — `pnpm dlx assistant-ui@latest init` may prompt. If it stalls, fall back to manual install.
- **React 19 peer-dep edge cases** — assistant-ui's transitive deps may not yet declare React 19. If `pnpm install` errors, add a `pnpm.overrides` block to force React 19. Same pattern we already used for Prisma 5 pinning.

---

# Addendum 4 — Home hub page, agent-workspace content & AgentGlob file API

> ⚠️ **Superseded-contract notice (added after Codex review, 2026-05-31).** Addendum 4 is **historical R&D**. Its agent-side API was first specced as a **whole-file** read — `GET …/files/<filename>`, a `publicFiles` allowlist, and a `getAgentFile(name)` consumer. That was **replaced** by the per-user **section** API: `GET …/user-file?userId=&section=`, a **section** allowlist, and a `getUserSection(userId, section)` consumer. Wherever §A–§C below say `User_D_Prompt.md` / `app_note.md` (whole files), `/files/<filename>`, `publicFiles`, or `getAgentFile()`, read them as their **section** equivalents (`User_D_Prompt` / `app_note` *sections*, `user-file?section=`, `getUserSection`). The **live, authoritative contract** is **Addendum 5** (agent↔app integration boundary) + [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md) + [`AGENTGLOB_PERUSER_GUIDANCE.md`](./AGENTGLOB_PERUSER_GUIDANCE.md).

## Context

The current home page (`src/app/page.tsx`) is a bare hero (title + sign-in / "Open Chat"). The chat lives separately at `/chat`. We want the **main page to become the product hub**: the chat is the centerpiece, with a clickable-prompts panel beside it, the channel's latest videos, an owner-authored note, and a persistent bottom nav to two future pages. Two of these content blocks (prompts, owner note) must be sourced from the **agent's workspace files** so the agent owner — not a deploy — controls them.

This addendum is **R&D + plan only** (no code yet). It records what was verified live, the target architecture, the **new AgentGlob API** this requires, and a phased build that ships the dependency-free parts now.

### What was verified live (2026-05-30)

1. **AgentGlob integration still works — no breaking change.**
   - `GET /api/public/chat/life` now returns extra fields beyond what `AgentInfo` reads: `status`, `serverLabel`, `serverFlag`, `name`, and a new `landingPage: { backgroundImageUrl, markdownContent }`. Our `getAgentInfo()` reads a subset → still compatible.
   - `POST` still returns `{ reply, message: { role, content: [{type,text}] } }`. We read `data.reply` ✅. **`message.id` is no longer present** → `agentglobMessageId` is always null now (harmless; stop relying on it).
2. **`User_D_Prompt.md` does NOT exist** on the `life` agent workspace. Asked the agent to list its files: `AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md`. The prompts file must be created on the agent side.
3. **AgentGlob exposes no way to read a workspace file** → a new public API is required (see §A).
4. **YouTube auto-latest is viable with zero API key.** Channel `@talcrolltraining` → channelId **`UCu2Cx6ebc9bbAE_cCgFbPMQ`** (display name "אימון של הרגש"). RSS `https://www.youtube.com/feeds/videos.xml?channel_id=UCu2Cx6ebc9bbAE_cCgFbPMQ` returns the latest ~15 entries with `yt:videoId`, `title`, `published`, `media:thumbnail`. Content is Hebrew (RTL).

### Decisions locked with the user

| Topic | Decision |
|---|---|
| Home layout | **Chat hub (embedded)** — chat centerpiece, prompts to its left, videos + note as sections, bottom nav always visible |
| Prompts source | **Agent workspace** file `User_D_Prompt.md` (needs new AgentGlob file API) |
| Owner note source | **Agent workspace** file `app_note.md` (same new API) |
| Videos | **Auto-latest** from the channel via RSS |
| Footer nav | center = home (`/`), right = **community** (`/community`), left = **joinery** (`/joinery`) |

> ⚠️ **Open item to confirm at review:** "joinery" — likely intended as **"journey"** (fits a life/emotion-training app; "joinery" = woodwork). Route + page names depend on this. Plan uses `joinery` as given; confirm before building.

---

## A. New AgentGlob API (the central dependency) — ⚠️ SUPERSEDED (see notice at top of Addendum 4)

Both the prompts panel and the owner note read agent-workspace files. **This endpoint must be built on the AgentGlob / OpenClaw side — NOT in the Havaya repo** (per the project-isolation boundary in `AGENTS.md`). Havaya only consumes it. We will **spec it formally in `AGENTGLOB.md` §4** as the actionable contract.

**Proposed contract:**
```http
GET /api/public/chat/<agent>/user-file?userId=<id>&section=<name>   # live contract; SUPERSEDES the earlier /files/<filename> form
```
Response `200`:
```json
{ "name": "User_D_Prompt.md", "content": "…raw file text…", "contentType": "text/markdown", "updatedAt": "2026-05-20T06:53:34Z" }
```
`404` if the file is not in the public allowlist or doesn't exist.

**Security (must-have):** never serve arbitrary workspace files — that would leak `SOUL.md`, `MEMORY.md`, `IDENTITY.md`, secrets. Serve **only** files the owner explicitly allowlists in agent settings (e.g. `publicFiles: ["User_D_Prompt.md", "app_note.md"]`) — or, alternatively, only files under a conventional `workspace/public/` directory. Recommend the allowlist.

**Caching:** support `ETag` / `Last-Modified` so Havaya can revalidate cheaply.

Until this lands, the Havaya consumer treats any non-200 as "no content" and the UI shows graceful empty states (see phasing).

---

## B. Havaya side — what we build (in our repo)

### B1. AgentGlob consumer
- `src/lib/agentglob.ts` — add `getAgentFile(name): Promise<{ content: string; updatedAt?: string } | null>`; GET the new endpoint, 5-min in-memory cache + `next: { revalidate }` (mirror existing `getAgentInfo` pattern). Returns `null` on 404/error so callers degrade gracefully.
- Minor cleanups (optional, same file): stop depending on `message.id`; optionally surface `status` (offline state) and `landingPage.backgroundImageUrl` (home backdrop).

### B2. Parsers + content API routes (server-side, so parsing/caching stays off the client)
- `src/lib/agentContent.ts` — `parsePrompts(md): string[]` (convention: one prompt per markdown list item / non-empty line; take first 5) and pass-through for the note markdown.
- `GET /api/agent/prompts` → `{ prompts: string[] }` from `User_D_Prompt.md`.
- `GET /api/agent/note` → `{ markdown: string | null }` from `app_note.md`.

### B3. YouTube (no external dependency — buildable now)
- `src/lib/youtube.ts` — `getLatestVideos(limit=6)` fetches the RSS feed, parses entries → `{ id, title, published, thumbnail }[]`, cached ~1h. Channel id in config/env (`YOUTUBE_CHANNEL_ID=UCu2Cx6ebc9bbAE_cCgFbPMQ`).
- `GET /api/youtube/latest` (or fetch directly in a server component).

### B4. Chat hub page + components
- Extract the existing `/chat` bootstrap (runtime + Thread + `?cid/?p/?ctx/autosend` handling in `src/app/chat/page.tsx`) into a reusable **`src/components/chat/ChatPanel.tsx`** so the hub and the standalone `/chat` route share one implementation (no duplicated runtime logic).
- **`src/app/page.tsx`** (signed-in) becomes the hub:
  - **PromptsPanel** (left on desktop, horizontal chip row on mobile) — renders the 5 prompts; **click → `sendMessage(prompt)`** via the exposed `useHavayaRuntime().sendMessage` (autosend, same behavior as `?p=&autosend=1`). No backend change for this part.
  - **ChatPanel** (center) — the embedded chat.
  - **VideosSection** — latest videos as lite-embeds (`youtube-nocookie.com/embed/<id>`, iframe loads on click for perf), RTL-aware.
  - **OwnerNote** — slim banner rendering `app_note.md` markdown; hidden when null.
  - **BottomNav** — fixed, 3 targets `[joinery · home · community]`, lucide icons, center emphasized, `pb-[env(safe-area-inset-bottom)]`, ≥44px tap targets.
  - Signed-out → keep the current sign-in / get-started CTA.
- **`src/app/community/page.tsx`** and **`src/app/joinery/page.tsx`** — stub pages ("coming soon") + BottomNav.
- Responsive: desktop = two-column (prompts ~280px left, chat flex-1) with videos/note as sections; mobile = note banner → prompts chip row → chat fills → videos rail → fixed bottom nav. (Exact mobile arrangement to refine during build.)

### B5. Docs
- `AGENTGLOB.md` — add the §4 "read workspace file" API spec (§A above) and mark prompts/note as consumers.
- `ROADMAP.md` — Shipped: home hub, YouTube auto-latest, footer nav, stub pages. Backlog/blocked: prompts + owner note (depend on AgentGlob file API); community + joinery page content.
- `ARCHITECTURE.md` — add the hub IA, `ChatPanel` extraction, `getAgentFile`/`youtube` libs, route map (`/`, `/community`, `/joinery`, `/api/agent/*`, `/api/youtube/latest`).

---

## C. Phasing (so we ship without waiting on the new API)

**Phase 1 — no external dependency, ship now**
- `ChatPanel` extraction + hub layout in `src/app/page.tsx`.
- YouTube auto-latest (lib + route + section).
- BottomNav + `/community` + `/joinery` stubs.
- Prompts panel + OwnerNote **shells** wired to `/api/agent/*`, which return empty until the API exists → graceful empty states.
- Optional AgentGlob integration cleanups (drop `message.id` reliance).

**Phase 2 — gated on AgentGlob file API (separate, agent-side task)**
- Implement the file endpoint on AgentGlob (NOT this repo); create `User_D_Prompt.md` and `app_note.md` on the `life` workspace with the allowlist.
- `getAgentFile` + parsers light up the prompts panel (click-to-send) and the owner note. No further Havaya UI work — shells already in place.

---

## Files (summary)

```
src/app/page.tsx                      (rewrite → signed-in hub)
src/app/community/page.tsx            (new stub)
src/app/joinery/page.tsx             (new stub — confirm name)
src/components/chat/ChatPanel.tsx     (new — extracted from chat/page.tsx)
src/components/home/PromptsPanel.tsx  (new)
src/components/home/VideosSection.tsx (new)
src/components/home/OwnerNote.tsx     (new)
src/components/home/BottomNav.tsx     (new)
src/lib/agentglob.ts                  (add getAgentFile; minor cleanups)
src/lib/agentContent.ts               (new — parsePrompts)
src/lib/youtube.ts                    (new — RSS fetch/parse)
src/app/api/agent/prompts/route.ts    (new)
src/app/api/agent/note/route.ts       (new)
src/app/api/youtube/latest/route.ts   (new)
src/app/chat/page.tsx                 (slim down to render <ChatPanel/>)
AGENTGLOB.md, ROADMAP.md, ARCHITECTURE.md (docs)
```
All work on the dev server; ship via `./deploy.sh`. The AgentGlob endpoint is **out of scope for this repo** (agent-side task).

## Verification

- [ ] `pnpm tsc --noEmit` + `pnpm build` clean.
- [ ] Home `/` (signed in): chat embedded, prompts panel left (desktop) / chip row (mobile), videos section, note slot, bottom nav.
- [ ] Videos: latest entries from `UCu2Cx6ebc9bbAE_cCgFbPMQ` render; click loads embed; RTL correct.
- [ ] BottomNav: home→`/`, right→`/community`, left→`/joinery`; tap targets ≥44px; safe-area respected.
- [ ] `/chat` still works (shared `ChatPanel`); `?cid/?p/?ctx/autosend` unchanged.
- [ ] Phase-1 empty states: `/api/agent/prompts` & `/api/agent/note` return empty → panel shows "no prompts yet", note hidden (no crash).
- [ ] **Phase 2:** create `User_D_Prompt.md` (5 prompts) + `app_note.md` on the agent + allowlist → prompts render, **clicking sends** the prompt into chat; note banner shows. DB: one `Conversation` + two `Message` rows per prompt round-trip.
- [ ] Security: requesting a non-allowlisted file (e.g. `SOUL.md`) via the new API returns 404.

---

# Addendum 5 — Agent ↔ App integration: relationship & responsibility boundary

## Why this chapter exists

The Havaya app and the AgentGlob `life` agent are **two systems with one contract**. Earlier addenda described features; this one describes the **seam** — who owns what, how identity flows, how data crosses the boundary — so a reviewer (or a new agent on either side) can reason about the integration without reading the whole history. It also records the conclusion of the "one agent, many users" research: **keep partitioning app-owned; back per-user fields with files, not vector memory.** Full rationale: [`AGENTGLOB_PERUSER_GUIDANCE.md`](./AGENTGLOB_PERUSER_GUIDANCE.md).

## The two systems

| | **Havaya app** (this repo) | **AgentGlob `life` agent** (separate, agent-side) |
|---|---|---|
| Runs | Next.js on Coolify, `https://app.havaya.me` | OpenClaw agent behind `https://app.agentglob.com/api/public/chat/life` |
| Owns | Auth (Clerk), conversation persistence (Postgres), the UI, rate limiting, session-key minting | The model, the agent persona (`SOUL.md` etc.), per-user workspace files, the reply |
| Source of truth for | Who the user is, conversation rows, what gets displayed | The agent's response; per-user app fields (`User_D_Prompt`, `app_note`) it writes into the per-user file |
| Never does | Store agent persona; read arbitrary agent files | Authenticate end users; mint session keys; render UI |

**Hard rule (per `AGENTS.md` §0):** the agent-side endpoint and per-user files are **out of scope for this repo**. Havaya only *consumes* them. Any change to the agent side is an AgentGlob task, specced via handoff docs, never edited here.

## Identity: one key, three places

The integration hinges on a single user identifier — the **Clerk `userId`** — appearing consistently in three places:

```
Clerk userId  ──►  sessionKey = app:havaya:<userId>:<conversationId>   (chat round-trip)
              ──►  per-user workspace file key                  (agent-side store)
              ──►  ?userId= on the user-file read               (per-user section read)
```

Because the same `userId` keys all three, the agent and the app agree on identity without a separate handshake. The **app API key** scopes *which app's* `userId` namespace is being resolved, so one app can never read another's users.

## Conversation isolation is app-owned (not `dmScope`)

Havaya is a "one agent, many users" deployment — but it isolates users **at the app layer**, not via the agent's `dmScope`:

- The app authenticates with Clerk, then sends a **distinct `sessionKey` per user/conversation**. Two users can never share a session because the app mints the keys.
- This is explicit, auditable, and decoupled from messaging-platform semantics.
- **`dmScope` is deliberately not used** for the web path; it solves agent-side ingress (Telegram/Slack DMs), a surface Havaya doesn't expose. It would only become relevant if `life` later takes direct messages alongside the app.

## Two data flows across the boundary

### Flow 1 — Chat round-trip (live, shipped)

```
Browser ──► /api/chat (Havaya proxy) ──► POST /api/public/chat/life ──► reply
   ▲            │  auth, rate-limit, persist user+assistant Message rows
   └────────────┘  sessionKey = app:havaya:<userId>:<conversationId>
```

- Havaya **never** calls `app.agentglob.com` from the browser — always server-side through `/api/chat`.
- Returns `{ reply, message: { role, content:[{type,text}] } }`. We read `data.reply`. **`message.id` is no longer returned** → `agentglobMessageId` is always null (harmless).

### Flow 2 — Per-user section read (Phase 2, blocked on AgentGlob)

```
Home hub (server component) ──► getUserSection(userId, "User_D_Prompt")
                            ──► GET …/life/user-file?userId=&section=  (Bearer app key)
                            ──► { content, updatedAt }  → parsePrompts() → 5 clickable prompts
```

- Read-only, server-side, app-key + userId scoped. Same path for `app_note`.
- Until the endpoint ships and `AGENTGLOB_APP_API_KEY` is set, both calls return `null` and those sections render empty — **no errors, no blocking**.
- Click on a prompt → `sendMessage(prompt)` → re-enters **Flow 1**. So Flow 2 only *sources* content; the agent interaction is always Flow 1.

## Per-user persistence: the decided model

The fields the app displays (`User_D_Prompt`, `app_note`) are **owner-edited, displayed verbatim, must be addressable**. Therefore:

- **Backed by the file route** — named HTML-comment sections inside each user's per-user workspace file (`<!-- app:User_D_Prompt:start -->…<!-- :end -->`). Marker format & security in [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md).
- **Not** the memory plugin (vector recall is fuzzy/non-addressable — wrong for displayed content; right later for "what the agent learns").
- New app field later = a new `app:<name>` section + an allowlist entry. No app redeploy for content changes.

## Contract surface (what each side must honor)

**AgentGlob provides:**
1. `POST /api/public/chat/life` → `{ reply, … }` (live).
2. `GET /api/public/chat/life/user-file?userId=&section=` (Bearer app key) → section content (to build — [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md)).
3. An **app API key** for Havaya; **allowlist** `User_D_Prompt` + `app_note`; the agent **writes** those sections per user.

**Havaya provides / guarantees:**
1. Stable `sessionKey = app:havaya:<userId>:<conversationId>` (app-namespaced via `makeSessionKey()`; pre-namespace conversations keep their stored 3-part key) — Clerk `userId` is the component after the namespace.
2. App key held **server-side only** (`AGENTGLOB_APP_API_KEY`); never shipped to the browser.
3. Graceful empty states for every not-yet-available section (non-200 → no content, no crash).

## What unblocks Phase 2 (all AgentGlob-side)

1. Implement `GET …/user-file` per the spec.
2. Issue Havaya an app API key → set as `AGENTGLOB_APP_API_KEY` in Coolify.
3. `life` writes `User_D_Prompt` (5 prompts) + `app_note` into each user's per-user file using the markers.
4. Allowlist those two sections on `life`.

Havaya's side is **fully built and deployed**; the only blockers are these four agent-side items. See [`AGENTGLOB_PERUSER_GUIDANCE.md`](./AGENTGLOB_PERUSER_GUIDANCE.md) for the four questions to confirm back (native file scoping? provisioning model? contract unaffected? key issued?).
