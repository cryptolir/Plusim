# Plusim — chat latency: instrument, trim, and mask the wait

> **Status:** 🔍 **Rev 1 — IN REVIEW** (awaiting ponytail minimalism pass +
> Codex correctness rounds, per protocol). No code has been written yet; this
> doc is the proposal.
>
> **Review log:** Rev 1 — initial plan. Folds in the two pre-review inspection
> passes (Claude + Codex repo reads, 2026-07-21): both independently identified
> the same six problem areas — no streaming, first-message Drive work,
> oversized first prompt, eager `/chat` session creation, sequential DB writes,
> and zero latency instrumentation. Divergences between the two passes are
> resolved in § *Alternatives considered* (async-job delivery model → deferred;
> summary-size cut → measure first; dropping plain-chat Drive injection →
> product decision, default keep).

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
| Drive context (`buildLinkedFolderContext`, `src/lib/pastMeeting.ts:13`) | first turn of **every** conversation, linked-folder users | OAuth refresh + Drive list + Drive export, serial | **no timeout at all** |
| `chat_preamble` read (`getSetting`) | first turn | 1 DB query, serial after Drive | — |
| `/api/chat/new-session` on blank `/chat` load | before the first send can fire | conversation create + prune `deleteMany` + **`getAgentInfo()` external call**, all awaited serially; page uses only `conversationId` | fetch default |
| DB round trips in `/api/chat` | every turn | ~7 serial queries (findUnique, count, 2× create, update, raw update, upsert) | — |
| Client render | every turn | full-reply JSON; typing dots with **no elapsed-time affordance** (the documented §5.4 recipe was lost in the Havaya→Plusim port) | client aborts at 90s — **same instant** the server gives up (race) |

The dominant term is AgentGlob's synchronous, non-streaming endpoint — that fix
is external (backlog: "Streaming responses — depends on AgentGlob SSE"). This
plan (a) measures, (b) deletes the app-side overhead we control, and (c) makes
the residual wait honest and survivable in the UI.

## Hard boundary

Per `AGENTS.md` rule 0, all work touches **only** the Plusim repo. The real
fix — SSE on AgentGlob's public chat route — is an external ask (the spec is
already written: `docs/archive/AGENTGLOB.md` §4.1, with Plusim's migration
pre-staged in §6). Phase D delivers that ask; no cross-project edits.

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| Bounded-fetch pattern: `getUserSection(..., { timeoutMs })` / `seedAppProfileNameIfMissing` (`AbortSignal.timeout(2500)`, graceful null) | The template for bounding the Drive context build (B1) |
| Lazy-chat pattern: `HomeHub` creates no conversation until first send; `/api/chat` already creates the conversation when `conversationId` is absent (`route.ts:51-65`) | Blank `/chat` goes lazy the same way (C1) — no new mechanism |
| In-memory TTL caches: `agentInfoCache` (5 min), Drive `accessCache`, `containmentCache` | House pattern for the per-user context cache (B3) |
| `chatPreamble.test.ts` — guards first-message preamble precedence (Codex P2, settings-panel plan) | Regression gate for every Phase B/C change |
| `/api/chat/agent-info` route (used by `chat-avatars.tsx`) | Already serves agent metadata — proves `new-session`'s awaited `getAgentInfo()` is dead weight |
| Coolify log stream | Consumes Phase 0's one-line JSON logs — no APM dependency |
| `updatedAt`-bump raw-SQL + shared-`now` comment block (`route.ts:111-130`) | Semantics preserved verbatim when writes are batched (C3) |

## Plan

### Phase 0 — instrumentation (ship first, alone)

**0a.** `performance.now()` marks in `/api/chat`; emit exactly **one**
`console.info("chat_latency", {...})` JSON line per turn:
`conversationId, isFirstMessage, hasContext, contextTimedOut, authMs,
dbBeforeAgentMs, contextMs, agentMs, dbAfterAgentMs, totalMs, outboundChars,
replyChars`. On `callAgent` failure, one `chat_latency_error` line with the
same prefix fields + elapsed. Greppable in Coolify; no APM, no new deps.

**0b.** Deploy alone; collect several days of real traffic **before** trusting
the table above. Decision gates fed by this data: first-turn vs later-turn
`agentMs` split (→ Alternatives #2), `contextMs` distribution (→ B1 timeout
value), `contextTimedOut` rate (→ tune B1).

### Phase A — make the wait honest (perceived latency, no behavior change)

**A1. "Still thinking" affordance.** Restore the lost §5.4 recipe: while
`isRunning`, the typing indicator gains an elapsed-timer caption at 15s
(Hebrew, e.g. "עדיין חושב… תשובה מורכבת בדרך") — a self-contained timer in the
thread's running-indicator component. No fake streaming, no runtime coupling.

**A2. Fix the 90s/90s timeout race.** Today client abort and server timeout
both fire at 90s; when the client wins, the reply lands in the DB unseen while
the user reads "we stopped waiting". Change: **client 95s > server 90s** — one
paired constant, so the server's 502 (or late reply) always beats the client
abort. Whether to trim the pair (e.g. 60/65) is an open question for review —
90s was a deliberate allowance for long agent thinking.

**A3. Recover late replies.** On client-side fetch failure/abort in an
existing conversation, one history refetch (`/api/chat/history`) after the
error — surfaces a reply that landed server-side despite the client giving up.
Single refetch, no polling loop.

### Phase B — first-message overhead (linked-folder users)

**B1. Bound the Drive context build.** Wrap `buildLinkedFolderContext` in a
~2.5s deadline (the house `timeoutMs` pattern) → on timeout return null and
proceed **without** context rather than holding the message. Log
`contextTimedOut` (Phase 0). The never-throws contract is unchanged.

**B2. Parallelize the two first-turn reads.**
`Promise.all([boundedFolderContext, getSetting("chat_preamble")])`.
Precedence is **byte-identical** to today (guarded by `chatPreamble.test.ts`):
`past_meeting` → folder context only; otherwise preamble prepended to folder
context; blank preamble never suppresses the Drive injection.

**B3. Cache the built context per user.** In-memory `Map<userId, {text, ts}>`,
TTL 5 min (house pattern). A user starting a second conversation inside the
TTL skips OAuth + Drive list + export entirely. Invalidate the entry when the
admin saves a summary for that user (export `invalidateFolderContext(userId)`;
call it from the save-summary route). Single-instance caveat identical to
every existing in-memory cache here — acceptable on one Coolify instance.

### Phase C — dead weight in the send path

**C1. Blank `/chat` goes lazy** (align with `HomeHub`). Drop the
`/api/chat/new-session` call from the no-`cid` mount path; render immediately;
the first send hits `/api/chat` with no `conversationId` (already supported —
mints id + sessionKey + title in one create). Add a small effect syncing the
URL to `?cid=<id>` when the runtime's `conversationId` appears. The seeded
`p`/`autosend` flow fires `sendMessage(seed)` on mount directly — removing a
full round trip (create + prune + external `getAgentInfo`) from before the
first send. `ctx` passthrough and `?cid` deep-link + `mark-viewed` unchanged.

**C2. Delete `/api/chat/new-session`.** Grep-confirmed single caller (the
chat page), which ignores the route's `agentInfo` (avatars already use
`/api/chat/agent-info`). With no placeholders created, the prune logic dies
with the route. Existing legacy placeholder rows are already invisible (home
query filters `messages: { some: {} }`) — leave them; optional one-off cleanup
noted in the PR, not blocking.

**C3. Consolidate `/api/chat` DB round trips.**
- Fold `message.count` into the conversation fetch (`_count` select); the
  created-fresh branch knows `isFirstMessage` implicitly. (−1 query/turn)
- Title: already set at creation by `/api/chat`; keep the post-agent update
  only `if (isFirstMessage && !conversation.title)` (covers legacy
  null-title conversations). Kills the duplicate write on the common path.
- Post-agent: create the assistant message **first** (it's what the response
  needs), then run the three bookkeeping writes (raw `updatedAt` bump, view
  upsert, conditional title) as one parallel batch — `Promise.all`, or moved
  off the response path via Next's `after()` **if** the vendored Next 16 docs
  (`node_modules/next/dist/docs/` — this Next has breaking changes; verify at
  implementation time) confirm it runs reliably post-response under
  `next start`. Fallback is the awaited `Promise.all` (still collapses 3–4
  serial trips to 1 batch). Shared-`now` semantics and the raw-SQL rationale
  comment preserved verbatim.
- User-message write stays **before** `callAgent` (durability if the agent
  fails) — unchanged.

### Phase D — the real fix (external, parallel)

Deliver the SSE ask to AgentGlob: `docs/archive/AGENTGLOB.md` §4.1 is the
ready-made spec ("turns a 15s loading into a 1s Hello"), §6 already pre-stages
Plusim's migration (streaming proxy rewrite of `/api/chat` +
`plusimRuntime` consuming deltas; A1's affordance is then deleted). No Plusim
code in this iteration; tracked in ROADMAP backlog as today.

## Alternatives considered (reviewer input wanted)

1. **Background job + poll/subscribe delivery** (Codex pass suggestion):
   return immediately after persisting the user message; process AgentGlob in
   a job; client polls for the reply. Honest assessment: total wait is
   unchanged; the resilience benefit (reply survives navigation) already
   mostly exists — the server writes the reply regardless of the client — and
   A3 surfaces it for two orders of magnitude less build (job table, runner,
   polling route, UI state machine). **Proposed: defer**; revisit only if
   AgentGlob SSE never ships. Expect ponytail to weigh in.
2. **Shrink the 8,000-char first-turn summary / pre-compact a "chat memory"
   blob.** Input-side processing is a small fraction of a 2–30s generation;
   the payload rides only the first turn. **Measure first**: Phase 0 splits
   first-turn vs later-turn `agentMs`; if first turns are consistently and
   materially slower, revisit `MAX_SUMMARY_CHARS` (a one-constant change)
   before building a compaction pipeline.
3. **Stop injecting Drive context on plain (non-`past_meeting`) chats.**
   A product/behavior change, not a latency fix — the settings-panel plan
   (its Codex P2) deliberately preserved this injection, and B3's cache
   removes most of its latency cost anyway. **Default: keep**; product owner
   may override.

## Non-goals

- Implementing streaming before AgentGlob exposes SSE (external dependency).
- Background-job delivery model (Alternatives #1 — deferred).
- Changing what context the agent receives (precedence, injection semantics,
  summary size) — Phase B changes *when/whether we wait* for context, never
  what a successful build sends.
- APM/observability platform, persistent (Redis) rate limiting,
  multi-instance cache correctness — out of scope, single-instance reality.

## Pre-review minimalism self-pass (Rev 1)

Applied the ladder before sending for review; anticipated cut-candidates
flagged for ponytail rather than silently kept:

- No new tables, routes, deps, or infra. Net **−1 route** (`new-session`
  deleted), −1 client round trip, −2 queries/turn.
- Phase 0 is one log line, not an APM integration.
- A3 is a single refetch, not a polling loop. *(cut-candidate)*
- B3 invalidation hook — TTL alone might suffice; the hook is ~5 lines and
  closes the "admin saves, immediately opens chat" path. *(cut-candidate)*
- Phase 0 field list could shrink. *(cut-candidate)*
- **Guardrails — do not cut:** preamble precedence (`chatPreamble.test.ts`),
  user-message-before-agent write order (durability), client>server timeout
  invariant (A2), reply-write-before-bookkeeping order (C3).

## Risks / contingencies

- **Next 16 API drift** (AGENTS.md warning): `after()` and router semantics
  must be verified against the vendored docs before C3/C1 are coded;
  `Promise.all` fallback defined. node_modules was absent in the planning
  container, so this is explicitly unverified.
- **React dev double-effects / double-send:** the existing `bootstrapped` ref
  pattern must survive C1's rewrite — the autosend seed must fire exactly
  once. E2E-check the full param matrix (`p`, `ctx`, `autosend`, `cid`).
- **`isFirstMessage` race** (two concurrent first sends → both count 0 → both
  get the hint): pre-existing today, unchanged by `_count`; documented, not
  fixed (harmless duplicate context, no data corruption).
- **Cache staleness (B3):** a summary saved mid-TTL may miss a chat started
  within 5 min — the invalidation hook closes the admin path; residual window
  documented.
- **B1 timeout too tight** → context silently absent more often than today;
  `contextTimedOut` rate (Phase 0) tunes the constant before Phase B ships.
- **Deleting `new-session`:** re-grep for callers at implementation time;
  POST-only internal route, no deep links.
- **A2 pair drift:** the two timeouts become a single paired constant so a
  future edit can't reintroduce the race.

## Verification

- **Unit:** `chatPreamble.test.ts` stays green untouched (precedence
  byte-identical). New: context deadline → null fallback; cache TTL +
  invalidation; `isFirstMessage` via `_count`; conditional-title logic.
- **Route:** `/api/chat` with no `conversationId` creates conversation
  (title + namespaced sessionKey) and replies; 401/429 paths unchanged.
- **Manual E2E (dev tunnel):** blank `/chat` first send → URL gains `cid`;
  home-hub prompt click (autosend) sends exactly once; `past_meeting` pin
  still injects folder context; second conversation within 5 min skips Drive
  (verify via `contextMs`≈0 log); admin saves summary → immediately-started
  chat sees it (invalidation); simulated slow Drive → message proceeds
  context-less within ~2.5s overhead; 15s hint appears; abort/error →
  history refetch surfaces a landed reply.
- **Prod, post-deploy:** grep `chat_latency` — `dbBeforeAgentMs` +
  `dbAfterAgentMs` shrink vs Phase 0 baseline; `contextMs` bounded;
  first-turn vs later-turn `agentMs` recorded for the AgentGlob ask (Phase D).
- **Gates:** `pnpm typecheck && pnpm test && pnpm build` per PR.

## Delivery & order

1. **This plan** → commit on `claude/agent-response-latency-vt4z4m` → ponytail
   pass (fold as Rev 2) → Codex rounds (Rev 3+) — per protocol. No
   implementation before the plan settles.
2. **Phase 0** alone → deploy → collect ≥3–5 days of `chat_latency` baseline.
3. **Phases A + B** (independent of each other; low behavioral risk) — one PR
   each, or combined if reviews are clean.
4. **Phase C** (touches the `/chat` bootstrap contract) — separate PR with the
   full E2E matrix in the description.
5. **Phase D** ask goes to AgentGlob in parallel with 2–4; streaming
   implementation is a new plan when SSE exists.

## Code-review instructions

**Ponytail (minimalism):** run the ladder over Phases 0–C; the self-pass above
lists the anticipated cut-candidates (A3 refetch, B3 invalidation hook,
Phase 0 field set) and the guardrails that must survive any cut.

**Codex (correctness) — focus areas:**
1. Preamble precedence byte-identical through B2 (test must not weaken).
2. C1 param matrix: `p`/`ctx`/`autosend`/`cid` × signed-out × dev
   double-effects — exactly-once autosend, `sectionContext` still lands on
   the created conversation.
3. `_count`-based `isFirstMessage` vs today's `count()` — identical semantics
   incl. the documented concurrent-send race (no new writes on the read path).
4. B3 cache: keyed by `userId` only — no cross-user leakage; invalidation
   actually reachable from the save-summary route's user mapping.
5. C3 ordering: assistant-message write must succeed before (or independently
   of) bookkeeping; a bookkeeping failure must never drop the reply or the
   response. `after()` only if the vendored Next 16 docs confirm semantics.
6. A2: single paired constant; client strictly > server.
7. B1: deadline wrapper must not convert non-timeout Drive errors into
   throws — today's never-throws contract holds.

**How to review:** `git fetch && git checkout claude/agent-response-latency-vt4z4m`;
read this doc, then per-phase diffs; `pnpm typecheck && pnpm test`. Post
findings as P1 (blocker) / P2 (must-address) with file:line, per protocol.
