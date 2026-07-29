# Plan: Reports scaling — Stage 1 (queue + worker) and Stage 2 (safe parallelism)

**Rev 1** — 2026-07-29. Source analysis: [`docs/REPORTS_SCALING.md`](../REPORTS_SCALING.md)
(incl. its Code-verified findings section). Scope: stages 1–2 only; stages 3–4 are separate plans.

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
2. **New worker entrypoint** `src/worker/index.ts` + package script `"worker"`. Run it with Node's
   native TS support (`node --experimental-strip-types`, Node ≥ 22.6) if Coolify's Node allows;
   only fall back to adding `tsx` if it doesn't. Deployed as a **second Coolify service from the
   same repo**, start command `pnpm worker`, replicas = 1 in Stage 1.
3. **`run` route becomes enqueue-only.** Keep `authorizeReportsRequest`, the published+`confirmUpdate`
   guard, and the zero-files guard exactly where they are. Replace the mint+`callAgent` block with:
   `boss.send('report-dispatch', { jobId }, { singletonKey: jobId })`, set
   `status="dispatched"` + `dispatchedAt`, return **`202 { ok, status: "dispatched" }`**.
   Delete `maxDuration = 320` and the `callAgent` import. Token minting moves to the worker so the
   24 h TTL starts at actual dispatch, not enqueue.
4. **Worker handler for `report-dispatch`:**
   - Re-load the job and **re-check state at claim**: proceed only if `status="dispatched"` and
     file count > 0. Anything else (published meanwhile, deleted, already processing) → skip with a
     loud log, complete the queue job. Fail closed — never dispatch on a stale claim.
   - Mint the per-job token (same `mintJobToken()`), set `status="processing"`, `callAgent` with the
     same 300 s timeout semantics as today: timeout → leave `processing` (callback completes);
     non-timeout error → `status="failed"` + error text (mirrors `run/route.ts:78–91`).
   - pg-boss options: `retryLimit: 1` (transient dispatch errors get one retry — safe per the
     re-mint property), then `status="failed"` + error text. No dead-letter queue —
     `ReportJob.status="failed"` is already the record the admin sees and acts on.
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

8. **Concurrency = worker replicas, not in-process lanes.** Scale the worker service in Coolify to
   3 replicas. pg-boss claims jobs with `SKIP LOCKED`, so exactly one replica owns each job;
   `singletonKey: jobId` additionally makes enqueue idempotent while a job is queued/active.
   Replicas get filesystem/memory isolation free; a dying job kills only its own container.
9. **Memory limit before the first extra replica.** Set an explicit per-worker limit in Coolify
   (start 768 MB) and measure one real job's peak (`docker stats --no-stream`) before choosing the
   final number. Prerequisite, not tuning — an unbounded worker lets the OOM killer pick Postgres.
   Coolify UI changes are owner-performed steps (infra, per act-vs-ask policy).
10. **Drive token bucket, in-process, at the choke point.** A ~15-line token bucket (~3 writes/s,
    small burst) **inside `src/lib/googleDrive.ts` itself**, gating its own write/export functions
    (`uploadBinaryFile`, `createTextFile`, the Sheets export used by publish). Gating at the choke
    point makes bypass structurally impossible — no call-site audit needed. In-process is
    sufficient **because every Drive write stays in the single-replica web app** — the worker never
    touches Drive (dispatch and callback don't do Drive I/O).
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
- **I5 — crash windows:** worker dies after setting `processing` but before/during `callAgent`.
  pg-boss retry re-runs the handler — but the claim re-check refuses `processing`. Does that
  strand the job in `processing` forever, and is that acceptable (status quo today on timeout) or
  does it need a janitor?
- **I6 — limiter coverage:** the bucket gates the write functions themselves inside
  `googleDrive.ts`, so no Drive write can bypass it by construction. Attack: is there any Drive
  write that does NOT go through those functions (raw `fetch` to the Drive API anywhere)?

## Tests (named; every caught hole gets one added here)

1. `run route returns 202 and enqueues without calling the agent` (module no longer imports `callAgent`)
2. `run route still 409s a published job without confirmUpdate` (regression)
3. `worker claim re-check skips a job published after enqueue` (I2)
4. `worker claim re-check skips a job already processing` (I1/I5)
5. `dispatch error sets failed with error text` (parity with today's `:87–90`)
6. `dispatch timeout leaves processing for the callback` (parity with today's `:80–85`)
7. `double POST run while queued yields one execution` (singletonKey, I1)
8. `drive write bucket spaces 10 concurrent writes to ≤3/s` (fake clock)

## Deliberately NOT building

- Stage 3 (incremental parse cache, content-hash file dedupe, batched LLM judgment, Batch API) and
  Stage 4 (SSE, chunking, DLQ UX) — separate plans; triggers live in `REPORTS_SCALING.md`.
- Moving upload Drive writes or callback verification off the request path (thresholds in §6–7).
- Postgres-backed shared token bucket (trigger in §10).
- New job statuses, Prisma schema changes, Redis/BullMQ, web-app replicas, in-process worker lanes.
- Any change to the agent skill's parsing or the parser-dispatch bug (`run_job.py:225`) — separate,
  unrelated fix.

## Sequencing

1. **PR A** — this plan → Codex adversarial review → merge.
2. **PR B (all the code)** — pg-boss + worker + route change + the inline Drive bucket + tests 1–8.
   The bucket is ~15 lines and harmless at 1 replica, so it doesn't earn a separate PR/review round.
   Deploy worker at 1 replica. Measure: worker peak memory during a real job, dispatch latency,
   upload p95.
3. **Owner step** — set worker memory limit in Coolify from the measurement; scale to 3 replicas.
4. Watch Drive `403/429` and queue depth for a week before considering 5 replicas.
