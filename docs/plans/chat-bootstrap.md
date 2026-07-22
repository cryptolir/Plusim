# Plusim — chat bootstrap: fix the double-conversation bug + pending-reply pickup

> **Status:** 🔍 **Rev 14 — RE-REVIEW REQUESTED** (plan PR). Codex round 11
> landed 2 P2s, both hardening the P1c render-gate's **failure fallback** (a
> real operational path — `new-session` 401/500): the fallback must trigger on
> non-`res.ok`/missing-id (not just rejected fetch) or the render gate leaves
> the page permanently inert; and the fallback's lazy-create send must sync the
> URL. Both folded. Scope: `/chat` bootstrap only.
>
> **Rev 14 — Codex round 11 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 15 | **Non-OK bootstrap responses don't trigger the fallback** — a 401/500 resolves through `.then(r=>r.json())` without a `conversationId`; with the render gate hiding all affordances, the page stays permanently inert. | The fallback triggers on **any** non-success outcome: rejected fetch, non-`res.ok`, **or** missing `conversationId` → enable the surface in fallback mode. |
> | 16 | **Fallback lazy-create send never reaches the URL** — the `router.replace` lives only in the success callback, so a fallback send leaves the URL on `/chat` and a refresh orphans the thread (the very thing P1c prevents). | The `/chat` page adds an **effect watching the runtime's `conversationId`** → `router.replace(?cid=id)` when it appears (covers the fallback path; no-op on the normal path). |
>
> **Rev 13 — Codex round 10 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 13 | **Gate misses suggestion sends** — the empty thread renders welcome suggestions (`SuggestionPrimitive.Trigger`) that also call `onNew`; disabling only the composer lets a pre-`bootstrapReady` suggestion click fire a null-id send. | The gate is now a **render gate**: while `!bootstrapReady` neither the composer nor the welcome suggestions render — structural coverage of every send entry point. TB5 exercises suggestions. |
> | 14 | **Timestamp ties break the positional completion rule** — history orders by `createdAt` (ms precision); concurrent tabs can tie, making "row immediately after" nondeterministic → wrong reply. | History orders by `(createdAt ASC, id ASC)` (deterministic); a `createdAt` tie adjacent to the captured pending turn is **ambiguous → stop silently** (same conservative fallback). Equal-timestamp TB1 case added. |
>
> **Rev 12 — Codex round 9 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 12 | **Ahead-skew collapses the pickup window** — Rev 2 anchored `remaining` to the browser clock; an ahead-running client clock made a fresh pending turn compute `remaining ≤ 0` → one fetch then stop, so a refresh a few seconds into a real 13–34s send could miss the reply. | Age is derived from **server time only**: `/api/chat/history` returns `serverNow`; `age = serverNow − createdAt`, `remaining = clamp(WINDOW − age, 0, WINDOW)`; UI ticks on a monotonic `performance.now()` delta. No client wall-clock in the age → fresh turns get the full window under either skew direction. TB2 updated. |
>
> **Rev 11 — Codex round 8 resolution + P1c redesign (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 11 | **Cancel-before-id strands the optimistic message** — the `await` runs after `sendMessage` optimistically appends the user row; Stop during the wait (before any `/api/chat` request) leaves an unsent turn + misleading "check recent chats" copy. | **Resolved by the P1c redesign, not another patch:** the guard moves to a **page-level composer lock** (no send can start until `bootstrapReady`), so there is no pre-id optimistic append, no in-`sendMessage` await, and no cancel-during-wait state. Rounds 5–8's whole class of P1c edges is removed. HomeHub's shared runtime is left unchanged; a `new-session` failure degrades to lazy-create, never a dead composer. |
>
> **Rev 10 — cross-app field findings (2026-07-22, PR #22, owner-added):**
>
> Added the chapter **“Cross-app field findings — separate bootstrap resilience
> from agent latency”** from a production Havaya rollout. The evidence strengthens
> P1/P2/P3's resilience case and the rejection of lazy `/chat`, while making
> explicit that bootstrap work does not materially reduce upstream generation
> time. No implementation requirement changed.
>
> **Rev 9 — Codex round 7 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 9 | **P1c's `sendMessage` await breaks HomeHub** — the hook is shared; HomeHub's lazy chat relies on posting `conversationId: null` to create. An unconditional await would hang/break its first send. | The await is **conditional on an actual pending `/chat` bootstrap** (passed as an option; HomeHub passes none → lazy create as today). No-bootstrap regression test added. |
> | 10 | **Stop can't cancel the pre-fetch bootstrap wait** — the await runs before `abortRef` is registered, so a hung `new-session` leaves Stop dead. | The bootstrap-id wait is **raced against the same cancel token** (`onCancel`/`cancelPickup`), so Stop ends it; TB5 covers cancel-before-id. |
>
> **Rev 8 — Codex round 6 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 8 | **Rev 7's callback skip drops the URL sync** — skipping `hydrate`/`replace` when a send started leaves no path writing the minted `cid` to the URL, so a fast-send refresh loses the thread / replays the seed. | The callback skips **only** the clobbering `hydrate([], id)`; it **always** runs `router.replace` to the minted `cid`. Since P1c's awaited send posts to that same minted id, there's one conversation and the URL now matches it. TB5 updated. |
>
> **Rev 7 — Codex round 5 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 7 | **Bare-load fast manual send races the bootstrap** — the composer renders while `new-session` is in flight, so a send with `conversationIdRef` still null creates a *separate* conversation and the callback's `hydrate([], id)` then clobbers it (URL/thread diverge). | **P1c:** `sendMessage` **awaits the pending bootstrap id** when the ref is null and posts with it (single conversation, no composer disabling); the callback also skips `hydrate`/`replace` if a send already started. TB5 guards it. |
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

## Cross-app field findings — separate bootstrap resilience from agent latency

A production Havaya rollout on 2026-07-22 provides a useful control case for
this plan. Havaya and Plusim use the same basic shape: a Next.js chat proxy
persists the user turn, waits on AgentGlob's synchronous JSON endpoint, then
persists and returns the assistant turn. Havaya applied the obvious app-side
latency work first: explicit-only Drive context with a 1.5s bound, a smaller
hidden context, lazy blank-chat creation, an existence lookup instead of a
message count, parallel post-agent writes, and structured stage timings. It
also pinned interactive chat to `gpt-5.6`.

### Production timing evidence

Four consecutive production turns produced this breakdown:

| Turn | Auth | Pre-agent DB/request | Context | AgentGlob | Post-agent DB | Total |
|---|---:|---:|---:|---:|---:|---:|
| First | 12ms | 32ms | 0ms | 19,659ms | 22ms | 19,724ms |
| Follow-up 1 | 1ms | 6ms | 0ms | 23,797ms | 4ms | 23,808ms |
| Follow-up 2 | 2ms | 6ms | 0ms | 12,678ms | 5ms | 12,691ms |
| Follow-up 3 | 1ms | 5ms | 0ms | 33,811ms | 4ms | 33,821ms |

All four turns had `hasContext: false`. Non-agent application work was only
10–66ms; AgentGlob consumed more than 99.6% of total request time. A separate
minimal `gpt-5.6` smoke prompt returned in 5.07s, so the 12.7–33.8s production
range is not explained by Havaya's auth, database, Drive context, or route
bookkeeping. The remaining variance is inside the upstream agent/model path
(model generation, reasoning, tool/skill loading, queueing, or network time
that AgentGlob owns).

### What transfers from this plan

- **P1 + P1c transfer as correctness requirements.** A stable server-minted
  conversation id must reach the runtime and URL before the long synchronous
  send. Havaya's lazy `/chat` removed a tiny setup round trip but also left no
  `cid` during the 13–34s wait; a refresh cannot identify and resume the
  pending conversation. Saving milliseconds is not worth losing continuity.
- **P2 transfers directly.** Bounded pending-reply pickup does not make the
  model finish sooner, but it makes refresh/reopen during a long call reliable,
  keeps the wait cancelable, and surfaces the persisted reply without a resend.
- **P1b transfers with placeholders.** If the user row persists and the first
  upstream call fails, a retry is no longer the first message. Title fill must
  therefore be null-guarded and DB-atomic, not gated only on
  `isFirstMessage`.
- **P3 transfers as a clean bootstrap trim.** Removing discarded agent metadata
  from `new-session` avoids an unnecessary external dependency on the setup
  path. It is worthwhile, but the measured evidence says to expect a resilience
  and tail-risk improvement—not seconds of generation-time savings.
- **The rejection of lazy `/chat` is strengthened.** When upstream work is
  measured in tens of seconds and local setup in tens of milliseconds, minting
  the recoverable conversation first is the better trade.

### What does not materially reduce answer time

Once stage timings show that the agent owns more than ~90% of the wall clock,
further micro-optimizing Prisma calls, title writes, context-free bootstrap, or
URL updates cannot solve a “slow reply” report. Those changes can reduce local
tail latency and failure surface, but they should not be presented as making
the agent itself faster. Likewise, polling/queued delivery improves continuity
and perceived responsiveness; it does not shorten completion time.

The actual latency levers are upstream:

1. **Real streaming (SSE or an equivalent resumable stream) from AgentGlob** so
   the first tokens render before the full JSON reply completes.
2. **Agent-side fast paths** that answer ordinary conversation without loading
   tools/skills, reserving expensive reasoning and tool execution for turns that
   need them.
3. **A faster model or lower reasoning setting** when product requirements allow
   it; pinning a capable model alone does not guarantee low latency.
4. **Hybrid routing**: stream simple turns directly through the model provider
   and send only memory/tool-dependent turns through AgentGlob. This trades
   architectural simplicity for actual latency control.

### Reusable decision rule for similar apps

Instrument before redesigning. Record at least `authMs`,
`dbBeforeAgentMs`, `contextMs`, `agentMs`, `dbAfterAgentMs`, and
`totalMs`, plus first-turn/context/model flags. Then:

- if local/context time dominates, cache or bound that dependency;
- if AgentGlob dominates, prioritize streaming, model/reasoning policy, and
  tool routing;
- regardless of which stage dominates, a synchronous endpoint still needs a
  stable pre-send conversation id and bounded pending-reply recovery.

This separates two goals that should not be conflated: **bootstrap work makes a
long request recoverable; upstream work makes the answer arrive sooner.**

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| `hydrate(rows, cid)` (`plusimRuntime.ts:167-168`) — sets `conversationIdRef` + state | **The bug fix is calling it.** `hydrate([], cid)` wires the minted id into the runtime before the seeded send |
| `bootstrapped` ref (`chat/page.tsx:22-26`) | Strict-mode double-effect safety — kept as-is |
| `ThinkingIndicator` + 15s caption (`thread.tsx`, latency A1), driven by `isRunning` | P2's pickup sets `isRunning` → the wait **UI** is free (the hook surface to set it is new — see P2) |
| `AGENT_TIMEOUT_MS` / `CHAT_CLIENT_TIMEOUT_MS` (`chatTimeouts.ts`) | P2's pickup bound derives from the same constants — no new magic numbers |
| `/api/chat/history` (returns rows with `role` + `createdAt`) | P2 polls it; the pending state is "last row is a user turn". **Rev 12:** add a `serverNow` field (server-anchored pickup age). **Rev 13:** order by `(createdAt ASC, id ASC)` for a deterministic sequence under ms-tie |
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

**P1c — lock the bare-load composer until the minted id is installed (Rev 11 —
redesign after the P1c recursion; owner-directed to keep the protection).**
The bare-load race is real: on a bare `/chat` load (no `cid`, no autosend) the
composer renders while `new-session` is in flight, so a send with
`conversationIdRef` still null would create a *separate* conversation whose
`cid` isn't in the URL during the long (13–34s, per Rev 10 field data) wait — a
mid-wait refresh then can't resume it. The owner's Rev 10 evidence makes this a
**correctness requirement**, so we keep the protection — but move the guard
**off the shared runtime and onto the `/chat` page**.

Rev 7–9 put a pending-id **await inside the shared `sendMessage`**, and that one
choice spawned four consecutive review rounds — it leaked into the URL sync
(round 6), HomeHub's lazy send (round 7), the Stop path (round 7), and the
optimistic-append/cancel window (round 8) — because the guard lived on a shared,
optimistic-append send path. The redesign removes that entire class:

- **Invariant:** on a bare `/chat` load, **no send can be initiated from ANY
  entry point until the server-minted `cid` is installed in the runtime and the
  URL.** The `/chat` page tracks `bootstrapReady` (false until `new-session`
  resolves, `hydrate([], id)` installs the id, and `router.replace(?cid=id)`
  runs). Because nothing can send before the id exists, there is no null-id send
  and nothing to clobber — the callback simply does its normal `hydrate([], id)`
  + `replace`. The await, the "skip hydrate/replace if a send started", the
  cancel-during-wait state, and the optimistic-append orphan (rounds 5–8) **all
  dissolve**.
- **The gate covers EVERY send entry point, not just the composer (Rev 13,
  Codex round 10).** The empty thread renders welcome **suggestions**
  (`ThreadWelcome` → `ThreadSuggestions` → `SuggestionPrimitive.Trigger send`,
  `thread.tsx:168-187`) — a second send path that also calls `onNew`. Disabling
  only the composer would let a suggestion click before `bootstrapReady` fire a
  null-id send. So the gate is a **render gate**: while `!bootstrapReady` the
  `/chat` page does not render the interactive send surface at all — **neither
  the composer nor the welcome suggestions** (a brief placeholder in their
  place). This is structural (no active affordance exists), so it covers the
  two known entry points *and* any future one, with no per-component
  whack-a-mole. TB5 exercises the suggestion path too.
- **HomeHub is untouched.** The gate is page-level; `usePlusimRuntime` gains
  **no** await and no bootstrap-promise option, so HomeHub's lazy chat
  (`usePlusimRuntime({})`, first send posts `conversationId: null`) is exactly
  as today — no shared send-path change, no special-case needed.
- **Seeded autosend unaffected.** The `p`/`autosend` flow fires
  `sendMessage(seed)` from the callback *after* `bootstrapReady`, and it is a
  programmatic send, so the brief disabled state never blocks it.
- **Failure fallback covers ALL non-success outcomes (Rev 14, Codex round 11).**
  The render gate hides every send affordance until `bootstrapReady`, so
  `bootstrapReady` MUST flip true on every terminal outcome or the page is
  permanently inert. The fallback triggers on **any** of: a rejected `fetch`
  (network), a **non-`res.ok`** response (401/500 still resolve through
  `.then(r => r.json())`), or a **missing `conversationId`** in the body — not
  just the `.catch` path. Any of these → enable the surface in **fallback
  mode** (no `hydrate`/`replace`; the first send lazy-creates with
  `conversationId: null` → `/api/chat` creates). Never a permanently-inert page.
- **The fallback (lazy-create) send MUST sync the URL (Rev 14, Codex round 11).**
  On the fallback path the send posts `conversationId: null` and the runtime
  stores the returned id in hook state only; the page's `router.replace` lives
  in the *success* callback, which didn't run. Without a URL sync the address
  bar stays `/chat`, so a refresh during/after the fallback send orphans the
  thread — the exact no-`cid` long-send problem P1c exists to prevent. Fix: the
  `/chat` page adds a small **effect watching the runtime's `conversationId`**
  — when it becomes non-null and the URL has no matching `cid`,
  `router.replace(?cid=<id>)`. This covers the fallback path (and is a no-op on
  the normal path, where the callback already set the URL).
- **Window:** `new-session` is one DB insert + prune (P3 also drops the
  `getAgentInfo` await), so the disabled flash is typically sub-100ms.

Guards TB5.

**P2 — bounded pending-reply pickup (constraint #2), implemented INSIDE
`usePlusimRuntime` (Rev 2).** The hook exports exactly
`{ runtime, hydrate, reset, sendMessage, conversationId, isRunning }`
(`plusimRuntime.ts:188`) — there is **no** external setter for `isRunning` or
the message list, so the pickup cannot be driven from the page; it is new hook
surface, named honestly: a `resumePendingReply(rows, cid)` path (or `hydrate`
detecting it) that lives next to `setIsRunning`/`setMessages`/`onCancel`.
Behavior, on the `?cid` bootstrap when the **last hydrated row is a user
turn**:

- **Window (SERVER-anchored age — Rev 2 → Rev 12, Codex):** the reply can land
  within the server ceiling of the user turn, but `createdAt` is DB-server
  clock. Rev 2 anchored the initial `remaining` to the **browser** clock
  (`clientNowAtBootstrap`), which a clamp only fixed for *behind*-skew — an
  *ahead*-running browser clock made a genuinely-fresh pending turn compute
  `remaining ≤ 0` and collapse to a single fetch, so a refresh a few seconds
  into a real 13–34s send could miss the reply. Fix: derive the age from
  **server time only**. `/api/chat/history` returns a `serverNow` field (its
  own `new Date()`); then
  `age = serverNow − pendingTurn.createdAt` (both DB-server clock, skew-free)
  and `remaining = clamp(CHAT_CLIENT_TIMEOUT_MS − age, 0, CHAT_CLIENT_TIMEOUT_MS)`.
  Count *down* on `performance.now()` for the UI tick (a monotonic delta, not a
  wall-clock read). A truly stale turn (`age ≥ window`) → `remaining 0` → no
  poll; a fresh turn gets its full remaining window regardless of browser-clock
  skew in either direction. No client wall-clock enters the age.
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
  reply; the real reply shows on the next `?cid` load, exactly as today).
  **Adjacency needs a deterministic order, and a timestamp tie is ambiguous
  (Rev 13, Codex round 10):** `/api/chat/history` orders solely by
  `createdAt`, which is millisecond precision, so concurrent tabs can produce
  two rows with the **same** `createdAt` and the "row immediately after" is
  nondeterministic (could be another tab's assistant). Fix: (i) history orders
  by `(createdAt ASC, id ASC)` for a stable, deterministic sequence; (ii) but a
  stable order still doesn't reveal true insertion order under a tie, so if the
  captured pending turn's `createdAt` is **tied** with an adjacent row (the
  candidate successor or any row sharing its timestamp), treat adjacency as
  **ambiguous → stop silently** (same conservative fallback as the intervening
  user row). Only an unambiguous, strictly-later adjacent assistant completes.
  On completion → wholesale `hydrate(allRows, cid)` replace (idempotent — no
  append/dedupe), `isRunning = false`. This ends the multi-tab ambiguity
  instead of chasing it: single-tab (the overwhelming case) is exact; the rare
  concurrent-multi-tab case (including timestamp ties) degrades to today's
  reopen behavior, never to a wrong or hung state.
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
- **Clock skew (Rev 12):** the P2 window age is computed from **server time
  only** (`serverNow − createdAt`, both from the history response), so neither
  browser-clock direction can shrink or extend the window; the UI ticks down on
  a monotonic `performance.now()` delta. No client wall-clock touches the age.
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
  immediately following the captured pending turn completes (Codex rounds 1–3).
  **Equal-timestamp case (Rev 13):** a row sharing the pending turn's exact
  `createdAt` (concurrent-tab tie) ⇒ adjacency ambiguous ⇒ **stop silently**,
  never hydrate on a tie.
  TB2 — **server-anchored age (Rev 12):** `age = serverNow − createdAt` from the
  history response, so a fresh turn gets its full window under **either**
  browser-clock skew direction (ahead-skew no longer collapses to one fetch);
  a stale turn (`age ≥ window`) ⇒ `remaining 0` ⇒ no poll; deadline ⇒ spinner
  (`isRunning`) cleared even if the final fetch never settles, **but a final
  fetch resolving just after the deadline with the reply still hydrates the
  transcript** (Codex round 2). TB3 — cancel (user cancel or new send) ⇒ poll
  stops, `isRunning` false, in-flight final fetch discarded.
- **TB4** (new, automated — guards P1b): a null-title conversation is titled
  by **any** successful turn (not just the first); an existing title is never
  overwritten; and the write is **atomic** — the `updateMany` carries
  `where: { title: null }`, so a second overlapping request that read the
  stale null row updates zero rows (stale-null race → exactly one title,
  never clobbered). (`bookkeeping.test.ts` T4/T4b stay green with `update` →
  `updateMany`.)
- **TB5** (P1c — page-level render gate, Rev 11 → Rev 13): while
  `bootstrapReady` is false **no send entry point is active — neither the
  composer NOR the welcome suggestions** (`SuggestionPrimitive.Trigger`), so no
  send fires without a `cid` (one conversation, no null-id create, no clobber)
  **whether the user uses the composer or clicks a suggestion**; once
  `new-session` resolves + `hydrate` + `replace` run, `bootstrapReady` flips
  true and both paths proceed; **every non-success `new-session` outcome**
  (rejected fetch, non-`res.ok`, or missing `conversationId`) re-enables the
  surface in fallback mode and the first send lazy-creates
  (`conversationId: null`), never a permanently inert surface; **the fallback
  send's returned id is synced to the URL** via the page's `conversationId`
  effect (a refresh after a fallback send resumes the thread); **HomeHub's
  runtime is unchanged** (posts `null`, lazy-creates as today). (Render-gate +
  suggestion coverage are manual E2E; the ready/error/fallback-URL-sync
  transitions are unit-tested.)
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
