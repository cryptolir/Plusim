# Plusim — chat latency: instrument, trim, and mask the wait

> **Status:** 🔍 **Rev 7 — RE-REVIEW REQUESTED, DESCOPED** (plan PR). Codex
> round 5 landed 2 new P2s, both consequences of Rev 6's `create-if-missing`
> change — i.e. rounds 4–5 both churned in the same Phase C bootstrap area
> while everything else stayed converged. Past the 4-round circuit-breaker,
> this was escalated to the owner per §3, who chose **descope**: the C1/C2
> `/chat` bootstrap rework leaves this plan for a dedicated follow-up plan
> (`docs/plans/chat-bootstrap.md`, to be drafted — ideally sequenced with
> Phase D streaming, which removes the long synchronous wait that makes
> reload-resilience hard). **Shippable scope of THIS plan: Phases 0, A, B,
> and C3.** No implementation yet.
>
> **Rev 7 — Codex round 5 resolution (2026-07-22, PR #12, owner-directed):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 6 | **Create-if-missing accepts arbitrary client IDs** — any non-existing string POSTs into `Conversation.id` (unconstrained `TEXT`) and into the AgentGlob `sessionKey`; the API widens from lookup-only to storing/forwarding client-controlled ids without shape validation. | **Descoped with C1/C2 (Rev 7).** The `create-if-missing` contract change leaves this plan entirely; `/api/chat` stays lookup-only for supplied ids. The finding is **banked as a hard requirement** in the follow-up plan's constraints: any client-minted-id design MUST validate UUID shape/length before any create (else 400). |
> | 7 | **No pending-reply pickup after a mid-wait reload** — a refresh after the user message is written but before the reply lands does one history fetch and (params stripped) never re-fetches, so the reply stays invisible until a manual reopen. Rev 6's "self-heals on next hydrate" claim was wrong. | **Descoped with C1/C2 (Rev 7)** — banked as the second hard requirement for the follow-up plan: a reload that lands on a conversation whose **last row is a user turn** needs a bounded pending-reply pickup (or the whole problem dissolves under Phase D streaming, the preferred sequencing). |
>
> **Rev 6 — Codex round 4 resolution (2026-07-22, PR #12) — section since
> DESCOPED to the follow-up plan (Rev 7):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 5 | **No `cid` in the URL during the long send** — C1 (Rev 2) stripped `p`/`autosend` before the send (T3) but only wrote `?cid=` *after* the 2–90s response, so a refresh mid-wait left a URL with neither param; the late-landed reply couldn't be hydrated and looked lost. The two fixes (T3 strip vs reload-hydrate T2) conflicted because the id didn't exist until after the call. | **C1 reworked (Rev 6):** mint the conversation id **client-side before the send** and `router.replace` `?cid=<id>` in *before* firing `/api/chat`, so the id is in the URL for the whole wait; a mid-wait refresh hydrates by `cid` and does not re-send. `/api/chat` gains a **create-if-missing** branch for a not-yet-existing supplied id (ownership guard unchanged — other-user id still 404s). Keeps C2's `new-session` deletion (id minted in-browser, no extra round trip). New test **T9**; T2/T3 updated. |
>
> **Rev 5 — Codex round 3 resolution (2026-07-22, PR #12):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 4 | **Rev 4's single-flight can itself get stuck** — `refreshInFlight` clears only *on settle*, so a hung Google token call never clears it and pins every later cold-cache Drive caller (incl. admin/report, which lack the outer race) on a dead promise until process restart. | **Terminal fix (Rev 5):** stop stacking guards that can get stuck; **bound the refresh itself** — wrap `client.getAccessToken()` in a hard ~4s timeout that rejects, so the promise is *guaranteed to settle* and can never pin. Strictly more robust than today (`getAccessToken` has no timeout now, so a hung endpoint already hangs all callers unbounded). Single-flight dedup demoted to an optional ponytail cut-candidate (no longer load-bearing). **T8 extended** to cover a later call after the first refresh hangs. |
>
> **Rev 4 — Codex round 2 resolution (2026-07-22, PR #12):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 3 | **Rev 3 overclaimed** — the inner `AbortSignal` cannot stop a hung `getAccessToken()`: it `await`s before any signaled fetch starts, so in the exact OAuth-hang case T8 banks there is no in-flight fetch to abort, and the refresh promise leaks/stacks past the outer race. | **B1 corrected + real bound added:** the signal is re-scoped to abort **in-flight Drive fetches only** (list/export), and the false "prevents that leak" claim is removed. The OAuth-refresh leak is closed by a **single-flight guard** on `getAccessToken()` (module-level shared in-flight promise — `getAccessToken` has no dedupe today, `googleDrive.ts:157-176`), capping it at **one** refresh no matter how many sends pile up; that one call warms `accessCache` and isn't cleanly cancellable (google-auth-library limitation), which the plan now states instead of hiding. **T8 rewritten.** |
>
> **Rev 3 — Codex round 1 resolution (2026-07-22, PR #12):**
>
> | # | Codex P2 | Resolution |
> |---|---|---|
> | 1 | **Drive timeout doesn't cover pre-fetch work** — threading `AbortSignal` only into `driveFetch` can't cap `getAccessToken()` (it runs *before* the signaled fetch, `googleDrive.ts:178-180`) nor the route/Prisma work, so A2's `client ≥ server + preprocessing` invariant can still break. | **B1 rewritten:** an **outer bounded path** (`Promise.race([buildLinkedFolderContext(), deadline]`) caps total context wall-clock *including* the OAuth refresh; the inner `AbortSignal` is kept **only** to stop the abandoned fetch leaking (not as the time bound). **A2 budget** now explicitly covers non-Drive preprocessing (Clerk + Prisma) measured in Phase 0, and the client constant is set from that measurement, not assumed. New test **T8**. |
> | 2 | **Post-reply bookkeeping can drop the saved reply** — a transient DB error in the title update or the raw-bump/view `Promise.all` (after the assistant row exists) rejects the route, so the client gets an error instead of the reply. Plan asserted the invariant but not the mechanism. | **C3 specifies the mechanism:** all post-reply bookkeeping runs inside a best-effort `try/catch` that logs (`chat_bookkeeping_error`) and continues; the route returns the persisted assistant message regardless. New test **T7**. |
>
> **Review log:**
> **Rev 1** — initial plan; folded in the two pre-review inspection passes
> (Claude + Codex repo reads, 2026-07-21).
> **Rev 2** — internal pre-review, 2026-07-21 (author-run ponytail minimalism
> pass + a Codex-style correctness pre-check; *not* the external Codex round).
> Ponytail: `yagni:` A3 history-refetch (timing defeats it; 1-line copy change
> instead) · `yagni:` B3 context cache (deferred, gated on Phase 0 data) ·
> `delete:` B3 invalidation hook · `delete:` C3 `after()` variant
> (`Promise.all` *is* the answer) · `shrink:` B2 to a line inside B1's diff ·
> `shrink:` Phase 0 drops `authMs`. Net ≈ −120 lines vs Rev 1.
> Correctness pre-check: **P1** — B2's unconditional `Promise.all` would fail
> `chatPreamble.test.ts:85` (`getSetting` must never run on `past_meeting`);
> now specified conditional. **P1** — B3's `invalidateFolderContext(userId)`
> was unimplementable (save-summary route has no userId; `folderId` is
> non-unique) — moot once B3 deferred; folder-keyed spec recorded for later.
> **P2s folded:** A2's timeout invariant re-anchored (client ≥ server +
> preprocessing budget ⇒ B1 must ship with/before A2); A3 confirmed near-dead
> code (cut); C3 batch re-ordered so the title update's `@updatedAt` cannot
> race the raw `updatedAt = now` bump (spurious-unread bug); C1 gains
> param-stripping at send time (refresh-mid-wait double-send window).
> **Bug found (both passes independently):** today's `/chat` autosend
> double-creates conversations — the `new-session` id goes into the URL but
> never into `conversationIdRef` (`plusimRuntime.ts:46` — set once at mount),
> so the seeded send posts `conversationId: null`, `/api/chat` creates a
> *second* conversation, and the URL's `cid` points at an empty placeholder
> (reload = messages "disappear"). C1 is therefore a **bug fix**, not just a
> latency cut. Latency table corrected (`getAgentInfo` is cache-warm except
> cold instances).

## Context

Users report very slow responses when chatting through the app. The chat path
is: browser → `/api/chat` (auth → rate limit → DB writes → optional first-turn
context → **synchronous** AgentGlob call → DB writes) → full JSON back →
assistant bubble appears. Nothing renders until everything finishes.

Where the wait lives (derived from code reading — **Phase 0 exists to confirm
these numbers in prod before we trust them**):

| Segment | When | Cost | Bounded? |
|---|---|---|---|
| AgentGlob reply (`callAgent`, `src/lib/agentglob.ts:31`) | every turn | **2–30s** documented (ARCHITECTURE.md), up to 90s allowed | 90s |
| Drive context (`buildLinkedFolderContext`, `src/lib/pastMeeting.ts:13`) | first turn of **every** conversation, linked-folder users | OAuth refresh + Drive list + Drive export, serial; `driveFetch` (`googleDrive.ts:178`) threads no `AbortSignal` | **no timeout at all** |
| `chat_preamble` read (`getSetting`) | first turn, non-`past_meeting` only (`route.ts:89-94`) | 1 DB query, serial after Drive | — |
| `/api/chat/new-session` on blank `/chat` load | before the first send can fire | conversation create + prune `deleteMany` + awaited `getAgentInfo()` (in-process 5-min cache kept warm by the avatars' `/api/chat/agent-info` calls — an external call only on cold instances), all serial; the page uses only `conversationId` | fetch default |
| DB round trips in `/api/chat` | every turn | ~7 serial queries (findUnique, count, 2× create, update, raw update, upsert) | — |
| Client render | every turn | full-reply JSON; typing dots with **no elapsed-time affordance** (the documented §5.4 recipe was lost in the Havaya→Plusim port) | client aborts at 90s — **same instant** the server's `callAgent` gives up (race; see A2) |

Additionally, the `/chat` bootstrap is **broken today**, not merely slow: on a
seeded visit (`/chat?p=…&autosend=1`), `new-session`'s id reaches only the URL
(`chat/page.tsx:52`), never `conversationIdRef` (`plusimRuntime.ts:46`, set
once at mount; only `sectionContextRef` is re-synced at `:49`). The seeded
send therefore posts `conversationId: null`, `/api/chat` creates a **second**
conversation (`route.ts:51-65`), the URL's `cid` points at the empty
placeholder, and a reload hydrates the placeholder — the real thread is only
findable from home. Placeholders accumulate on every autosend visit.
**Rev 7:** fixing this bootstrap bug is **descoped to the follow-up plan**
(`docs/plans/chat-bootstrap.md`) — review rounds 4–5 showed every quick fix
here spawns a new edge (cid-orphan → hydrate-gap + id-validation), and the
problem largely dissolves once Phase D streaming removes the 2–90s
synchronous wait. The bug is real but non-destructive: the reply is always
persisted and reachable from the recent-chats list.

The dominant latency term is AgentGlob's synchronous, non-streaming endpoint —
that fix is external (backlog: "Streaming responses — depends on AgentGlob
SSE"). This plan (a) measures, (b) deletes the app-side overhead we control,
and (c) makes the residual wait honest. (The bootstrap fix — previously goal
(c) — moved to the follow-up plan.)

## Hard boundary

Per `AGENTS.md` rule 0, all work touches **only** the Plusim repo. The real
fix — SSE on AgentGlob's public chat route — is an external ask (the spec is
already written: `docs/archive/AGENTGLOB.md` §4.1, with Plusim's migration
pre-staged in §6). Phase D delivers that ask; no cross-project edits.

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| Bounded-fetch pattern: `AbortSignal.timeout(2500)` aborting the fetch itself (`getUserSection` `agentglob.ts:108`, `seedAppProfileNameIfMissing` `:158`) | B1 threads a signal the same way (abort, not abandon) |
| Lazy-chat pattern: `HomeHub` creates no conversation until first send; `/api/chat` already creates the conversation when `conversationId` is absent (`route.ts:51-65`), consuming `sectionContext` on the create branch (`route.ts:61`) | *(follow-up plan)* the `/chat` bootstrap rework builds on this — descoped from this plan (Rev 7) |
| `chatPreamble.test.ts` — precedence guard incl. `getSetting` **never called** on `past_meeting` (`:85`) | Regression gate for B1/B2; must merge green **untouched** (named test T1) |
| `/api/chat/agent-info` route (used by `chat-avatars.tsx:20`) | Already serves agent metadata — `new-session`'s awaited `getAgentInfo()` is discarded by its only caller |
| Existing `bootstrapped` ref (`chat/page.tsx:22`) | *(follow-up plan)* strict-mode double-effect safety for the bootstrap rework |
| History hydrate on conversation open (`chat/page.tsx:29-34`) + the server's reply write | Already surfaces late-landed replies on revisit — what made A3 redundant |
| Coolify log stream | Consumes Phase 0's one-line JSON logs — no APM dependency |
| Shared-`now` invariant comment block (`route.ts:111-130`) | Semantics preserved with the C3 ordering fix below |

## Plan

### Phase 0 — instrumentation (ship first, alone)

**0a.** `performance.now()` marks in `/api/chat`; emit exactly **one**
`console.info("chat_latency", {...})` JSON line per turn:
`conversationId, isFirstMessage, hasContext, contextTimedOut,
dbBeforeAgentMs, contextMs, agentMs, dbAfterAgentMs, totalMs, outboundChars,
replyChars`. (No `authMs` — no decision gate consumes it; recoverable as
`totalMs` minus the rest.) On `callAgent` failure, one `chat_latency_error`
line with the same prefix fields + elapsed. Greppable in Coolify; no APM, no
new deps. Fields are opaque ids + char counts — no message content in logs.

**0b.** Deploy alone; collect several days of real traffic **before** trusting
the table above. Decision gates fed by this data: first-turn vs later-turn
`agentMs` split (→ Alternatives #2), `contextMs` distribution +
`contextTimedOut` rate (→ B1 constant), repeat-first-turns-within-5-min rate
(→ whether deferred B3 ever gets built).

### Phase A — make the wait honest (perceived latency)

**A1. "Still thinking" affordance.** Restore the lost §5.4 recipe:
`ThinkingIndicator` (`thread.tsx:109-124`) mounts/unmounts with `isRunning`
(`thread.tsx:83-85`), so a self-contained elapsed-since-mount timer adds a
Hebrew caption at 15s (e.g. "עדיין חושב… תשובה מורכבת בדרך"). No fake
streaming, no runtime coupling. Deleted when SSE ships.

**A2. Fix the timeout race — with the correct anchors.** The two 90s timers
start at different points: the client's at fetch start
(`plusimRuntime.ts:65`), the server's at `callAgent` start (`route.ts:103`) —
i.e. *after* auth, DB writes, and the context build. The invariant is
**client ≥ server + preprocessing budget**, where preprocessing =
`bounded context (≤ 2.5s, B1) + auth + pre-agent Prisma writes`. Two of those
terms are **not** abortable (Clerk `auth()`, the conversation fetch/create +
user-message write), so the budget is **set from Phase 0 measurement, not
assumed** (Rev 3, Codex P2#1): read the `dbBeforeAgentMs` + implied auth tail
from the baseline, take a high percentile, and size the client margin =
`2.5s + that`. With the code paths as they stand today that lands near the
Rev 2 figure (~3–4s ⇒ client 95s vs server 90s), but the number is now
**derived and asserted (T6/T8)**, not guessed — if Phase 0 shows a fatter
preprocessing tail, the client constant widens to match. **Ship B1 with or
before A2** (same PR — see Delivery). Both timeout values *and* the `2.5s`
context deadline live in one shared const-only module (importable by the
`"use client"` runtime and the route) so the three can't drift apart. Corrected failure model (Rev 2): on mutual timeout the server's
abort also fires, the route 502s, and **no** reply is written
(`route.ts:106-108`) — a reply lands unseen only when the agent finishes
inside the window between the two timeouts, or after a user cancel / network
drop. Those replies are durable and already surface when the conversation is
reopened (history hydrate); A2's companion copy change (below) tells the user
so.

**A3.** ~~Single history refetch on error~~ — **cut (Rev 2)**. Its timing
defeats it: on first-send failures `conversationIdRef` is still null (set
only from the response, `plusimRuntime.ts:99-101`) so there is nothing to
refetch, and in cancel/blip cases the reply lands up to ~90s *after* the
client error, long after a single immediate refetch. Replacement (1 line):
the abort/error bubble copy in `plusimRuntime.ts:121` says the reply may
appear in the conversation (recent-chats list) shortly.

### Phase B — first-message overhead (linked-folder users)

**B1. Bound the Drive context build — outer deadline for the time cap, plus
bounded per-leak cleanup (Rev 3 → Rev 5, Codex P2#1/#3/#4).** Three
mechanisms, each doing one job:
- **Outer bounded path caps total wall-clock.** Wrap the whole
  `buildLinkedFolderContext` call in `Promise.race([build, deadline(2500)])`
  (deadline resolves to null). This is what actually bounds preprocessing,
  because it covers **every** step — including `getAccessToken()`'s OAuth
  refresh, which `driveFetch` awaits *before* the signaled fetch
  (`googleDrive.ts:178-180`) and which an inner fetch signal therefore
  cannot reach. On deadline: return null, proceed **without** context, log
  `contextTimedOut` (Phase 0).
- **Inner `AbortSignal` aborts in-flight Drive fetches only.** A plain race
  abandons the losing promise — the list/export fetches keep running. So
  thread an optional `AbortSignal` (tied to the same deadline) through
  `driveFetch` (it already accepts `init`; the param stays optional so admin
  routes are untouched) to abort an **in-flight Drive fetch** when the
  deadline fires. Scope it honestly (Rev 4, Codex P2#3): this covers the
  `listSummaries`/`getFileText` fetches — it does **not** reach a hung
  `getAccessToken()`, because that `await`s *before* any signaled fetch
  starts (`googleDrive.ts:178-180`), so in the OAuth-hang case there is no
  fetch in flight for the signal to cancel. The signal is a **cleanup**
  device for Drive fetches, not the time bound and not an OAuth-refresh
  canceller.
- **OAuth refresh — make it always settle (the terminal fix, Rev 5, Codex
  P2#4).** Rev 4 added a single-flight `refreshInFlight` promise cleared *on
  settle*; Codex round 3 correctly holed it — if the Google token call
  **hangs**, it never settles, so `refreshInFlight` is never cleared and every
  later cold-cache Drive caller (incl. admin/report, which have **no** outer
  race) awaits that dead promise until the process restarts. Stacking a guard
  that can itself get stuck was the wrong shape. **Real fix: bound the refresh
  itself** so the promise is *guaranteed* to settle — wrap the
  `client.getAccessToken()` call in `googleDrive.ts` in a hard timeout
  (`TOKEN_REFRESH_TIMEOUT_MS`, ~4s, shared const module) that **rejects** on
  expiry. A promise that always settles cannot pin anything: on a hang it
  rejects within ~4s, the guard clears, and the next call retries fresh. This
  is **strictly more robust than today** — `getAccessToken` currently has *no*
  timeout (`googleDrive.ts:157-176`), so a hung token endpoint already hangs
  every Drive caller unbounded; Rev 5 gives them a bounded failure instead
  (chat → null context via the outer race; admin/report → a normal bounded
  error, not an infinite await). No retry storm: a timed-out refresh returns a
  bounded rejection to its caller, which does not tight-loop.
  - The **single-flight dedup** (`refreshInFlight`) is *kept but demoted to
    optional* now that settle is guaranteed — it saves N→1 concurrent token
    calls but is no longer load-bearing for correctness. **Ponytail
    cut-candidate:** if reviewers prefer minimal, drop it and rely on the
    per-refresh timeout alone (N bounded concurrent refreshes on a cold cache
    is acceptable and self-healing). The timeout is the fix; the dedup is a
    nicety.

Non-timeout Drive errors keep today's never-throws → null contract
(`pastMeeting.ts:36-38`); the race wrapper must not convert them into throws
(T5). The `2500` constant lives in the shared const module with the A2
timeouts (below) so the "context bound" the client budget assumes is the
literal one enforced here.

**Rider (same wrapper, second caller):** the home page runs the same
unbounded chain (`isDriveConnected()` + `listSummaries()`,
`src/app/page.tsx:91-99`) just to compute the `pastMeeting` boolean,
delaying the page that hosts the chat composer. Apply the same bound there
(timeout → `pastMeeting = false`).

**B2 (folded into B1's diff).** Parallelize the two first-turn reads
**conditionally** — `sectionContext` is known before either read
(`route.ts:89`):

```ts
const [folderContext, preamble] = await Promise.all([
  buildLinkedFolderContext(userId, { timeoutMs: CONTEXT_TIMEOUT_MS }),
  conversation.sectionContext === "past_meeting"
    ? Promise.resolve(null)
    : getSetting("chat_preamble"),
]);
```

The conditional is **load-bearing** (Rev 2 P1): an unconditional
`Promise.all` calls `getSetting` on `past_meeting` turns and fails
`chatPreamble.test.ts:85`. Precedence output stays byte-identical; the test
merges green **untouched** (T1).

**B3.** ~~Per-user 5-min context cache + invalidation hook~~ — **deferred
(Rev 2)**, gated on Phase 0 showing repeat-first-turns-within-TTL are common
*and* `contextMs` stays material after B1. B1 already caps the cost B3
existed to remove at ~2.5s. If ever built, the recorded constraints from the
pre-review stand: invalidation must be **folder-keyed**
(`invalidateFolderContext({folderId})` → `userDriveFolder.findMany` — the
save-summary route has no userId and `folderId` is non-unique in
`schema.prisma:53-60`); the invalidation inventory also includes folder
link/unlink (`admin/api/users/[userId]/drive` PUT/DELETE), file delete
(`admin/api/drive/file` DELETE), and file edit (`admin/api/drive/file-text`
PUT); null builds are not cached; the cache lives inside `pastMeeting.ts`
with a test-visible reset export (the preamble test mocks the module
wholesale, `chatPreamble.test.ts:26`).

### Phase C — DB consolidation (bootstrap rework DESCOPED, Rev 7)

**C1 + C2 — ~~`/chat` bootstrap rework~~ → follow-up plan.** The lazy-`/chat`
+ `new-session`-deletion rework (with its Rev 6 client-minted-id variant) is
**out of this plan** by owner decision after the round-4 circuit-breaker:
review rounds 4–5 both churned here (cid-orphan → hydrate-gap +
id-validation), each fix spawning the next edge, while every other phase
stayed converged. The whole difficulty comes from making a 2–90s synchronous
send survive reloads — which Phase D streaming eliminates — so the rework
moves to a dedicated plan (`docs/plans/chat-bootstrap.md`, to be drafted,
sequenced with/after streaming). `/api/chat` keeps today's contract in this
plan: supplied ids are **lookup-only** (unknown id → 404), no
create-if-missing. The follow-up plan inherits three **banked constraints**
from the review rounds: (1) client-minted ids must be UUID-shape-validated
before any create (Codex #6); (2) a reload landing on a conversation whose
last row is a user turn needs a bounded pending-reply pickup (Codex #7);
(3) a refresh mid-wait must neither re-send nor orphan the reply
(Codex #5 / T2+T3). The known double-conversation bug (Context) ships
unfixed in this plan — real but non-destructive (reply always persisted,
reachable via recent-chats).

**C3. Consolidate `/api/chat` DB round trips.**
- Fold `message.count` into the conversation fetch (`_count` select —
  supported by Prisma 5.22 `findUnique`); the created-fresh branch knows
  `isFirstMessage` implicitly. Semantics identical to today, including the
  documented concurrent-send race (unchanged, harmless). (−1 query/turn)
- Title: set at creation by `/api/chat` (`route.ts:62`); post-agent update
  only `if (isFirstMessage && !conversation.title)`. With the bootstrap
  rework descoped, `new-session` **stays alive** and keeps creating
  title-null rows — the conditional covers them (title-writer inventory
  verified: `route.ts:62` and `:115` only). Kills the duplicate write on the
  `/api/chat`-created path (home hub / no-id sends).
- Post-agent ordering (Rev 2 fix): create the assistant message **first**;
  then the **conditional title update** (its `@updatedAt` side-effect bumps
  `updatedAt` with Prisma's own timestamp — the very behavior the in-repo
  comment documents); then batch the raw `updatedAt = now` bump + view
  upsert in one `Promise.all`. This ordering keeps the shared-`now`
  invariant (`updatedAt == lastViewedAt`, no spurious "unread" on home,
  `page.tsx:76`) — a naive three-way batch would let the title update's
  auto-timestamp land *after* the raw bump nondeterministically (T4).
- **Bookkeeping is best-effort and isolated (Rev 3, Codex P2#2).** The
  invariant "a bookkeeping failure never drops the reply" needs a *mechanism*,
  not just a promise: once the assistant row is persisted, the title update +
  raw-bump/view batch run inside a `try/catch` that logs
  (`chat_bookkeeping_error`) and swallows — the route then returns the
  persisted assistant message **regardless** of a transient title/upsert/bump
  failure. Without the catch, a straight `await` of those writes would reject
  the route and hand the user an error while the reply sat saved in the DB
  (T7). The assistant-message create itself is **not** in the best-effort
  block — if *that* fails there is no reply to return and the route errors as
  today.
- User-message write stays **before** `callAgent` (durability) — unchanged.
- ~~`after()` variant~~ — **deleted (Rev 2)**: a docs-verification task, a
  post-response error question, and review surface to move ~10–30ms off a
  response the user waited seconds for. `Promise.all` is the answer, not the
  fallback.

### Phase D — the real fix (external, parallel)

Deliver the SSE ask to AgentGlob: `docs/archive/AGENTGLOB.md` §4.1 is the
ready-made spec, §6 already pre-stages Plusim's migration (streaming proxy
rewrite of `/api/chat` + `plusimRuntime` consuming deltas; A1's affordance is
then deleted). No Plusim code in this iteration; tracked in ROADMAP backlog.

## Alternatives considered

1. **Background job + poll/subscribe delivery**: total wait unchanged; the
   resilience benefit (reply survives navigation) already exists — the server
   writes the reply and history hydrate surfaces it on revisit. **Deferred**;
   revisit only if AgentGlob SSE never ships.
2. **Shrink the 8,000-char first-turn summary / pre-compact a memory blob.**
   Input-side processing is a small fraction of a 2–30s generation; payload
   rides only the first turn. **Measure first** (Phase 0 first-vs-later
   `agentMs` split); if first turns are materially slower, revisit
   `MAX_SUMMARY_CHARS` (one constant) before building compaction.
3. **Stop injecting Drive context on plain chats.** Product/behavior change,
   not a latency fix — the settings-panel plan (its Codex P2) deliberately
   preserved the injection, and **B1's bound caps its latency cost
   regardless** (Rev 2: this argument no longer leans on the deferred B3).
   **Default: keep**; product owner may override.

## Non-goals

- Implementing streaming before AgentGlob exposes SSE (external dependency).
- **The `/chat` bootstrap rework (ex-C1/C2)** — descoped to
  `docs/plans/chat-bootstrap.md` (Rev 7, owner decision); this plan changes
  nothing about how `/chat` starts up, and `new-session` stays as-is.
- Background-job delivery, the B3 cache (both deferred — see above).
- Changing what context the agent receives (precedence, injection semantics,
  summary size) — Phase B changes *when/whether we wait*, never what a
  successful build sends.
- APM platform, persistent (Redis) rate limiting, multi-instance cache
  correctness.

## Ponytail pass (Rev 2 — author-run per protocol §2)

Ladder run over Phases 0–C; guardrails (never cut): T1 precedence test
untouched, user-message-before-agent write order, client ≥ server +
preprocessing timeout invariant, reply-write-before-bookkeeping order.

- `yagni:` **A3** history refetch → 1-line copy change (existing
  hydrate-on-open already does the job).
- `yagni:` **B3** cache (deferred, data-gated) · `delete:` its userId
  invalidation hook (unimplementable as specced — P1).
- `delete:` **C3 `after()`** variant (`Promise.all` is the answer).
- `shrink:` **B2** → a conditional line inside B1's diff.
- `shrink:` **Phase 0** drops `authMs`.
- **Added** (simpler than what Rev 1 proposed): B1 rider bounding the home
  page's identical unbounded Drive chain (`page.tsx:91-99`).
- **Kept:** everything else — one log line, one caption timer, one paired
  constant, one signal-threaded timeout, one query consolidation. No new
  tables/routes/deps. *(Rev 7: the route deletion left with the descoped
  bootstrap rework.)*

Net ≈ −120 lines vs Rev 1 as specced (before the Rev 7 descope, which
shrinks it further).

## Risks / contingencies

- **Next 16 API drift** (AGENTS.md warning): still read the vendored docs
  (`node_modules/next/dist/docs/`) before coding any route/client change.
  (The `after()` half of this risk left with the `after()` cut; the
  `router.replace` half left with the Rev 7 bootstrap descope.)
- **B1 touches shared `driveFetch` + `getAccessToken`:** the `driveFetch`
  signal parameter is optional and unthreaded callers (admin routes) are
  behavior-identical; verified by typecheck + admin Drive smoke test. The
  signal is cleanup only — the outer race is the time bound (Rev 3), so a
  caller that ignores it is still bounded via the wrapper. The
  `getAccessToken` change (Rev 5) is on the hot token path used by **every**
  Drive call incl. admin/reports: a hard ~4s refresh timeout (the fix) plus an
  optional single-flight dedup. It must be transparent on the happy path
  (cache hit → neither engages) and only affect concurrent cold-cache
  refreshes; the timeout makes a hung endpoint a bounded failure for **all**
  Drive callers (today it's an unbounded hang). Regression-checked by the
  admin Drive smoke test + T8's self-eviction assertion.
- **A2/B1 coupling:** the timeout invariant only holds with total
  preprocessing bounded — the outer race bounds the context build (incl. OAuth
  refresh) and the client margin is sized from Phase 0's measured non-Drive
  preprocessing tail (Rev 3); A2 and B1 ship in the same PR, all three
  constants in one shared module (T6/T8 guard the margin).
- **`isFirstMessage` race** (two concurrent first sends → both get the
  hint): pre-existing, unchanged by `_count`; documented, not fixed.
- **B1 constant too tight** → context absent more often than today;
  `contextTimedOut` rate (Phase 0) tunes it before Phase B ships.

## Verification

**Named test cases banked from review findings (protocol §2 — the
implementation PR must contain these):**

- **T1** (pre-review P1): `chatPreamble.test.ts` merges green **untouched** —
  incl. `:85` (`getSetting` never called on `past_meeting`); B2's conditional
  form is what makes this hold.
- **T2 / T3 — moved to the follow-up plan (Rev 7 descope).** They test the
  C1/C2 bootstrap rework (exactly-one-conversation autosend; refresh
  mid-wait neither re-sends nor orphans the reply). They ride along with the
  descoped scope and are **mandatory** in `docs/plans/chat-bootstrap.md`.
- **T4** (pre-review P2): first message on a legacy null-title conversation →
  final `updatedAt == lastViewedAt` (no spurious "unread" on home) — guards
  the C3 write ordering against the `@updatedAt` race.
- **T5** (B1): slow/mocked-hanging Drive → context null within the bound and
  the send proceeds; non-timeout Drive errors still → null (never-throws).
- **T6** (A2): unit-level assertion that the client timeout constant exceeds
  the server constant by at least the preprocessing budget (single shared
  module — the constants cannot drift).
- **T7** (Codex round 1 P2#2): after the assistant message is persisted, a
  forced/mocked failure in the title update **and** in the raw-bump/view
  batch still returns the assistant message to the client (route resolves,
  not rejects) and emits `chat_bookkeeping_error`. A failure in the
  assistant-message create itself still errors (that path is *not* isolated).
- **T8** (Codex round 1 P2#1, rewritten round 2 P2#3, **extended round 3
  P2#4**): with `getAccessToken()` mocked to hang, `buildLinkedFolderContext`
  resolves null within the outer deadline (time bound covers the pre-fetch
  step). **Leak scoping:** a mocked slow *Drive fetch* (list/export) receives
  an abort via the signal; a hung *token refresh* does **not** (no fetch in
  flight). **No stuck pin (round 3):** the hung refresh **rejects within
  `TOKEN_REFRESH_TIMEOUT_MS`**, and a *later* `getAccessToken` call after the
  first one hangs starts a **fresh** attempt (not awaiting a dead promise) —
  proving the guard self-evicts; an admin/report caller in the same window
  also gets a bounded rejection, not an infinite await. Plus: the client
  timeout margin ≥ measured preprocessing high-percentile (asserted against
  the const module).
- **T9 — moved to the follow-up plan (Rev 7 descope).** It tested the
  create-if-missing contract, which leaves this plan; `/api/chat` stays
  lookup-only for supplied ids here. In the follow-up plan T9 is mandatory
  and **extended by Codex #6**: malformed / non-UUID / oversized supplied ids
  400 before any create.

**Also:**
- Unit: context deadline fallback; `isFirstMessage` via `_count`;
  conditional-title logic.
- Route: `/api/chat` with no `conversationId` creates conversation (title +
  namespaced sessionKey + `sectionContext`) and replies; 401/429 unchanged.
- Manual E2E (dev tunnel): home-hub prompt click sends and replies;
  `past_meeting` pin still injects folder context; simulated slow Drive →
  message proceeds context-less within ~2.5s overhead; home page renders
  within the bound for linked-folder users (B1 rider); 15s hint appears;
  admin Drive pages unaffected (B1 optional-signal check); `/chat` bootstrap
  behaves **exactly as today** (unchanged in this plan — Rev 7 descope).
- Prod, post-deploy: `chat_latency` grep — `dbBeforeAgentMs` +
  `dbAfterAgentMs` shrink vs Phase 0 baseline; `contextMs` bounded;
  first-vs-later `agentMs` recorded for the Phase D ask.
- Gates: `pnpm typecheck && pnpm test && pnpm build` per PR.

## Delivery & order

1. **This plan** → plan PR #12 from `claude/agent-response-latency-vt4z4m`,
   per protocol. History: rounds 1–3 folded as Revs 3–5; round 4 hit the
   circuit-breaker → owner said continue → Rev 6; round 5 (2 P2s in the same
   bootstrap area) → owner chose **descope** → Rev 7 (this). Approved ⇒ merge
   plan PR, then implement **exactly** the descoped plan.
2. **Phase 0** alone → deploy → ≥3–5 days of `chat_latency` baseline.
3. **Phases A + B in one PR** (A2 depends on B1's bound — see Risks).
4. **Phase C3** — small separate PR carrying T4 + T7.
5. **Phase D** ask goes to AgentGlob in parallel; streaming implementation is
   a new plan when SSE exists.
6. **Follow-up plan** (`docs/plans/chat-bootstrap.md`) — the C1/C2 bootstrap
   rework, drafted fresh per protocol (ponytail → plan PR → Codex), carrying
   the three banked constraints + T2/T3/T9. Preferably sequenced with/after
   streaming.

## Review asks (Rev 7 re-review — descoped scope only)

The C1/C2 bootstrap asks are gone with the descope; attack what remains:

1. **T1 invariant:** does any part of B1/B2 as specified still reach
   `getSetting` on a `past_meeting` first turn, or otherwise change the
   preamble precedence output for any (`sectionContext`, folder-state,
   preamble-state) combination?
2. **A2 anchors:** with B1's bound in place, is there any path where
   preprocessing exceeds the budget and the client still aborts before the
   server resolves (e.g. Clerk latency, DB stalls, token refresh)?
3. **C3 ordering:** any interleaving of {assistant create, conditional title
   update, raw bump + view upsert batch} that violates
   `updatedAt == lastViewedAt` or loses the reply on a bookkeeping failure?
4. **B1 blast radius:** any `driveFetch` / `getAccessToken` caller (admin,
   reports) whose behavior changes with the optional signal or the ~4s
   refresh timeout; any leak past the never-throws contract.
5. **Descope completeness:** does the Rev 7 scope still depend on anything
   from the removed C1/C2 (a hidden coupling that breaks with the bootstrap
   left as-is)?
