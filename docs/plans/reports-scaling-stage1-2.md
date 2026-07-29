# Plan: Reports scaling — Stage 1 (queue + worker) and Stage 2 (safe parallelism)

**Rev 3** — 2026-07-29. Source analysis: [`docs/REPORTS_SCALING.md`](../REPORTS_SCALING.md)
(incl. its Code-verified findings section). Scope: stages 1–2 only; stages 3–4 are separate plans.

> **Rev 3 (Codex round 2, 2 findings folded):** both P1s attacked Rev 2's dual-arbiter design
> (route-side `singletonKey` + worker-side claim guard). Rev 3 deletes the singleton entirely:
> the route's status write becomes a **CAS** (`updateMany` conditioned on the prior status), so a
> concurrent double-POST loses the CAS and 409s instead of racing the revert (F7); the CAS also
> **clears `agentTokenHash`**, so a delayed callback from the previous run no-matches the result
> route's `acceptingWhere` (`result/route.ts:38–43`) during the queued window (F8). The worker's
> claim CAS is now the single execution arbiter; duplicate queue entries no-op. Net: less
> machinery than Rev 2, two named tests added.

> **Rev 2 (Codex round 1, 6 findings folded):** status commit now precedes enqueue with
> compensation + re-run-from-`dispatched` recovery (F1); suppressed singleton send → 409, never a
> silent `dispatched` (F2); retries reclaim their own attempt via a new `queueJobId` column and
> `failed` is written only on the final attempt (F3); worker runs under `tsx` — Node's native TS
> does not transform `tsconfig` `paths`, and the app's helpers use `@/lib/*` transitively (F4);
> Stage 2 re-scoped — replicas parallelize only the dispatcher, so concurrency now comes from one
> worker with in-process dispatch concurrency 3, gated on *verified* AgentGlob runtime concurrency
> (F5); Drive bucket moved into `driveFetch` (`googleDrive.ts:208`), the single choke point all
> six mutating helpers share, gating non-GET methods (F6).

## What exists (read, not remembered)

- **Dispatch holds a request for up to 5 minutes.** `src/app/admin/api/reports/[jobId]/run/route.ts`
  sets `maxDuration = 320` (`:20`), `DISPATCH_TIMEOUT_MS = 300_000` (`:22`), and `await callAgent({...})`
  (`:69–73`). On timeout it deliberately leaves `status=processing` and lets the callback finish
  (`:80–85`); on error it sets `failed` (`:87–90`). The route also holds two guards: published jobs
  need `{"confirmUpdate":true}` (`:39–46`) and zero-file jobs are refused (`:47–49`).
- **The per-job token is minted in the route** (`:51`, `mintJobToken()` — sha256-stored, 24 h TTL)
  and embedded in the manifest URL. The header comment (`:11`) states re-dispatch is always safe
  because it re-mints.
- **Uploads write to Drive on the request path.** `src/lib/reportStatementUpload.ts` caps at
  12 files × 10 MB (`:24–25`), sniffs mime by magic bytes (`:34–43`), and writes via
  `uploadBinaryFile` with `assertEntryUnderRoot` re-containment at write time.
- **Callback verification is synchronous CPU work.** `src/lib/reportResult.ts` recomputes totals
  from raw transactions (integer agorot) when `POST /api/agent/jobs/:id/result` lands. No Drive I/O.
- **`ReportJob.status` is a plain `String`** (`prisma/schema.prisma:71`):
  `uploaded|dispatched|processing|needs_review|completed|published|failed`. Not a Postgres enum —
  no migration needed to keep or reuse values.
- **Job state is already parallel-safe on the agent side.** Sessions are
  `app:plusim:report-job:<jobId>` with no `appUserId`; the skill scopes its scratch dir per job
  (`agent/skills/plusim-reports/SKILL.md:34`, `WD=/tmp/plusim-job-<jobId>`). The one shared-state
  race is the lazily rebuilt `vendor/` (`SKILL.md:23–29`).
- **Nothing caps memory anywhere.** No `Dockerfile`, no compose file, no declared limits; Coolify
  builds with its default buildpack.
- Stack: Next.js 16.2.6, Prisma 5.22.0, pnpm, Postgres, Coolify. No queue library installed.

## Design

### Stage 1 — queue + dedicated worker

1. **One new dependency: `pg-boss`.** Runs on the existing `DATABASE_URL`; creates and migrates its
   own `pgboss` schema at startup. No Prisma schema change, no Redis.
2. **New worker entrypoint** `src/worker/index.ts` + package script `"worker": "tsx src/worker/index.ts"`.
   `tsx` is required, not optional: Node's native TS support strips types but does **not**
   transform `tsconfig` `paths` aliases, and the helpers the worker reuses (`mintJobToken`,
   `callAgent`, `db`) import `@/lib/*` transitively. Deployed as a **second Coolify service from
   the same repo**, start command `pnpm worker`, replicas = 1. Deploy gate: smoke-test
   `pnpm worker` boots in the built deployment image (test 9).
3. **`run` route becomes enqueue-only, with a CAS status write (Rev 3).** Keep
   `authorizeReportsRequest`, the published+`confirmUpdate` guard, and the zero-files guard
   exactly where they are. Then:
   1. **CAS to `dispatched`** — one `updateMany` conditioned on the status the request is
      entitled to leave: `where { id, status: { in: ["uploaded", "completed", "needs_review",
      "failed"] } }` (plus the published path when `confirmUpdate` was given), `data
      { status: "dispatched", dispatchedAt: now, agentTokenHash: null, agentTokenExpiresAt: null,
      queueJobId: null }`. Count 0 → **`409 { error: "dispatch already in flight or state
      changed" }`** — a concurrent double-POST loses here, before any queue write (F7).
      Clearing the token hash closes the stale-callback window: the result route only accepts a
      callback whose token hash **equals** the stored one (`result/route.ts:38–43`), so a delayed
      callback from the previous run no-matches while the new run is queued (F8).
   2. `await boss.send('report-dispatch', { jobId })` — **no `singletonKey`** (Rev 3 removes it;
      the worker claim CAS in §4 is the single arbiter, and duplicate entries no-op there).
   3. Send threw → **conditional revert**: `updateMany where { id, status: "dispatched",
      queueJobId: null, agentTokenHash: null }` (matches only the pristine row this request just
      wrote — never a row a worker has claimed) → 502 (F7: no unconditional revert exists).
   4. Success → return **`202 { ok, status: "dispatched" }`**.

   Residual double-fault (send threw AND revert lost): job sits in `dispatched` with
   `queueJobId=null`. Recovery rule, race-safe by the same CAS pattern: the route also accepts
   `status="dispatched" AND queueJobId=null AND dispatchedAt < now−2min` in its CAS set — a
   visibly stale dispatch is reclaimable by pressing run again; a fresh one is not (F1, F7).
   Delete `maxDuration = 320` and the `callAgent` import. Token minting stays with the worker so
   the 24 h TTL starts at actual dispatch, not enqueue.
4. **Worker handler for `report-dispatch`:**
   - **Attempt ownership (F3):** new nullable column `ReportJob.queueJobId String?` (Prisma
     migration — the one schema change in this plan).
   - **Claim is a CAS — the single execution arbiter (Rev 3):** one `updateMany` with
     `where { id, OR: [ { status: "dispatched" }, { status: "processing", queueJobId: thisPgBossJobId } ] }`,
     `data { status: "processing", queueJobId: thisPgBossJobId, agentTokenHash: freshHash,
     agentTokenExpiresAt }` — claim, attempt ownership, and token mint land atomically. The
     `processing`+same-id arm lets a retry reclaim *its own* interrupted attempt (crash after
     claim, before AgentGlob accepted), re-minting (re-dispatch is safe per `run/route.ts:11`).
     Count 0 → another entry claimed first, the job was published/deleted meanwhile, or this is a
     duplicate queue entry — skip with a loud log, complete the entry. Fail closed. Duplicate
     entries are harmless by construction, which is what lets Rev 3 drop `singletonKey`.
   - `callAgent` with the same 300 s timeout semantics as today: timeout → leave `processing`
     (callback completes).
   - **Non-timeout error (F3):** on a non-final attempt, rethrow WITHOUT touching status — pg-boss
     retries and the reclaim rule above lets the retry through. Write `status="failed"` + error
     text only when `job.retryCount >= retryLimit` (final attempt). `retryLimit: 1`. No dead-letter
     queue — `ReportJob.status="failed"` is already the record the admin sees and acts on.
5. **Admin UI: no change needed.** The reports page already polls while `processing`; `dispatched`
   already renders as an in-flight state. Only the run button's success handler stops expecting an
   `agentReply` field.
6. **Upload Drive writes STAY on the request path** — a deliberate deviation from
   `REPORTS_SCALING.md` Stage 1. Worst case is 12 writes ≈ 4 s at Drive's ~3 writes/s; nowhere near
   a timeout. Moving them would force staging raw statement bytes outside Drive, breaking the
   "pointers only, no bytes in Postgres" property (`prisma/schema.prisma:91–92` comment).
   <!-- ponytail: sync uploads; revisit if upload p95 > 10s under real load -->
7. **Callback verification STAYS synchronous** — same reasoning. It is in-process integer
   recomputation with no external I/O. <!-- ponytail: sync verify; revisit if callback p95 > 5s -->

### Stage 2 — parallelize safely

8. **The dispatcher is not the work — Stage 2 is gated on agent-runtime concurrency (F5).** The
   worker only holds `callAgent` HTTP calls open; parsing, LLM judgment, workbook build, scratch
   dirs, and `vendor/` all live in the external `onlyclaw` AgentGlob runtime. So:
   - **Concurrency lever = one worker, in-process dispatch concurrency 3** (pg-boss work option).
     Holding 3 idle HTTP calls is I/O-bound; replicas of the dispatcher add nothing and are NOT
     part of this plan. Worker stays at 1 replica.
   - **Stage 2 gate (empirical, before raising concurrency above 1):** dispatch 3 jobs and confirm
     the agent runtime actually overlaps them (overlapping `prepare` phases in agent logs / three
     live `/tmp/plusim-job-*` dirs). `REPORTS_SCALING.md` explicitly leaves AgentGlob's session
     concurrency unconfirmed. If the runtime serializes sessions, dispatch concurrency stays at 1
     and adding agent runtimes becomes an owner decision outside this repo — the queue and route
     changes above are still worth shipping on their own.
9. **Memory controls go where the work runs (F5).** A Coolify memory limit on the worker
   (256 MB is plenty — it holds HTTP calls) is hygiene. The real memory watch is the **onlyclaw
   runtime host**: measure its peak during one real job (`docker stats --no-stream`) and cap it
   there before allowing 3 overlapping jobs. Coolify/host changes are owner-performed steps
   (infra, per act-vs-ask policy).
10. **Drive token bucket inside `driveFetch` (F6).** The real choke point is
    `driveFetch(url, init)` (`src/lib/googleDrive.ts:208`) — every helper routes through it,
    including the four mutating helpers Rev 1 missed (`updateTextFile`, `trashFile`,
    `updateXlsxSpreadsheet`, `uploadXlsxAsSpreadsheet`, used by rollback and both publish paths).
    A ~15-line token bucket (~3 writes/s, small burst) applied inside `driveFetch` **when
    `init.method` is anything other than GET** — reads stay unthrottled, every mutation present
    and future consumes the bucket by construction. In-process is sufficient **because every
    Drive write stays in the single-replica web app** — the worker never touches Drive.
    <!-- ponytail: in-process bucket; move to a Postgres-backed bucket the day any second process writes to Drive -->
11. **OpenAI RPM is capped indirectly** by the replica count (3 concurrent jobs ⇒ ≤3 concurrent
    judgment calls). LLM calls live inside the `onlyclaw` agent, outside this repo. Not built here.
12. **`vendor/` race (agent side): operational prerequisite.** Build `vendor/` once at agent
    deploy instead of lazily on first miss — doc change in `AGENT_SETUP.md`, no code in this repo.

## Invariants — review asks (attack these)

- **I1 — single execution (Rev 3):** the worker claim CAS is the only arbiter — two queue entries
  for one job cannot both win `dispatched → processing`. Attack: any interleaving of route CAS,
  duplicate entries, retries, and callbacks where two `callAgent` dispatches happen for one
  `dispatched` generation?
- **I2 — published-job protection survives the async move:** `confirmUpdate` is consumed at
  enqueue time, but the job can be published between enqueue and claim. The claim re-check
  (`status="dispatched"` only) must close this. Can any ordering make a queued entry dispatch a
  published job without fresh confirmation?
- **I3 — fail closed:** the worker skips any state outside the dispatchable set with a log, never
  a default dispatch.
- **I4 — token lifecycle:** minting moves to the worker; re-dispatch overwrites
  `agentTokenHash`. Can an older token (from a previous dispatch) still authenticate against
  `/api/agent/jobs/*` after a newer dispatch minted a new one?
- **I5 — crash windows (Rev 2):** a retry may reclaim its own `processing` attempt via
  `queueJobId`; a stuck `dispatched` is repairable by re-POSTing run. Remaining window to attack:
  worker dies on the FINAL attempt after AgentGlob accepted — job sits in `processing` until the
  callback lands (status quo today). Is any window still unrecoverable?
- **I6 — limiter coverage:** the bucket gates the write functions themselves inside
  `googleDrive.ts`, so no Drive write can bypass it by construction. Attack: is there any Drive
  write that does NOT go through those functions (raw `fetch` to the Drive API anywhere)?

## Tests (named; every caught hole gets one added here)

1. `run route returns 202 and enqueues without calling the agent` (module no longer imports `callAgent`)
2. `run route still 409s a published job without confirmUpdate` (regression)
3. `worker claim re-check skips a job published after enqueue` (I2)
4. `worker claim re-check skips another attempt's processing job` (I1/I5)
5. `retry reclaims its own processing attempt via queueJobId and re-mints` (F3, I5)
6. `first-attempt transient error rethrows without writing failed; final attempt writes failed + error` (F3)
7. `dispatch timeout leaves processing for the callback` (parity with today's `:80–85`)
8. `concurrent double POST from the same prior status: exactly one 202, one 409, one queue entry,
   no revert` (F7 — must exercise the overlapping-read ordering Codex named)
9. `pnpm worker boots in the built deployment image` (smoke, F4)
10. `send failure reverts only a pristine dispatched row (queueJobId and token hash still null)`
    (F7 — conditional revert can never clobber a claimed run)
11. `stale dispatched (queueJobId null, older than 2 min) is reclaimable by run; a fresh one 409s`
    (F1/F7 residual recovery)
12. `driveFetch: non-GET consumes the bucket, GET does not` (covers all six mutating helpers by
    construction, F6; spacing checked with a fake clock)
13. `delayed callback carrying the previous run's token is rejected after a rerun is enqueued`
    (F8 — cleared `agentTokenHash` no-matches `acceptingWhere`, `result/route.ts:38–43`)
14. `duplicate queue entries for one job: exactly one claims, the rest no-op` (I1, replaces the
    Rev 2 singleton test)

## Deliberately NOT building

- Stage 3 (incremental parse cache, content-hash file dedupe, batched LLM judgment, Batch API) and
  Stage 4 (SSE, chunking, DLQ UX) — separate plans; triggers live in `REPORTS_SCALING.md`.
- Moving upload Drive writes or callback verification off the request path (thresholds in §6–7).
- Postgres-backed shared token bucket (trigger in §10).
- New job statuses, Redis/BullMQ, web-app replicas, worker replicas (Rev 2 — the dispatcher is
  I/O-bound; see §8). One schema exception: the nullable `ReportJob.queueJobId` column (§4).
- Any change to the agent skill's parsing or the parser-dispatch bug (`run_job.py:225`) — separate,
  unrelated fix.

## Sequencing

1. **PR A** — this plan → Codex adversarial review → merge.
2. **PR B (all the code)** — pg-boss + worker + `queueJobId` migration + route change + the
   `driveFetch` bucket + tests 1–14. The bucket is ~15 lines and harmless at concurrency 1, so it
   doesn't earn a separate PR/review round. Deploy worker at 1 replica, dispatch concurrency 1.
3. **Stage 2 gate (owner + measurement)** — run the agent-concurrency probe (§8): dispatch 3 jobs,
   confirm overlap in the `onlyclaw` runtime; measure the runtime host's memory peak and cap it
   (owner performs host/Coolify changes). Only then raise dispatch concurrency to 3.
4. Watch Drive `403/429` and queue depth for a week before considering concurrency 5.
