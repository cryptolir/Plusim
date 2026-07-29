# Plan: Reports scaling — Stage 1 (queue + worker) and Stage 2 (safe parallelism)

**Rev 2** — 2026-07-29. Source analysis: [`docs/REPORTS_SCALING.md`](../REPORTS_SCALING.md)
(incl. its Code-verified findings section). Scope: stages 1–2 only; stages 3–4 are separate plans.

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
3. **`run` route becomes enqueue-only.** Keep `authorizeReportsRequest`, the published+`confirmUpdate`
   guard, and the zero-files guard exactly where they are. Then, in this order (F1 — the worker
   must never see a queue entry before the status is committed):
   1. Commit `status="dispatched"` + `dispatchedAt` + `queueJobId=null`.
   2. `const qid = await boss.send('report-dispatch', { jobId }, { singletonKey: jobId })`.
   3. `qid === null` means an active singleton suppressed the send (a previous run's queue entry
      is still live — possible because the agent posts its callback *before* replying, per
      `SKILL.md`). **Revert the status to its prior value and return
      `409 { error: "previous run still finishing — retry shortly" }`** (F2). Never leave
      `dispatched` with no queue entry behind it.
   4. Enqueue threw → revert status, return 502.
   5. Success → return **`202 { ok, status: "dispatched" }`**.

   Recovery backstop for any remaining crash window (status committed, revert also lost): the
   route's dispatchable set now **includes `dispatched`**, so re-POSTing run on a stuck job is
   always a legal, idempotent repair — no janitor process (F1).
   Delete `maxDuration = 320` and the `callAgent` import. Token minting moves to the worker so the
   24 h TTL starts at actual dispatch, not enqueue.
4. **Worker handler for `report-dispatch`:**
   - **Attempt ownership (F3):** new nullable column `ReportJob.queueJobId String?` (Prisma
     migration — the one schema change in this plan). On claim, the handler stamps its pg-boss job
     id into `queueJobId` alongside `status="processing"` in one update.
   - **Claim guard:** proceed if `status="dispatched"`, **or** `status="processing" AND
     queueJobId === this pg-boss job id` — a retry may reclaim *its own* interrupted attempt
     (crash after `processing` was written, before AgentGlob accepted), re-minting the token
     (re-dispatch is safe per `run/route.ts:11`). Anything else (published meanwhile, deleted,
     another attempt's `processing`) → skip with a loud log, complete the queue entry. Fail closed.
   - Mint the per-job token (same `mintJobToken()`), `callAgent` with the same 300 s timeout
     semantics as today: timeout → leave `processing` (callback completes).
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

- **I1 — single execution:** no path lets one job dispatch twice concurrently. Route guard +
  `singletonKey` + claim-time re-check. Is there a window between callback completion (status
  leaves `processing`) and a re-run enqueue where two queue entries for one job can both run?
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
8. `double POST run while queued yields one execution` (singletonKey, I1)
9. `pnpm worker boots in the built deployment image` (smoke, F4)
10. `enqueue failure reverts status; a stuck dispatched job accepts a re-run` (F1)
11. `send suppressed by active singleton returns 409 and preserves prior status` (F2 — the
    callback-before-reply rerun window)
12. `driveFetch: non-GET consumes the bucket, GET does not` (covers all six mutating helpers by
    construction, F6; spacing checked with a fake clock)

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
   `driveFetch` bucket + tests 1–12. The bucket is ~15 lines and harmless at concurrency 1, so it
   doesn't earn a separate PR/review round. Deploy worker at 1 replica, dispatch concurrency 1.
3. **Stage 2 gate (owner + measurement)** — run the agent-concurrency probe (§8): dispatch 3 jobs,
   confirm overlap in the `onlyclaw` runtime; measure the runtime host's memory peak and cap it
   (owner performs host/Coolify changes). Only then raise dispatch concurrency to 3.
4. Watch Drive `403/429` and queue depth for a week before considering concurrency 5.
