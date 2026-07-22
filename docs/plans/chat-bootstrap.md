# Plusim — chat bootstrap: fix the double-conversation bug + pending-reply pickup

> **Status:** 🔍 **Rev 6 — RE-REVIEW REQUESTED** (plan PR). Codex round 4
> landed 1 P2 — in a **different** area (P1b title write), i.e. the multi-tab
> pickup thread **terminated** at Rev 5 (all 5 prior threads outdated). Round 4
> is the circuit-breaker threshold; folded with the owner flagged, since the
> churning thread converged and this was a distinct, trivial atomic-update fix
> (not the non-convergence the breaker guards). Scope: `/chat` bootstrap only.
>
> **Rev 6 — Codex round 4 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 6 | **P1b title fill isn't concurrency-safe** — the `!conversation.title` check reads the request-start row, so two overlapping `/api/chat` requests on a null-title conversation both write and the later overwrites the first, violating "existing title never overwritten". | The fill becomes DB-atomic: `updateMany({ where: { id, title: null }, data: { title } })` — the `title: null` filter enforces first-writer-wins; the second request updates zero rows. In-memory check stays as an early-out. TB4 adds the stale-null race. |
>
> **Rev 5 — Codex round 3 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 5 | **"Any assistant after the pending turn" still stops on the wrong reply** — `/api/chat` writes the user row before its agent call and the assistant after, so a concurrent tab produces `pendingUser, laterUser, laterAssistant`; the captured turn is still unanswered but `laterAssistant` satisfies the predicate. Root cause: no user→reply linkage in the schema. | **Terminal rule:** completion = the row **immediately after** the captured pending turn is an assistant (its adjacent reply). An intervening **user** row ⇒ stop silently, fall back to reopen (never hydrate a wrong reply). Multi-tab-concurrent pickup is now an **explicit best-effort non-goal** — exact single-tab, safe degrade otherwise; making it exact needs a schema reply-linkage column (out of scope, moot under streaming). |
>
> **Rev 4 — Codex round 2 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 3 | **"Any row after the pending id" completes too eagerly** — a second tab/device appending another *user* row to the same conversation would satisfy it and stop the pickup before the reply exists. | Completion now requires an **`assistant` row after the pending turn**; a trailing *user* row (multi-tab) keeps polling. |
> | 4 | **Bounded final fetch drops the last-interval reply** — a reply written just before the deadline resolves ~1 RTT *after* it; Rev 3 ignored that late response, reintroducing the miss the final fetch exists to close. | Split concerns: the **spinner** is bounded (`isRunning` cleared at the deadline regardless), but the final fetch's **result still hydrates** if it returns the reply just after the deadline. Only cancel / a new send discards it. |
>
> **Rev 3 — Codex round 1 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 1 | **"Any assistant row" completes the pickup wrongly** — a multi-turn history already has older assistant rows, so the first poll stops instantly and re-hydrates the still-pending transcript; the new reply stays invisible. | Completion is now **keyed to the captured pending user turn** (last row is no longer that turn / a row exists after its id), not "an assistant row exists". Mixed-history case added to TB1. |
> | 2 | **The final deadline fetch is unbounded** — a hung final `/api/chat/history` request holds `isRunning` past the window, breaking the bounded-pickup invariant. | The final fetch carries its own `AbortSignal.timeout`, **and** `isRunning` is cleared at the deadline regardless of whether it settles; a late response is ignored. TB2 covers it. |
>
> **Review log:**
> **Rev 1** — initial draft.
> **Rev 2** — internal pre-review folded (author-run ponytail + correctness
> passes; *not* the external Codex round). **P1-blocker fixed:** while pickup
> holds `isRunning`, the composer swaps Send for a **Stop button**
> (`thread.tsx:213-218`) whose `onCancel` only aborts `abortRef` — null during
> pickup → dead button, user locked into an unstoppable 95s thinking state.
> Pickup now lives **inside `usePlusimRuntime`** with one shared cancel path
> wired to `onCancel` + `sendMessage`. **P2s fixed:** the pickup's runtime
> surface is now named (it needs `setIsRunning`/`setMessages`, which the hook
> does not export — the plan no longer pretends it's pure reuse); the deadline
> is client-anchored + clamped (server `createdAt` vs browser clock skew can't
> extend or skip the window); a **final history fetch at the deadline** closes
> the last-interval miss; and the C3 title condition loses `isFirstMessage &&`
> (with P1 the seeded flow titles via that best-effort path, which a failed
> first turn made unreachable forever — fill whenever title is null instead).
> **Ponytail:** T2/T3 → manual E2E only and TB1-3 → pure-function tests (the
> repo has no component-test infra; building it would dwarf the change); row
> "append" → wholesale `hydrate(allRows, cid)` replace (idempotent, zero merge
> code); notes added (unread-dot needs no client work — the route's own view
> upsert covers it; P3 moves `getAgentInfo`'s cache-warming to the avatar
> request; pre-existing seed-drop race documented). **Verified in our favor:**
> `cacheComponents` is off and a same-path searchParams `replace` re-renders
> in place (vendored Next 16 docs) — `bootstrapped`, the minted cid, and
> in-flight state all survive P1's `router.replace`; P1 is safe as specced.

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
| `ThinkingIndicator` + 15s caption (`thread.tsx`, latency A1), driven by `isRunning` | P2's pickup sets `isRunning` → the wait **UI** is free (the hook surface to set it is new — see P2) |
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
and the first-turn preamble reads the **conversation row's** stored
`sectionContext` on the lookup branch (`route.ts:131`) — `past_meeting`
unchanged. Remount safety verified (Rev 2): `cacheComponents` is off and a
same-path searchParams `replace` re-renders the client component in place
(vendored `use-search-params.md`), so `bootstrapped`, the minted cid, and any
in-flight state survive the `replace`.

**P1b — title correctness under P1 (Rev 2, correctness pass).** `new-session`
creates title-null rows, and with P1 the seeded send takes `/api/chat`'s
lookup branch — so the create-branch title (`route.ts:105`) never runs and the
seeded conversation titles only via the C3 conditional
`if (isFirstMessage && !conversation.title)` (`route.ts:206`). That's
best-effort **and unreachable after a failed first turn**: the user message
persists before a 502, so the retry sees `_count.messages = 1` →
`isFirstMessage` false → **permanently null title** in the recent list. Fix:
drop `isFirstMessage &&` — fill whenever `title` is null, from whatever turn
finally succeeds.

**The fill must be ATOMIC (Rev 6, Codex round 4).** The `!conversation.title`
check reads the row loaded at request start; two overlapping `/api/chat`
requests on a still-null-title conversation would both see null and both
write, the later finishing one overwriting the first — violating "existing
title is never overwritten". So the write is a DB-atomic guard:
`db.conversation.updateMany({ where: { id, title: null }, data: { title } })`
(the `where: { title: null }` is what actually enforces first-writer-wins;
the second request's filter matches zero rows). The in-memory
`!conversation.title` stays only as a cheap early-out. `bookkeeping.test.ts`
T4/T4b stay green (mocks move `update` → `updateMany`); TB4 adds the stale-null
race (two overlapping fills → exactly one title, never overwritten).

**P2 — bounded pending-reply pickup (constraint #2), implemented INSIDE
`usePlusimRuntime` (Rev 2).** The hook exports exactly
`{ runtime, hydrate, reset, sendMessage, conversationId, isRunning }`
(`plusimRuntime.ts:188`) — there is **no** external setter for `isRunning` or
the message list, so the pickup cannot be driven from the page; it is new hook
surface, named honestly: a `resumePendingReply(rows, cid)` path (or `hydrate`
detecting it) that lives next to `setIsRunning`/`setMessages`/`onCancel`.
Behavior, on the `?cid` bootstrap when the **last hydrated row is a user
turn**:

- **Window (client-anchored, skew-proof — Rev 2):** the reply can only land
  within the server ceiling of the user turn, but `createdAt` is DB-server
  clock and the countdown runs on the browser clock. So: compute
  `remaining = clamp(userTurn.createdAt + CHAT_CLIENT_TIMEOUT_MS − clientNowAtBootstrap, 0, CHAT_CLIENT_TIMEOUT_MS)`
  once, then count down on `performance.now()`. The clamp caps behind-skew
  overrun at one window; if `remaining` is ~0/negative (stale turn or
  ahead-skew), do **one immediate history re-fetch, then stop** — never skip
  entirely, never poll longer than one window.
- **Completion requires an ASSISTANT row after the pending turn (Rev 3 →
  Rev 4, Codex P2):** a multi-turn history already contains **older**
  assistant rows, so "an assistant row exists" is wrong (first poll stops
  instantly on a stale transcript). But "any row after the captured pending
  id" is **also** wrong (Rev 4): a second tab/device can append **another
  user** row to the same conversation via `/api/chat`, and that would satisfy
  "a row after the pending id" and stop the pickup before the reply exists.
  **Terminal rule (Rev 5, Codex round 3):** the message schema has **no
  user→reply linkage** (`Message` is `role`/`content`/`createdAt` only), and
  `/api/chat` writes each user row *before* its agent call and the assistant
  *after* (`route.ts:113-119`, `:187-194`), so a concurrent multi-tab turn can
  interleave as `pendingUser, laterUser, laterAssistant` where `laterAssistant`
  is **not** the captured turn's reply — "any assistant after the pending turn"
  is unresolvable in general. So define completion **positionally and
  conservatively**: capture the pending user turn's `id` at bootstrap;
  **completion = the row *immediately after* the captured pending turn is an
  `assistant` row** (its reply, adjacent, no intervening row). If the row
  immediately after it is a **user** row (a concurrent tab intervened), the
  captured turn's reply cannot be identified from the transcript → **stop the
  pickup silently** and fall back to normal reopen (never hydrate a wrong
  reply; the real reply shows on the next `?cid` load, exactly as today). On
  completion → wholesale `hydrate(allRows, cid)` replace (idempotent — no
  append/dedupe), `isRunning = false`. This ends the multi-tab ambiguity
  instead of chasing it: single-tab (the overwhelming case) is exact; the rare
  concurrent-multi-tab case degrades to today's reopen behavior, never to a
  wrong or hung state.
- **While in the window:** `isRunning = true` (the typing indicator + 15s
  caption render for free, `thread.tsx:83-85`), re-fetch `/api/chat/history`
  every ~5s and apply the completion check above.
- **Final fetch at the deadline — bounded spinner, but it STILL hydrates
  (Rev 3 → Rev 4, Codex P2):** separate two concerns. (a) The **spinner** is
  bounded: `isRunning` is cleared at the deadline **regardless** of whether
  the final fetch has settled, so a hung history request can't hold the UI
  open (the final fetch carries its own `AbortSignal.timeout`). (b) The final
  fetch's **result still hydrates**: a reply written just before the deadline
  resolves ~1 RTT *after* it, so the final fetch's response — if it shows an
  assistant row after the pending turn — is applied via `hydrate(allRows,
  cid)` **even though the spinner already stopped**. Only a pickup ended by
  **cancel / a new send** (below) discards its in-flight result. This is the
  whole point of the final fetch (catching the last-interval reply); dropping
  its result would reintroduce the miss it exists to close.
- **One shared cancel path (Rev 2 — fixes the pre-review P1-blocker):** while
  `isRunning` is true the composer shows the **Stop button**
  (`thread.tsx:213-218`), whose `onCancel` today only does
  `abortRef.current?.abort()` (`plusimRuntime.ts:147-149`) — null during
  pickup ⇒ dead button, user locked into an unstoppable 95s thinking state.
  The pickup registers a `cancelPickup()` that `onCancel` **and** the top of
  `sendMessage` both call (Enter-key submits can reach `onNew` even while
  Send is hidden): stop the poll, `isRunning = false`, **and abort/ignore any
  in-flight final fetch** (a new send owns the transcript now — this is the
  only path that discards the final fetch's result). Stops are therefore:
  (a) assistant row after the pending turn arrives; (b) deadline — spinner
  stops but the bounded final fetch may still hydrate a last-interval reply;
  no speculative error copy for a failure we didn't observe; (c) user cancels
  or a new send starts.
- The poll is **conditional** (only when a pending turn is detected at
  bootstrap) and **bounded** (≤ one window) — not a background poller.
  **Unread-dot needs no client work:** `/api/chat`'s own turn bookkeeping
  upserts the view row after the reply write (`route.ts:212-223`), so a
  pickup-surfaced reply never leaves a stale dot. When AgentGlob ships SSE
  (issue #19), this pickup is replaced by stream-resume and deleted.

**P3 — `shrink:` the bootstrap round trip.** `new-session` awaits
`getAgentInfo()` (an external call on cold cache) and returns `agentInfo`
that its only caller discards (`chat/page.tsx:50` destructures nothing but
`conversationId`; avatars use `/api/chat/agent-info`; no test touches the
route). Delete the await and the response field. One honest side effect
(Rev 2): today's call pre-warms the 5-min in-process `agentInfoCache`
(`agentglob.ts:57-77`) for the avatar fetch moments later — deleting it moves
that cold external call onto the avatar's own request, which has its own
error handling. The prune stays (still needed for bare-visit placeholders).

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
- **Perfect multi-tab-concurrent pickup (Rev 5, explicit).** With no
  user→reply linkage in the schema, a conversation being sent to from a second
  tab *while* this tab is in a reload-pickup cannot have its specific reply
  disambiguated. The pickup is **best-effort**: exact for the single-tab case,
  and in the concurrent-multi-tab case it stops silently and falls back to
  normal reopen — never a wrong reply, never a hang. Making it exact would need
  a reply-linkage column (a schema change), which is out of scope here and
  moot once streaming (issue #19) resumes the specific stream directly.

## Risks / contingencies

- **Strict-mode double effects:** the existing `bootstrapped` ref guards the
  whole `.then` — `hydrate`/`replace`/`send` run once. Unchanged.
- **Refresh between mount and the `new-session` response:** nothing was sent;
  the seed params re-fire on the new load and a fresh placeholder is minted
  (the old one is pruned later). Same as today; harmless.
- **Refresh after `replace` but before the send's user row persists (Rev 2):**
  the seed is dropped silently (params already stripped, nothing pending on
  reload). This window exists **identically today** — never-resend >
  maybe-drop is the T3 trade; documented, not changed.
- **Clock skew (Rev 2):** the P2 window is computed once against the client
  clock and clamped to one window on a monotonic countdown — behind-skew
  can't extend the poll past one window; ahead-skew degrades to one immediate
  fetch, never to a skipped pickup.
- **Title regression without P1b:** P1 alone silently demotes seeded-flow
  titling to an unreachable-after-failure path — P1b (drop
  `isFirstMessage &&`) ships in the same PR, guarded by TB4.
- **`hydrate([], cid)` clears message state:** at this point in the bootstrap
  there are no messages in state — it only sets the id. T2 covers the flow.
- **Pickup vs. a mid-pickup send:** cancel-on-send (P2 stop c) prevents two
  writers appending to state concurrently.
- **Pickup on a turn that 502'd:** no reply ever comes; the poll runs to its
  bound and stops silently. Bounded, rare, honest.
- **Next 16 API drift** (AGENTS.md): `router.replace` ordering semantics
  verified against `node_modules/next/dist/docs/` at implementation time.

## Verification — named tests (protocol §2)

**Test-infra boundary (Rev 2, stated explicitly):** the repo's vitest runs in
`environment: "node"` with no jsdom/@testing-library — there is **no**
component-test infra, and building it would dwarf this change. Client
effect-ordering behavior (T2/T3) is therefore **manual E2E**; the pickup's
decision logic is **extracted as a pure function** so TB1–TB3 run in the
existing node-env suite. The implementation PR must not be reviewed against
phantom component tests.

- **T2** (carried; manual E2E): a seeded autosend visit creates **exactly
  one** conversation; after the reply, reload of `/chat?cid` hydrates the
  thread that holds the messages. (Today: two conversations, and the reload
  shows an empty placeholder.)
- **T3** (carried; manual E2E): a refresh during the in-flight wait does
  **not** re-send the seed (`p`/`autosend` stripped by the `replace` that
  precedes the send); `ctx` still lands (stored by `new-session`).
- **T9** (carried, transformed; automated route test): `/api/chat` stays
  **lookup-only** — a supplied unknown `conversationId` still 404s; no
  create-if-missing crept in. (Records constraint #1 as satisfied by design;
  no existing test asserts this today.)
- **TB1–TB3** (automated, against the extracted pure decision function):
  TB1 — last-row-user within the window ⇒ pickup with the clamped remaining
  time; **completion = the row immediately after the captured pending turn is
  an assistant** (Rev 5): a **mixed history** with older assistant rows ⇒ not
  complete; `pendingUser, laterUser, laterAssistant` (concurrent multi-tab)
  ⇒ **not** complete — the immediate successor is a user row ⇒ **stop silently**
  (fall back to reopen, never hydrate `laterAssistant`); only an assistant row
  immediately following the captured pending turn completes (Codex rounds 1–3). TB2 — stale turn / ahead-skew ⇒ exactly one immediate
  fetch then stop; behind-skew ⇒ remaining clamped to one window; deadline ⇒
  spinner (`isRunning`) cleared even if the final fetch never settles, **but a
  final fetch resolving just after the deadline with the reply still hydrates
  the transcript** (Codex round 2). TB3 — cancel (user cancel or new send) ⇒
  poll stops, `isRunning` false, in-flight final fetch discarded.
- **TB4** (new, automated — guards P1b): a null-title conversation is titled
  by **any** successful turn (not just the first); an existing title is never
  overwritten; and the write is **atomic** — the `updateMany` carries
  `where: { title: null }`, so a second overlapping request that read the
  stale null row updates zero rows (stale-null race → exactly one title,
  never clobbered). (`bookkeeping.test.ts` T4/T4b stay green with `update` →
  `updateMany`.)
- Manual E2E (dev tunnel): home-hub prompt click → exactly one conversation,
  URL `cid` correct after reload; refresh mid-wait → typing indicator
  reappears, **Stop button actually stops it**, and the reply surfaces when
  it lands; bare `/chat` visit unchanged; `past_meeting` pin unchanged;
  failed-first-turn retry ends with a titled conversation (P1b).
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
3. **Pickup bounds + cancel:** any way the P2 poll outlives its clamped
   window, runs without a pending turn, clobbers an in-flight send's state,
   or leaves the Stop button / a new send unable to end it?
4. **`sectionContext` + title parity:** does `ctx` still reach the first-turn
   preamble identically in the P1 ordering, and does P1b's relaxed title
   condition (`!title` without `isFirstMessage`) have any unwanted writer or
   overwrite case?
5. **P3 blast radius:** any consumer of `new-session`'s `agentInfo` field or
   its cache-warming side effect that the inventory missed?
