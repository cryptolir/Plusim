# Plusim — chat bootstrap: fix the double-conversation bug + pending-reply pickup

> **Status:** 🔍 **Rev 1 — DRAFT** (pre-ponytail). The follow-up plan promised
> by the chat-latency plan's Rev 7 descope (`docs/plans/chat-latency.md`).
> Scope: the `/chat` bootstrap only — the smallest design that fixes the known
> bug and satisfies the three constraints banked from the latency plan's
> review rounds 4–5.
>
> **Review log:** Rev 1 — initial draft.

## Context — the live bug, file-anchored

On a seeded `/chat` visit (`/chat?p=…&autosend=1`, e.g. a home-hub prompt
click), the page:

1. POSTs `/api/chat/new-session`, which mints a conversation (placeholder,
   title-null) and returns its id (`new-session/route.ts:17-25`);
2. writes that id **only into the URL** — `router.replace(`/chat?cid=${id}`)`
   (`chat/page.tsx:52`) — and **never into the runtime**:
   `conversationIdRef` is initialized once at mount from the (absent) `cid`
   param (`plusimRuntime.ts:47`) and nothing syncs it afterwards;
3. fires `sendMessage(seed)` (`chat/page.tsx:56`), which posts
   `conversationId: null` (`plusimRuntime.ts:76`) → `/api/chat` **creates a
   second conversation** (`route.ts` create branch).

Result: the URL's `cid` points at the empty placeholder; a reload hydrates the
placeholder and the real thread "disappears" (findable only via recent chats);
placeholders accumulate on every seeded visit. Found independently by both
pre-review passes of the latency plan; shipped unfixed there (Rev 7 descope)
because the *rework* attempts churned — the **minimal fix did not exist in
those attempts** and does now (below).

A second, related gap (latency plan review round 5, Codex #7): a reload during
the 2–90s synchronous wait lands on `?cid` **after** the user message is
written but **before** the reply lands. The bootstrap does one history fetch
(`chat/page.tsx:29-34`) and nothing ever re-fetches — the reply, though
persisted server-side, stays invisible until a manual reopen.

## Banked constraints (from chat-latency Rev 7 — each MUST be addressed)

| # | Constraint | How this plan satisfies it |
|---|---|---|
| 1 | Client-minted ids must be UUID-validated before any create (Codex #6) | **By design: there are no client-minted ids.** The id is server-minted (`new-session`) exactly as today; `/api/chat` stays **lookup-only** for supplied ids (unknown id → 404, no create-if-missing). T9 asserts the contract didn't widen. |
| 2 | A reload landing on a conversation whose last row is a user turn needs a **bounded** pending-reply pickup (Codex #7) | **P2** — a conditional, time-bounded history re-poll that reuses the existing `isRunning` UI. |
| 3 | A refresh mid-wait must neither re-send nor orphan the reply (Codex #5) | **P1 ordering** — the server-minted `cid` is in the runtime *and* the URL **before** the send fires; the same `router.replace` strips `p`/`autosend`. Reload → `cid` bootstrap → hydrate + (if pending) P2 pickup. T2/T3. |

This is also the shape Codex round 4 itself endorsed as the alternative:
*"mint/sync the conversation id before starting the long call, **or keep a
fixed bootstrap path for these sends**"* — we keep the fixed bootstrap path.

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| `hydrate(rows, cid)` (`plusimRuntime.ts:167-168`) — sets `conversationIdRef` + state | **The bug fix is calling it.** `hydrate([], cid)` wires the minted id into the runtime before the seeded send |
| `bootstrapped` ref (`chat/page.tsx:22-26`) | Strict-mode double-effect safety — kept as-is |
| `ThinkingIndicator` + 15s caption (`thread.tsx`, latency A1), driven by `isRunning` | P2's pickup sets `isRunning` → the wait UI is free |
| `AGENT_TIMEOUT_MS` / `CHAT_CLIENT_TIMEOUT_MS` (`chatTimeouts.ts`) | P2's pickup bound derives from the same constants — no new magic numbers |
| `/api/chat/history` (returns rows with `role` + `createdAt`) | P2 polls it; the pending state is "last row is a user turn" |
| Placeholder prune in `new-session` (`route.ts:32-43`) | Kept — placeholders still exist (bare visits), and P1 stops the *seeded-visit* accumulation |
| Abort copy (`plusimRuntime.ts`, latency A3) | P2's bound-stop can reuse the same honest wording if we choose to say anything (see P2) |

## Plan

**P1 — wire the minted id into the runtime (the bug fix).** In the
`new-session` `.then` (`chat/page.tsx:50-58`), order becomes:

```ts
hydrate([], data.conversationId);          // runtime now owns the cid  ← the fix
router.replace(`/chat?cid=${data.conversationId}`, { scroll: false }); // strips p/ctx/autosend
if (seed && autosend) void sendMessage(seed);
```

The seeded send now posts `conversationId: <minted id>` → `/api/chat` appends
to the **same** conversation (no duplicate); the URL `cid` is the real thread;
reload hydrates the messages. `sectionContext` still lands: `new-session`
already stores `ctx` on the created conversation (`new-session/route.ts:23`),
and `/api/chat` only consumes `sectionContext` on its create branch — which no
longer runs here. Note the first-turn preamble reads the **conversation's**
stored `sectionContext` (`route.ts`), so `past_meeting` behavior is unchanged.

**P2 — bounded pending-reply pickup (constraint #2).** On the `?cid` bootstrap
(`chat/page.tsx:28-42`), after `hydrate(rows, cid)`: if the **last row is a
user turn**, the reply may still be in flight server-side — enter pickup:

- Compute the window: a reply can only land within the server ceiling of the
  user turn, so the pickup deadline is
  `userTurn.createdAt + CHAT_CLIENT_TIMEOUT_MS`. If already past, do nothing
  (stale pending turn, e.g. an old 502 — no poll ever starts).
- While in the window: set `isRunning = true` (the existing typing indicator +
  15s caption render for free), re-fetch `/api/chat/history` every ~5s.
- Stop on: (a) an assistant row appears → append rows, `isRunning = false`;
  (b) the deadline passes → `isRunning = false`, stop **silently** (the user
  sees their message without a reply and can re-send — no speculative error
  copy for a turn whose failure we didn't observe); (c) the user sends a new
  message → cancel the pickup (the new send's own lifecycle takes over).
- The poll is **conditional** (only when a pending turn is detected on
  bootstrap) and **bounded** (never outlives the window) — it is not a
  background poller. When AgentGlob ships SSE (issue #19), this pickup is
  replaced by stream-resume and deleted.

**P3 — `shrink:` the bootstrap round trip.** `new-session` awaits
`getAgentInfo()` (an external call on cold cache) and returns `agentInfo`
that its only caller discards (`chat/page.tsx:50` destructures nothing but
`conversationId`; avatars use `/api/chat/agent-info`). Delete the await and
the response field. The prune stays (still needed for bare-visit
placeholders).

## Alternatives considered

1. **Client-minted UUID + create-if-missing** (the latency plan's Rev 6
   shape): rejected — it widens `/api/chat` from lookup-only to accepting
   client-controlled ids (the exact trust-boundary churn of rounds 4–5), for
   no benefit over the server-minted id that already exists.
2. **Lazy `/chat` (delete `new-session`)**: rejected for now — it recreates
   the "no cid before the long send" problem that consumed two review rounds.
   Revisit with streaming, which removes the long synchronous wait entirely.
3. **Do nothing until streaming**: the double-conversation bug is live and
   user-visible today; P1 is ~3 lines. Not waiting.

## Non-goals

- Any `/api/chat` contract change (stays lookup-only for supplied ids).
- Deleting `/api/chat/new-session` or making blank `/chat` lazy.
- Home-hub reload pickup — the home page has no `cid` in its URL; a reply
  landing after a home reload is already surfaced by the recent-chats unread
  dot. Out of scope.
- Streaming (external, issue #19).

## Risks / contingencies

- **Strict-mode double effects:** the existing `bootstrapped` ref guards the
  whole `.then` — `hydrate`/`replace`/`send` run once. Unchanged.
- **Refresh between mount and the `new-session` response:** nothing was sent;
  the seed params re-fire on the new load and a fresh placeholder is minted
  (the old one is pruned later). Same as today; harmless.
- **`hydrate([], cid)` clears message state:** at this point in the bootstrap
  there are no messages in state — it only sets the id. T2 covers the flow.
- **Pickup vs. a mid-pickup send:** cancel-on-send (P2 stop c) prevents two
  writers appending to state concurrently.
- **Pickup on a turn that 502'd:** no reply ever comes; the poll runs to its
  bound and stops silently. Bounded, rare, honest.
- **Next 16 API drift** (AGENTS.md): `router.replace` ordering semantics
  verified against `node_modules/next/dist/docs/` at implementation time.

## Verification — named tests (protocol §2)

- **T2** (carried from the latency plan): a seeded autosend visit creates
  **exactly one** conversation; after the reply, reload of `/chat?cid`
  hydrates the thread that holds the messages. (Today: two conversations, and
  the reload shows an empty placeholder.)
- **T3** (carried): a refresh during the in-flight wait does **not** re-send
  the seed (`p`/`autosend` stripped by the `replace` that precedes the send);
  `ctx` still lands on the conversation (stored by `new-session`).
- **T9** (carried, transformed): `/api/chat` stays **lookup-only** — a
  supplied unknown `conversationId` still 404s; no create-if-missing crept
  in. (Records constraint #1 as satisfied by design.)
- **TB1** (new): bootstrap onto a conversation whose last row is a user turn
  *within* the window → pickup activates (`isRunning` true), and when history
  returns the assistant row it is appended and `isRunning` goes false.
- **TB2** (new): last-user-turn *older* than the window → no poll starts;
  an in-window pickup stops at the deadline.
- **TB3** (new): sending a new message during pickup cancels the poll.
- Manual E2E (dev tunnel): home-hub prompt click → exactly one conversation,
  URL `cid` correct after reload; refresh mid-wait → typing indicator
  reappears and the reply surfaces when it lands; bare `/chat` visit
  unchanged; `past_meeting` pin unchanged.
- Gates: `pnpm typecheck && pnpm test && pnpm build`.

## Delivery & order

1. **This plan** → ponytail pass (author-side) → plan PR (the
   `plan-review-request.yml` automation labels it and auto-requests the Codex
   review) → fold rounds as Rev N → approval ⇒ merge.
2. **One implementation PR** (the whole change is small: ~3 lines P1, one
   bounded-pickup hook P2, a trimmed route P3, plus tests) → Codex review →
   squash-merge → Coolify deploys.
3. When AgentGlob SSE lands (issue #19): delete the P2 poll in the streaming
   migration; P1's wiring survives as-is.

## Review asks (invariants to attack)

1. **Exactly-one-conversation:** any path (param matrix × reload timing ×
   strict-mode double effects) where a seeded visit still creates two
   conversations or sends twice?
2. **Contract guard:** does anything here widen `/api/chat` beyond
   lookup-only, or bypass the ownership check?
3. **Pickup bounds:** any way the P2 poll outlives its window, polls without a
   pending turn, or double-appends rows alongside a concurrent send?
4. **`sectionContext` parity:** does `ctx` still reach the conversation and
   the first-turn preamble identically to today in the P1 ordering?
5. **P3 blast radius:** any consumer of `new-session`'s `agentInfo` field or
   its `getAgentInfo()` side effect that the inventory missed?
