# Plusim — chat bootstrap: fix the double-conversation bug + pending-reply pickup

> **Status:** 🔍 **Rev 23 — RE-REVIEW REQUESTED** (plan PR). Codex round 20
> closed the last transcript-clobber path: a `/chat?cid` open renders immediately
> (Rev 17), but its **initial** `/api/chat/history` hydrate is still in flight,
> and Rev 20's cancel token only covered *pickup* polls. A slow history load +
> a fast manual send let the stale initial response wholesale-`hydrate` over the
> just-started turn. Fixed without regressing Rev 17's immediate render: the
> **send action** on the `?cid` path is inert until the initial hydrate settles
> (fast list query; error → sends enable, never strands), **and** the initial
> fetch joins the same abort/generation token as the pickup fetches — so no
> history fetch (initial, interval, or final) can clobber a started turn. Scope:
> `/chat` bootstrap only.
>
> **Rev 23 — Codex round 20 resolution (2026-07-22, PR #22):**
>
> | # | Codex | Resolution |
> |---|---|---|
> | 28 | **Initial `?cid` history hydrate can clobber a fast new turn** — making the `?cid` path interactive immediately (Rev 17) lets a send fire before the initial `/api/chat/history` fetch resolves; that fetch's wholesale `hydrate(data.messages, cidParam)` then replaces the optimistic transcript and drops the just-started turn. Rev 20's cancel covered only pickup polls. | Render stays immediate; the **send action** (composer + suggestions) is inert until the initial hydrate settles (resolves/errors — error still enables, never strands), **and** the initial fetch joins the **same abort/generation token** as pickup fetches, so a late response is ignored. Prior history *and* the new turn both survive (send appends onto loaded history). TB6 covers send-before-initial-hydrate. |
>
> **Rev 22 — Codex round 19 resolution (2026-07-22, PR #22):**
>
> | # | Codex | Resolution |
> |---|---|---|
> | 26 | **Failed retry loses first-turn `past_meeting`/Drive context** — the preamble is gated on `isFirstMessage` (zero messages), but a first turn that 502s leaves an orphan user row, so the retry (`_count = 1`) skips the context on the first successful agent call; the plan's "`past_meeting` unchanged" invariant is false in this case. | **P1d:** gate the first-turn preamble on **"no assistant reply persisted yet"** (a role-filtered `_count` of `assistant` rows), not "no messages" — the exact analog of P1b's title fix. A failed-then-retried first turn re-injects context; normal 2nd+ turns and mid-conversation retries do not. T1 stays green; T1b covers the orphan-row retry. |
> | 27 | **Rev 21 guard stops pickup on a single-tab failed retry** — an orphan `U1` from a 502 plus a pending `U2` trips the predecessor guard, so `U2`'s reply isn't auto-surfaced on a mid-wait refresh; not the multi-tab non-goal. | **Accepted, guard kept.** At reload the orphan-retry and the multi-tab case are positionally identical (`U1, U2, …`) and indistinguishable without user→reply linkage; reverting the guard would reintroduce the multi-tab **wrong-reply** hydrate (strictly worse). The reply is never lost (shows on reopen), and P1d ensures the retry still gets correct context — only the auto-surface degrades. Documented in Non-goals as the "≥2 trailing unanswered turns" best-effort limit. |
>
> **Rev 21 — Codex round 18 resolution (2026-07-22, PR #22):**
>
> | # | Codex | Resolution |
> |---|---|---|
> | 25 | **Completion rule ignores an earlier unanswered turn** — the guard rejects a user row *after* the captured pending turn but not one *before* it; with two concurrent pending turns (`U1, U2`), `U1`'s reply landing first (`U1, U2, A1`) makes the "row immediately after `U2`" an assistant that is actually `U1`'s reply → hydrates the wrong reply and stops while `U2` is still pending. | Symmetric guard: the pickup proceeds **only when the captured pending turn is the sole trailing unanswered turn** — its immediate predecessor is an `assistant` row (or it is the first row). An earlier unanswered **user** row ⇒ adjacency ambiguous ⇒ **stop silently** (same conservative fallback). TB1 adds the `U1, U2, A1` case. |
>
> **Rev 20 — Codex round 17 resolution (2026-07-22, PR #22):**
>
> | # | Codex | Resolution |
> |---|---|---|
> | 23 | **Cancel only bounds the *final* pickup fetch** — a regular 5s `/api/chat/history` poll already in flight when the user cancels / starts a new send can resolve after `sendMessage` appended the new optimistic row and run `hydrate(allRows, cid)`, replacing the live transcript with older history and dropping the just-sent turn. | `cancelPickup()` now aborts/ignores **EVERY** in-flight pickup fetch (each interval poll **and** the final fetch) via one shared `AbortController` + generation check — no poll can `hydrate` after cancel. TB updated. |
> | 24 | **Seeded fallback drops `ctx`** — Rev 19 captured only the seed before stripping the URL; on the fallback path `new-session` didn't run, so unless the lazy `/api/chat` send carries `sectionContext`, a `?ctx=past_meeting` conversation is created with `sectionContext: null`. | Capture **`ctx` alongside the seed at mount** (before the URL strip) and pass it as `sendMessage(seed, ctx)` — the runtime already forwards a `sectionContextOverride` into the `/api/chat` body and the route accepts it. TB5/T3 assert `ctx` reaches the create. |
>
> **Rev 19 — Codex round 16 resolution (2026-07-22, PR #22):**
>
> | # | Codex | Resolution |
> |---|---|---|
> | 22 | **Seeded fallback leaves `p`/`autosend` in the URL** — Rev 14/18 covered only the *bare*-load fallback; on a *seeded* URL that enters fallback, the plan did no `hydrate`/`replace`, so the seed params persist through the fallback send → a mid-send refresh replays the seed, or the click is dropped if the fallback doesn't autosend. | The seeded fallback path **captures the seed at mount**, **synchronously strips `p`/`ctx`/`autosend` via `window.history.replaceState('/chat')` even without a `cid`** (no replay on refresh), and **still fires the seeded `sendMessage(seed)`** with `conversationId: null` (click not dropped). TB5/T3 cover it. Completes the fallback matrix across **both** load types (bare + seeded). |
>
> **Rev 18 — Codex round 15 resolution (2026-07-22, PR #22):**
>
> | # | Codex | Resolution |
> |---|---|---|
> | 21 | **`new-session` fetch is unbounded** — the gate holds `bootstrapReady=false` until the fetch settles; a *hung* `new-session` (not a reject or non-OK, which Rev 14 already handles, but a never-settling request) leaves the bare-load page permanently inert with no send affordance. | The `new-session` fetch carries an **`AbortSignal.timeout(NEW_SESSION_TIMEOUT_MS)`**; on abort it rejects, which routes into the **existing** rejected-`fetch` fallback (Rev 14) → surface enabled in fallback mode, first send lazy-creates. One bound completes the fallback's failure-mode set (reject / non-OK / missing-id / **hang**). |
>
> **Rev 17 — Codex round 14 resolution (2026-07-22, PR #22):**
>
> | # | Codex | Resolution |
> |---|---|---|
> | 19 (**P1**) | **Render gate strands `?cid` loads** — the gate starts `bootstrapReady=false` until `new-session` resolves, but a `/chat?cid` reload takes the `cidParam` branch and never calls `new-session`; every existing conversation + the P2 mid-wait pickup would stay behind the placeholder forever. | The gate applies **only to the bare no-`cid` load**: `bootstrapReady = Boolean(cidParam)` — **true immediately on the `?cid` path** (renders + hydrates + pickup at once), false only on bare load until the id is minted. |
> | 20 (P2) | **Fallback URL-sync still used `router.replace`** — same Next 16 transition gap Rev 16 fixed for seeded sends; a refresh right after the response could reload `/chat` without `cid`. | The fallback `conversationId` effect commits with synchronous `window.history.replaceState`. |
>
> **Rev 16 — Codex round 13 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 18 | **`router.replace` before the seed send isn't a synchronous URL commit** — Next 16 App Router writes the history entry on a later transition commit, so a refresh after the send starts but before the commit still shows `?p=…&autosend=1` → replays the seed into a new session (normal-path double-send window). | The seeded path commits the `?cid` URL **synchronously** with native `window.history.replaceState` (Next 16 supports it and keeps the router in sync — vendored `linking-and-navigating.md`) *before* `sendMessage(seed)`. T3 exercises the send-started-just-before-refresh timing. |
>
> **Rev 15 — Codex round 12 resolution (2026-07-22, PR #22):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 17 | **Fallback `cid` can't reach the URL *during* the long send** — the id is server-minted by `/api/chat`, unknown to the client for 2–90s; the Rev 14 effect only syncs *after* the response, so a refresh mid-fallback-send still orphans. | **Accepted as a degraded-mode non-goal:** occurs only during a `new-session` **outage**, is no worse than today's no-`cid` send, and self-heals (reply persisted, reachable via recent-chats, URL syncs on response). Closing it needs client-minted ids — banned by constraint #1. Documented in Non-goals; normal path unaffected. |
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
| `NEW_SESSION_TIMEOUT_MS` (`chatTimeouts.ts`, new — Rev 18) | Bounds the bare-load `new-session` fetch so a hang aborts into fallback mode instead of pinning the render gate; ~4s (well above one insert+prune, well under user patience) |
| `/api/chat/history` (returns rows with `role` + `createdAt`) | P2 polls it; the pending state is "last row is a user turn". **Rev 12:** add a `serverNow` field (server-anchored pickup age). **Rev 13:** order by `(createdAt ASC, id ASC)` for a deterministic sequence under ms-tie |
| Placeholder prune in `new-session` (`route.ts:32-43`) | Kept — placeholders still exist (bare visits), and P1 stops the *seeded-visit* accumulation |
| Abort copy (`plusimRuntime.ts`, latency A3) | P2's bound-stop can reuse the same honest wording if we choose to say anything (see P2) |

## Plan

**P1 — wire the minted id into the runtime (the bug fix).** In the
`new-session` `.then` (`chat/page.tsx:50-58`), order becomes:

```ts
hydrate([], data.conversationId);          // runtime now owns the cid  ← the fix
// SYNCHRONOUS URL commit (Rev 16, Codex round 13) — strips p/ctx/autosend and
// sets ?cid BEFORE the send. `router.replace` schedules the nav in a React
// transition (Next 16 App Router), so the history entry may not be written
// until a later commit; a refresh after the send starts but before that commit
// would still see ?p=…&autosend=1 and REPLAY the seed into a new session. The
// native history method commits immediately and Next 16 keeps its router in
// sync (vendored docs: 01-app/.../linking-and-navigating.md — window.history).
window.history.replaceState(null, "", `/chat?cid=${data.conversationId}`);
if (seed && autosend) void sendMessage(seed);
```

The seeded send now posts `conversationId: <minted id>` → `/api/chat` appends
to the **same** conversation (no duplicate); the URL `cid` is committed
**synchronously before the send**, so a refresh at any point after this line
resumes the real thread and never replays the seed (closing T3's normal-path
double-send window). `sectionContext` still lands: `new-session`
already stores `ctx` on the created conversation (`new-session/route.ts:23`),
and the first-turn preamble reads the **conversation row's** stored
`sectionContext` on the lookup branch (`route.ts:131`) — `past_meeting`
unchanged **on the happy path** (and, with **P1d** below, unchanged on a
failed-first-turn retry too). Remount safety verified (Rev 2): `cacheComponents` is off and a
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

**P1d — first-turn context must survive a failed-then-retried first turn
(Rev 22, Codex round 19).** Exactly the orphan-row pattern P1b fixes for the
title also breaks the **context preamble**. `/api/chat` injects the
Drive/`past_meeting` preamble only under `isFirstMessage`, which today means
"zero messages" (`_count.messages === 0`, `route.ts:85,130`). But a first
`/api/chat` call that 502s **after** persisting the user row (the agent write is
after the user write, `route.ts:113-119,161`) leaves an orphan user row, so the
retry sees `_count.messages = 1` → `isFirstMessage` false → the **first
successful** agent call runs **without** the stored `sectionContext`. That
silently drops the meeting context on a `past_meeting` retry — so "`past_meeting`
unchanged" is false in the failure case unless we fix it. **Fix:** gate the
preamble on **"no assistant reply has been persisted yet"**, not "no messages" —
i.e. redefine the first-turn predicate as a **role-filtered count**
(`_count: { select: { messages: { where: { role: "assistant" } } } }` → the turn
is "first" iff that count is 0). This is exactly "the first successful reply
hasn't happened," so: a normal first turn still injects (0 assistants); a
failed-then-retried first turn **re-injects** (still 0 assistants — fixed); a
normal 2nd+ turn does not (an assistant exists); a mid-conversation failed retry
does not re-inject (assistants already exist — correct, context is a first-turn
concern only). `chatPreamble.test.ts` (T1) stays green — it mocks `findUnique`
without `_count`, so the `?? 0` default keeps the turn "first" and the preamble
path fires. A new case (T1b) covers the orphan-row retry still injecting.

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

- **The gate applies ONLY to the bare (no-`cid`) load (Rev 17, Codex P1).**
  A `/chat?cid=…` reload takes the existing `cidParam` branch and **never calls
  `new-session`** — the id already exists. So `bootstrapReady` is initialized
  `Boolean(cidParam)`: **true immediately on the `?cid` path** (existing
  conversations, deep links, and the P2 mid-wait pickup all render and hydrate
  at once — they are NOT gated), and **false only on the bare no-`cid` path**
  until the id is minted. Gating the `?cid` path would strand every existing
  conversation behind the placeholder forever — the render gate must not touch
  it.
- **But the `?cid` path still guards SENDS against its own initial hydrate
  (Rev 23, Codex round 20).** Rendering `?cid` immediately is correct, but the
  initial `/api/chat/history` fetch that runs `hydrate(data.messages, cidParam)`
  (`chat/page.tsx:29-32`) is still in flight, and it is a **wholesale**
  `hydrate`. If a slow history load lets the user submit a new turn *before* it
  resolves, that stale response would replace the optimistic transcript and drop
  the just-started turn. The Rev 20 cancel token only covered **pickup** polls,
  not this **initial** load. Fix (render stays immediate — no regression to
  Rev 17): (i) the **send action** on the `?cid` path (composer submit + the
  welcome suggestions) is **inert until the initial history hydrate settles**
  (resolves or errors) — the view renders the loading conversation, only the
  *send* briefly waits for its own data (a fast `list` query; on error, sends
  enable anyway so the page never strands); and (ii) the initial history fetch
  **joins the same abort/generation token** as the pickup fetches, so even a
  response that lands the instant a send starts is ignored rather than
  clobbering the new turn (belt-and-suspenders, same rule as Rev 20). This keeps
  prior history *and* the new turn — the send appends onto loaded history, never
  races it. TB6 covers send-before-initial-hydrate.
- **Invariant (bare load only):** on a bare `/chat` load, **no send can be
  initiated from ANY entry point until the server-minted `cid` is installed in
  the runtime and the URL.** `bootstrapReady` flips true once `new-session`
  resolves, `hydrate([], id)` installs the id, and the synchronous
  `window.history.replaceState(?cid=id)` (Rev 16) runs. Because nothing can send
  before the id exists, there is no null-id send and nothing to clobber — the
  callback simply does its normal `hydrate([], id)`
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
- **Seeded autosend — success AND fallback (Rev 19, Codex round 16).** On the
  **success** path the `p`/`autosend` flow fires `sendMessage(seed)` from the
  callback *after* `bootstrapReady`, by which point the synchronous
  `window.history.replaceState(?cid)` has already stripped `p`/`ctx`/`autosend`;
  it is a programmatic send, so the brief disabled state never blocks it. On the
  **fallback** path (`new-session` failed → there is no `cid` to write) the seed
  must neither be dropped nor left in the URL: the page **captures the seed text
  AND `ctx` at mount, before any URL edit**, then on entering fallback mode
  **synchronously strips the seed params with `window.history.replaceState('/chat')`
  even without a `cid`** — so a refresh during the 2–90s fallback send cannot
  re-enter the autosend bootstrap and replay the seed — and **still fires the
  seeded send with `conversationId: null`** (lazy-create) so the original click
  is not lost. **The captured `ctx` is passed to that fallback send (Rev 20,
  Codex round 17):** normally `new-session` stores `sectionContext` on the
  created row, but on the fallback path `new-session` failed, so the only creator
  is `/api/chat` — the send must carry the section context explicitly or the
  conversation is created with `sectionContext: null` (a lost `past_meeting`
  pin). `sendMessage(seed, ctx)` already forwards a `sectionContextOverride` into
  the `/api/chat` body (`plusimRuntime.ts:52,78`; the route accepts
  `sectionContext`, `route.ts:33,104`), and `ctx` is captured **before** the URL
  strip removes it. The `conversationId` effect then syncs `?cid` once
  `/api/chat` returns. TB5/T3 cover the seeded-fallback path (no seed replay on
  mid-send refresh; the seed click is not dropped; **`ctx` reaches the
  lazy-create body**).
- **Failure fallback covers ALL non-success outcomes (Rev 14, Codex round 11;
  Rev 18, Codex round 15).**
  The render gate hides every send affordance until `bootstrapReady`, so
  `bootstrapReady` MUST flip true on every terminal outcome or the page is
  permanently inert. The fallback triggers on **any** of: a rejected `fetch`
  (network), a **non-`res.ok`** response (401/500 still resolve through
  `.then(r => r.json())`), a **missing `conversationId`** in the body, or a
  **hung request that never settles** — not just the `.catch` path. The hang is
  the subtle one: a promise that never resolves would hold `bootstrapReady`
  false forever, so the `new-session` fetch carries an
  **`AbortSignal.timeout(NEW_SESSION_TIMEOUT_MS)`** (a new const in
  `chatTimeouts.ts`, ~4s — comfortably above a normal single-insert `new-session`
  but well under any user's patience); on timeout it aborts and rejects, which
  falls into the same rejected-`fetch` branch. Any of these → enable the surface
  in **fallback mode** (no `hydrate`/`replace`; the first send lazy-creates with
  `conversationId: null` → `/api/chat` creates). Never a permanently-inert page.
- **The fallback (lazy-create) send syncs the URL as soon as an id exists
  (Rev 14 → Rev 17).** On the fallback path the send posts `conversationId: null`
  and the runtime stores the returned id in hook state; the `/chat` page adds an
  **effect watching the runtime's `conversationId`** — when it becomes non-null
  and the URL has no matching `cid`, it commits via **synchronous
  `window.history.replaceState(?cid=<id>)`** (Rev 17, Codex — same Next 16
  transition gap Rev 16 closed for seeded sends; `router.replace` here would let
  a refresh right after the response still reload `/chat` without `cid`). No-op
  on the normal path (already URL-synced).
- **Residual: the fallback's *during-send* window is a documented degraded-mode
  limitation (Rev 15, Codex round 12).** On the fallback path the id is minted
  **server-side by `/api/chat`**, which persists the user row and then waits on
  AgentGlob (2–90s) before returning it — so the client cannot know the `cid`
  until the response lands, and a refresh *during* that first fallback send
  still hits `/chat` with no `cid` (orphaned until reopen). This is
  **unavoidable under constraint #1** (no client-minted ids; `/api/chat` stays
  lookup-only) — the only id-minter (`new-session`) is *down* in exactly this
  path. It is **accepted**: (a) it occurs only during a `new-session` **outage**
  (rare), (b) it is no worse than today's no-`cid` first send, and (c) it
  self-heals — the reply is persisted and reachable from recent-chats, and the
  URL syncs the moment `/api/chat` returns. The normal (non-outage) path has the
  `cid` before the send via `new-session`, so this residual never applies there.
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
  **The same ambiguity exists for an unanswered turn BEFORE the captured one
  (Rev 21, Codex round 18).** The adjacency guard above only covers a user row
  *after* the captured turn, but a prior in-flight turn is just as poisonous:
  if tab B sends `U1` (row persisted) and then tab A sends `U2` and reloads
  while **both** replies are pending, the bootstrap captures `U2` and the tail
  is `U1, U2`; if B's reply writes first, history becomes `U1, U2, A1`, so
  "the row immediately after `U2` is an assistant" would hydrate `A1` — which is
  **`U1`'s reply, not `U2`'s** — and stop while `U2` is still pending (the exact
  missed/wrong reply this pickup exists to prevent). So the guard is symmetric:
  the pickup proceeds **only when the captured pending turn is the *sole*
  trailing unanswered turn** — i.e. the row *immediately before* it is an
  `assistant` row (or it is the first row). If the row immediately before the
  captured turn is another **user** row (an earlier unanswered turn), adjacency
  is ambiguous → **stop silently** and fall back to reopen, same as the
  after-case.
  **This guard also fires on a SINGLE-tab failed-retry orphan, and that is
  accepted (Rev 22, Codex round 19).** A first turn that 502s leaves an orphan
  user row `U1` (no reply coming); if the user retries with `U2` and refreshes
  while `U2` is pending, the tail is `U1, U2` and the predecessor guard backs off
  — so `U2`'s reply isn't auto-surfaced, only shown on the next reopen. This is
  **not** distinguishable from the concurrent multi-tab case at reload time: with
  no user→reply linkage, the transcript alone cannot say whether `U1` is a live
  concurrent turn or a dead orphan. Reverting the guard to rescue this flow would
  reintroduce the multi-tab **wrong-reply** hydrate (strictly worse), so the
  guard stays and the single-tab retry auto-surface is a documented best-effort
  miss (never a wrong or lost reply — the reply is persisted and shows on
  reopen). **P1d** independently ensures that retried turn still gets the correct
  first-turn context; only the mid-retry-refresh *auto-surface* degrades.
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
  Send is hidden): stop the poll, `isRunning = false`, **and abort/ignore
  EVERY in-flight pickup fetch — each regular 5s `/api/chat/history` poll AND
  the final deadline fetch, not just the final one (Rev 20, Codex round 17).**
  This is the subtle part: a regular interval poll already in flight when the
  user cancels or starts a new send can otherwise resolve *after* `sendMessage`
  has appended the new optimistic user row and call `hydrate(allRows, cid)`,
  replacing the live transcript with older history and dropping the just-sent
  turn. So every pickup fetch is tagged with a shared cancellation token (one
  `AbortController` + a generation check): `cancelPickup()` aborts the in-flight
  request and any later-resolving response is ignored by generation, so no poll
  — interval or final — can `hydrate` after the pickup is cancelled. **The
  `?cid` initial history hydrate (`chat/page.tsx:29-32`) is tagged with the same
  token (Rev 23, Codex round 20)**, so it too is ignored if it resolves after a
  send starts — no history fetch of any kind (initial, interval, or final) can
  clobber a started turn. A new send owns the transcript now. Stops are therefore:
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
- **Auto-surface when the transcript has more than one trailing unanswered
  turn (Rev 5 multi-tab; Rev 22 failed-retry — explicit).** With no user→reply
  linkage in the schema, once the transcript holds two or more unanswered `user`
  rows the reload cannot tell which reply belongs to the captured turn. Two
  cases produce this: (a) a **second tab/device** sends concurrently while this
  tab is in a reload-pickup; (b) a **single-tab failed retry** — a first turn
  that 502'd leaves an orphan `user` row, and the retry adds a second. Both are
  positionally identical at reload (`U1, U2, …`), so the pickup is
  **best-effort**: exact when the captured turn is the *sole* trailing unanswered
  turn, and otherwise it stops silently and falls back to normal reopen — **never
  a wrong reply, never a lost reply, never a hang** (the reply is persisted and
  appears on the next `?cid` reopen). The retry still gets correct first-turn
  context (**P1d**); only the auto-surface-on-mid-wait-refresh degrades. Making
  it exact would need a reply-linkage column (a schema change) — out of scope
  here, and moot once streaming (issue #19) resumes the specific stream directly.
- **A `cid`-in-URL guarantee during the fallback's *first* send (Rev 15,
  explicit).** The fallback path only runs when `new-session` (the server-side
  id minter) is **down**; the first send then lazy-creates via `/api/chat`,
  whose id isn't known to the client until its 2–90s response returns. A
  refresh in that window orphans (self-heals via recent-chats; URL syncs on
  response). Closing it would require client-minted ids — banned by constraint
  #1. Accepted degraded-mode edge; the normal path is unaffected (it has the
  `cid` before the send).

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

- **T1** (carried; automated — `chatPreamble.test.ts`): the first-turn
  precedence (past_meeting pin, admin preamble prepend, Drive context) is
  unchanged; stays green **untouched** under P1d's role-filtered count (the mock
  omits `_count` → `?? 0` default → turn is "first" → preamble fires).
- **T1b** (new, automated — guards P1d): a conversation whose only row is an
  **orphan user message** (a 502'd first turn, no assistant reply) is still
  treated as first-turn → the retry's agent call **re-injects** the stored
  `sectionContext`/Drive context; a conversation that already has an assistant
  reply does **not** re-inject.
- **T2** (carried; manual E2E): a seeded autosend visit creates **exactly
  one** conversation; after the reply, reload of `/chat?cid` hydrates the
  thread that holds the messages. (Today: two conversations, and the reload
  shows an empty placeholder.)
- **T3** (carried; manual E2E; **Rev 16**): a refresh during the in-flight wait
  does **not** re-send the seed — the `?cid` URL is committed **synchronously**
  (`window.history.replaceState`) *before* the send, so even a refresh in the
  gap right after the send starts sees `?cid` (not `?p=…&autosend=1`); `ctx`
  still lands (stored by `new-session`). Explicitly exercise the
  send-started-but-just-before-refresh timing. **Rev 19:** also exercise the
  **seeded fallback** — when `new-session` fails on a seeded URL, the seed params
  are stripped synchronously (`replaceState('/chat')`) *before* the lazy-create
  send, so a mid-fallback-send refresh sees no `?p=…&autosend=1` and does not
  replay; and the seed still sends (not dropped).
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
  never hydrate on a tie. **Earlier-pending-turn case (Rev 21):**
  `U1, U2, A1` where `U2` is captured and its predecessor `U1` is an unanswered
  user row ⇒ adjacency ambiguous (the adjacent `A1` may be `U1`'s reply) ⇒
  **stop silently**; the pickup completes only when the captured turn's
  predecessor is an assistant or start-of-history.
  TB2 — **server-anchored age (Rev 12):** `age = serverNow − createdAt` from the
  history response, so a fresh turn gets its full window under **either**
  browser-clock skew direction (ahead-skew no longer collapses to one fetch);
  a stale turn (`age ≥ window`) ⇒ `remaining 0` ⇒ no poll; deadline ⇒ spinner
  (`isRunning`) cleared even if the final fetch never settles, **but a final
  fetch resolving just after the deadline with the reply still hydrates the
  transcript** (Codex round 2). TB3 — cancel (user cancel or new send) ⇒ poll
  stops, `isRunning` false, **every in-flight pickup fetch discarded — a regular
  interval poll AND the final fetch (Rev 20):** a poll that resolves after
  `cancelPickup()` (e.g. after a new send appended its optimistic row) is
  ignored by the shared abort/generation token and does **not** `hydrate` older
  history over the new turn.
- **TB4** (new, automated — guards P1b): a null-title conversation is titled
  by **any** successful turn (not just the first); an existing title is never
  overwritten; and the write is **atomic** — the `updateMany` carries
  `where: { title: null }`, so a second overlapping request that read the
  stale null row updates zero rows (stale-null race → exactly one title,
  never clobbered). (`bookkeeping.test.ts` T4/T4b stay green with `update` →
  `updateMany`.)
- **TB5** (P1c — page-level render gate, Rev 11 → Rev 17): a **`/chat?cid`
  load is `bootstrapReady` immediately** (`Boolean(cidParam)` — renders and
  hydrates at once, never gated: the round-14 P1); on a **bare** load, while
  `bootstrapReady` is false **no send entry point is active — neither the
  composer NOR the welcome suggestions** (`SuggestionPrimitive.Trigger`), so no
  send fires without a `cid` (one conversation, no null-id create, no clobber)
  **whether the user uses the composer or clicks a suggestion**; once
  `new-session` resolves + `hydrate` + `replace` run, `bootstrapReady` flips
  true and both paths proceed; **every non-success `new-session` outcome**
  (rejected fetch, non-`res.ok`, missing `conversationId`, or a **hung request
  that aborts on `AbortSignal.timeout`** — Rev 18) re-enables the
  surface in fallback mode and the first send lazy-creates
  (`conversationId: null`), never a permanently inert surface; on a **seeded**
  fallback the captured seed **and `ctx`** are carried into the lazy-create
  (`sendMessage(seed, ctx)`), so a `?ctx=past_meeting` conversation is created
  with the right `sectionContext` even though `new-session` never ran (Rev 20);
  **the fallback send's returned id is synced to the URL** via the page's
  `conversationId` effect (a refresh after a fallback send resumes the thread);
  **HomeHub's runtime is unchanged** (posts `null`, lazy-creates as today).
  (Render-gate + suggestion coverage are manual E2E; the
  ready/error/fallback-URL-sync transitions are unit-tested.)
- **TB6** (P1e — `?cid` initial-hydrate send guard, Rev 23): a send fired on a
  `/chat?cid` load **before** the initial `/api/chat/history` hydrate resolves
  does **not** get clobbered — the send stays inert until the initial hydrate
  settles, and a stale initial response that lands after the send starts is
  ignored by the shared abort/generation token; prior history and the new turn
  both survive. (Send-gate timing is manual E2E; the generation-guard drop of a
  late response is unit-tested alongside the pickup decision fn.)
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
