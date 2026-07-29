# Plusim Report Pipeline: How Mapping Works Today and How to Make It Fast at Scale

## TL;DR
- Today, an admin uploads bank/credit-card statements, they are stored in the target user's Google Drive, and a single AgentGlob agent named `onlyclaw` parses, deduplicates, deterministically categorizes, uses an LLM only to judge unknown merchants, builds an Excel workbook, and calls back a result that the app independently re-verifies before an admin reviews and publishes it to Google Sheets — the flow is already partly async (dispatch tolerates timeouts; a callback, not the chat reply, finishes the job).
- The main scaling limits for many uploads at once are: one shared `onlyclaw` agent processing jobs largely sequentially, LLM latency for the unknown-merchant judgment, every re-run re-parsing the whole union of a job's files (no incremental processing), and synchronous Google Drive writes during the upload request — Google states plainly that you should "avoid exceeding 3 requests per second of sustained write or insert requests, per account" and that this limit "can't be increased," while all Plusim users share one owner OAuth account.
- Highest-value fixes: put a real Postgres-backed job queue (pg-boss) with a dedicated Coolify worker, run several agent lanes in parallel with a concurrency cap, parse each file once and cache it (incremental re-runs), batch the merchant-judgment into one LLM call with a cached prompt prefix (or the OpenAI Batch API), dedupe files by content hash, and stream progress instead of polling.

## Key Findings
- The pipeline is a trust-boundary design: the agent verifies before posting, and the app re-verifies from raw transactions before accepting — any mismatch becomes `needs_review`, never a silent partial report.
- It is already event-driven at the edges: `POST /admin/api/reports/:id/run` mints a per-job token and calls the agent; the agent later hits `POST /api/agent/jobs/:id/result`; the admin page polls while `processing`. This is a good async skeleton to build on.
- The chief bottleneck is not the HTTP request — it is the single `onlyclaw` agent plus per-job LLM work, and the "re-run re-parses everything" model that makes adding statements to a ready report O(all files) instead of O(new files).
- Google Drive is a shared, rate-limited resource: raw statements are written at upload time and the published workbook is exported to Sheets, all under one owner OAuth identity. Google's official Usage Limits page warns that exceeding quota returns "a 403: User rate limit exceeded HTTP status code response" and that backend checks "might also generate a 429: Too many requests response," so simultaneous uploads/publishes contend for the same quota.
- Most fixes require no new report format and no schema redesign — they move work off the request cycle, run it in parallel, and avoid repeating work.

## Details

### The current mapping process, step by step
1. **Upload.** An admin goes to `/admin/reports`, picks a target user (who must have an assigned Drive folder), and uploads statements. The shared module `lib/reportStatementUpload.ts` validates and writes each raw statement into the user's Google Drive folder using the owner's OAuth token, re-checking folder containment at write time with `assertEntryUnderRoot`.
2. **Persist pointers only.** The app creates a `ReportJob` and `StatementFile` rows that store only `driveFileId` + `driveFolderId` — no file bytes are kept in Postgres.
3. **Dispatch.** `POST /admin/api/reports/:id/run` mints a sha256-stored, 24-hour per-job token and calls `callAgent()` on the session `app:plusim:report-job:<id>` with a short message (≤3000 characters) that carries a signed manifest URL.
4. **Agent ingests.** The `onlyclaw` agent (the `plusim-reports` skill) calls `GET /api/agent/jobs/:id/manifest` (which returns the file list, taxonomy, merchant dictionary, admin `report_rules`, and the callback URL) and downloads each file via `GET /api/agent/jobs/:id/files/:fid`. Every agent call needs both the static runtime bearer token and the per-job token.
5. **Parse → dedupe → deterministic categorize.** Python parses Isracard `xlsx` and MAX `pdf` statements, deduplicates by `dedupKey` (pending-vs-billed handled), and categorizes deterministically. A hard per-merchant merchant dictionary runs first and wins.
6. **LLM judgment (the AI step).** Only the leftover unknown-merchant shortlist goes to the model, which classifies them under the household taxonomy and the admin's `report_rules`; it never guesses — anything unresolved becomes `un_categorized`. The model cannot override a category the deterministic pass already assigned.
7. **Build workbook.** Python builds an `xlsx` with per-month sheets plus formula-derived analysis/distribution/goals/helper sheets, verifies the totals to the agora (money is integer agorot end-to-end), and posts everything back via `POST /api/agent/jobs/:id/result` (transactions, totals, xlsx, proposed mappings).
8. **Independent re-verification.** The app re-verifies from the raw transactions in `lib/reportResult.ts`. Integrity failures (per-source total mismatch, unknown category, date-outside-month, duplicate dedupKey, non-xlsx) are fatal; uncategorized rows are merely reviewable. The result becomes `completed` or `needs_review`.
9. **Review + learning loop.** The admin reviews uncategorized rows and approves proposed merchant mappings. Approved mappings (or "remember" during review) are added to every future manifest, shrinking the LLM judgment tail over time.
10. **Publish.** Publish exports the verified `xlsx` to Google Sheets in the user's Drive folder; re-publish updates the same Sheet in place so the client's bookmarked link stays valid. `/report` shows published reports as native RTL tables plus an xlsx download and a Sheet link.
11. **Adding more statements (batches).** Uploading more files to a `completed`/`needs_review`/`published` job and re-running makes the agent re-parse the **union** of all the job's files, rebuild the whole workbook, and full-replace the transactions and artifact.

### Where time is spent
- **LLM judgment latency** on the unknown-merchant shortlist — the slowest per-job step, and it grows with the number of new/unknown merchants.
- **Re-parsing the full union on every re-run** — batches make each update slower because prior files are parsed again from scratch.
- **Google Drive I/O** — writing raw statements at upload time and exporting the Sheet at publish time; Drive throttles sustained writes and everything runs under one owner account.
- **Serialized agent work** — a single `onlyclaw` session means jobs effectively wait their turn.
- **Synchronous verification** — the app recomputes totals from raw transactions on the request path when the callback lands.

### Bottlenecks and limits for many simultaneous uploads
1. **Single agent, sequential jobs.** One `onlyclaw` agent runtime processes report jobs; concurrent jobs queue behind it. This is the dominant scaling ceiling.
2. **No incremental processing.** Re-runs reprocess every file in the job, so cost grows with total history, not with new data.
3. **LLM rate limits and latency.** Per-job, per-merchant judgment calls are subject to model latency and requests-per-minute limits.
4. **Google Drive quotas.** Google publishes Drive query limits of 12,000 queries per 60 seconds (both overall and per user) and a hard sustained-write ceiling of ~3 writes/second per account that "can't be increased." Every user's files go through one owner OAuth identity, so uploads/publishes contend for that shared quota and can hit `403`/`429`.
5. **Next.js request timeouts.** Writing many files to Drive inside the upload request, or doing verification synchronously, risks hitting the route's max duration under load.
6. **Full-replace result callback.** Large jobs write one big transaction; many landing together add database contention.

### Stack-grounded notes
- **Next.js 16** offers `after()` to defer work past the response, but on a persistent Coolify Node server a durable queue is more reliable than fire-and-forget for anything that must not be lost.
- **pg-boss** is a Postgres-backed queue whose docs state it "relies on Postgres's SKIP LOCKED, a feature built specifically for message queues," giving "exactly-once delivery and the safety of guaranteed atomic commits" with no extra infrastructure (no Redis) — a natural fit next to the existing Prisma/Postgres and Coolify setup, where you can run a dedicated worker container.
- **OpenAI Batch API** — per OpenAI's own FAQ, "Each model will be offered at 50% cost discount vs. the synchronous APIs," its "rate limits are completely separate from existing limits," and results return within a 24-hour window that "we currently cannot change." Good for non-urgent bulk classification.
- **Prompt caching** — per OpenAI, "By reusing recently seen input tokens, developers can get a 50% discount and faster prompt processing times," applied automatically "on prompts longer than 1,024 tokens" by caching "the longest prefix." OpenAI advises structuring prompts "with static or repeated content at the beginning and dynamic, user-specific content at the end" and using `prompt_cache_key` consistently — exactly the shape of Plusim's taxonomy + rules + dictionary prefix.
- **OpenClaw/AgentGlob** supports multiple isolated sessions/agents, which is the lever for running report jobs in parallel lanes.

## Recommendations
Do these in order; each stage lists the signal that should push you to the next.

**Stage 1 — Get heavy work off the request cycle (do first).**
- Add **pg-boss** and a **dedicated worker process/container on Coolify**. Change `POST .../run` and the upload route to enqueue a job and return `202 Accepted` immediately with a job id. Move Drive writes, dispatch, and result verification into the worker.
- Keep the existing callback (`/api/agent/jobs/:id/result`) — it is already a webhook and is the right pattern.
- *Move to Stage 2 when:* uploads no longer time out and the UI returns instantly, but throughput is still limited because jobs run one at a time.

**Stage 2 — Parallelize safely.**
- Run **several agent lanes** (multiple `onlyclaw` sessions/agents) and let the worker pull jobs concurrently, with a **concurrency cap** (start at 3–5) so you respect Drive and OpenAI limits.
- Add a **token-bucket limiter and exponential backoff** for Google Drive writes (stay under Google's ~3 sustained writes/second per account) and for OpenAI RPM.
- *Move to Stage 3 when:* several jobs run in parallel but each large re-run is still slow.

**Stage 3 — Stop repeating work.**
- **Incremental parsing:** parse each `StatementFile` once and cache its parsed transactions (keyed by a content hash), so a re-run only parses **new** files and merges with cached rows. This turns batch updates from O(all files) into O(new files).
- **File-level deduplication:** compute a **SHA-256 of each upload**; skip storing/parsing an identical statement. (Transaction-level dedup by `dedupKey` already exists.)
- **Batch the LLM judgment:** send the whole unknown-merchant shortlist in **one structured-output call** instead of many, and put the taxonomy + rules + dictionary as a **stable cached prefix** (OpenAI caches prefixes ≥1,024 tokens for a 50% input discount and lower latency). For non-urgent bulk backfills, use the **OpenAI Batch API** for its 50% discount and separate, higher rate-limit pool.
- *Move to Stage 4 when:* processing is fast and cheap but users want live feedback.

**Stage 4 — Better UX and resilience.**
- Replace client polling with **server-sent events (SSE)** or a worker-updated `progress` field (per-file progress).
- For very large batches, optionally **chunk** into per-source sub-jobs processed in parallel and merged — but only if the full-replace merge semantics are preserved.
- Add **retries with backoff and a dead-letter queue** (native to pg-boss) so a single bad statement or a transient Drive/OpenAI error doesn't fail the whole batch.

**Thresholds that change the plan.**
- If jobs regularly exceed the route's max duration even after Stage 1 → prioritize Stage 2 immediately.
- If OpenAI cost or rate-limit errors dominate → jump to the Batch API and prompt caching in Stage 3.
- If Drive `429`s appear → consider distributing writes across multiple service-account identities or requesting a quota increase, in addition to the token bucket.

## Caveats
- This analysis is based on the repository's authoritative `REPORTS_PIPELINE.md` (the stated source of truth) and standard behavior of the named stack. Exact concurrency, timeout, and rate-limit constants in code should be verified directly before implementation.
- Whether the `onlyclaw` agent is strictly one-at-a-time or can already fan out is described at the design level; confirm in code before sizing the concurrency cap.
- Drive quota figures are Google's published defaults and can differ for a specific project; verify your project's actual quotas before tuning the token bucket.
- The Batch API's 24-hour window is unsuitable for interactive, admin-is-waiting categorization — reserve it for bulk/backfill runs; keep synchronous or fast-batched calls for live report generation.
