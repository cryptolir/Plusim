# Plusim — Scaling the report pipeline to large statement sets

> **Status:** **Rev 2 — revised after Codex round 1** (2026-10-26).
>
> **Process** (self-contained): plan PR → adversarial review → each round becomes a new Rev on
> this branch with resolution notes → every caught hole becomes a named test the implementation
> PR must carry → once approved, implement exactly the plan, in the staged PRs listed under
> *Delivery*.
>
> **Review log:**
> - Rev 2 — **Codex round 1** (3 findings, all accepted):
>   **P1** the balance-keyed *set union* silently removes a real row when one export holds
>   `purchase ₪10 → 90`, `refund → 100` and another holds a second identical `purchase → 90` on
>   the same date (reproduced by the reviewer) — **cross-file dedup is now a per-day partition
>   driven by each export's printed period, never a set union over row content, and an ambiguous
>   day refuses the merge naming the files** (Decisions 1–3, A1; tests
>   `test_split_export_with_repeating_balance_keeps_both_purchases` and four more).
>   **P1** v2 `commit` reused v1's CAS, so a commit that already loaded upload A could finalize it
>   after a concurrent `begin` superseded it with B — **every v2 write now claims the job row with
>   `resultUploadId === uploadId` in the same statement, and `commit` claims before it reads the
>   stage** (B5; test `test_commit_after_superseding_begin_is_rejected`).
>   **P2** staging was bounded only at commit — **bounded at ingestion**: `seq` range, per-chunk
>   rows/bytes, cumulative row/byte quota checked atomically under the job-row lock, a single
>   artifact slot (B1, B5; tests `test_chunk_over_quota_is_rejected_before_persistence`, …).
> - Rev 1 — authored from (a) an overlapping-export experiment on the two real bank statements
>   and (b) a 1k / 5k / 20k synthetic scale measurement of the current pipeline, both below, plus
>   a file-anchored read of the caps. Minimalism pass done by hand (the `ponytail-review` skill is
>   not available in this environment); cuts are listed at the end.

## Evidence

### E1 — overlapping exports of one account (measured, 2026-10-26)

The real Hapoalim (147 rows) and Leumi (134 rows) statement text was split into two exports of
the **same account** with overlapping periods and run through the real `cmd_prepare` →
`cmd_finalize --dry-run`, then the resulting payload through the app's real `parseAgentResult` +
`verifyAgentResult`.

| Scenario | File 1 / File 2 rows | Overlap | Rows emitted vs. physical | Colliding dedup keys | Skill status | App `fatal` |
|---|---|---|---|---|---|---|
| Hapoalim, overlap | 100 / 97 | 50 | 197 vs 147 (**+50 double-counted**) | 50 | `needs_review` (50 problems) | **true** |
| Leumi, overlap | 90 / 94 | 50 | 183 vs 134 (**+49**) | 49 | `needs_review` (49 problems) | **true** |
| Hapoalim, **adjacent, no overlap**, boundary splits two identical same-day rows | 10 / 137 | 0 | 147 vs 147 | **1 (false positive)** | `needs_review` | **true** |
| Hapoalim, overlap = 2nd member of an identical pair | 11 / 137 | 1 | 148 vs 147 | 1 (wrong row matched) | `needs_review` | **true** |

Findings:

1. **Overlap is always fatal, never silent.** The per-file key `label|date|description|amount|seq`
   (`parse_bank_pdf.py:263-272`, `seq` restarts per file) collides, so `verify_report.py:45` and
   `reportResult.ts` raise `duplicate dedupKey`; `publish/route.ts` refuses a fatal job. Nothing
   double-counts into a published report — but **the job cannot be published without
   hand-deleting a file**, and the report-update flow (`REPORTS_PIPELINE.md`: "add a statement, re-run
   the union") makes overlapping exports the *normal* case.
2. **The key is also wrong in the other direction** (row 3): two *adjacent* exports that meet exactly
   between two identical same-day rows (Hapoalim has real ones: two ₪5,730 `ביטוח לאומי` credits on
   22/09, 28/08, 28/07) collide although every row is distinct. Any "fix" that simply drops the
   later key would **silently lose a real ₪5,730 row** — an undercount nothing downstream detects.
3. `cmd_prepare` only warns `duplicate source label … across files` (`run_job.py:514`) and
   overwrites `source_totals[label]` — the two files are never related to each other.
4. The Leumi parser excluded file 1's oldest row (`oldest row — no older balance and no sibling`)
   although file 2 contains that very row with a valid neighbour: information the second file
   had was thrown away.
5. A **running balance after each row** is printed by both banks and distinguishes the two identical
   ₪5,730 credits — but (Codex, Rev 2) it does **not** make a row unique in general: a purchase, its
   refund and an identical second purchase on one day repeat `(date, description, amount, balance)`.
   Balance is therefore a *within-file ordering/consistency* signal, not a cross-file identity.
6. The row-count splits in E1 rows 3–4 are adversarial stress cases; **real exports are day-granular**
   (each prints its period: Hapoalim `06/10/2026-06/04/2026`, Leumi `בין התאריכים 01.03.26-06.10.26`).
   Rev 2's merge uses exactly that.

### E2 — current pipeline at scale (measured, synthetic Hapoalim-shaped, no PII)

| Rows | `prepare` | `finalize` | Peak Python mem (traced) | `result.json` (xlsx b64) | `needs_judgment.json` |
|---|---|---|---|---|---|
| 1,000 | 0.1 s | 0.3 s | 5 MB | 0.4 MB (0.1) | — |
| 5,000 | 0.4 s | 1.3 s | 25 MB | 1.9 MB (0.5) | **367 KB (580 merchants)** |
| 20,000 | 1.4 s | 5.8 s | 98 MB | 7.6 MB (1.9) | grows with distinct merchants |
| 50,000 | 3.6 s | 16.0 s | 240 MB | 18.9 MB (4.6) | — |

(Timings are without `tracemalloc`; memory is from a separate traced run. A first pass with
`tracemalloc` on read ~5× slower — corrected here, and the profile agrees: `build_workbook` is
≈ 86 % of `finalize`.)

- Python scales **linearly** and is **fast**: 50,000 rows in ≈ 20 s. The app side is trivial: `parseAgentResult` ≤ 40 ms, `verifyAgentResult`
  ≤ 20 ms, `buildAnalysis` ≤ 30 ms at 5,000 rows. **Compute is not the limit. The caps are.**
- **Caps found** (all hard rejects, none documented to the admin): `MAX_TXNS = 5000`
  (`reportResult.ts:125`, the 5,000th row passes, the 5,001st is rejected — and a 5,000-row
  synthetic job emits 4,989 + 11 settlements, i.e. sits *on* the line); settlements ≤ 2000;
  `intAgorot` rejects `|v| ≥ 1,000,000,000` (`:139`) and is also applied to each source's **net
  total** — two ₪9,999,999.99 rows (a ₪20 M source) are rejected as `bad totals` (verified);
  xlsx base64 ≤ 20 MB (`:239`) / 15 MB decoded (`:567`); merchant dictionary `take: 2000`
  (`manifest/route.ts:29`); result route `maxDuration = 60` (`result/route.ts:23`).
- **Judgment context**: 580 unresolved merchants = 367 KB ≈ 90–120 k tokens to read and a similar
  amount to write, in one pass (`SKILL.md` step 3 writes one `judgments.json`).
- **Admin UI**: `ReportJobDetail` re-fetches the **whole job including every transaction every 10 s,
  unconditionally** (`ReportJobDetail.tsx:140-165`) and renders all rows (`:479-493`);
  `ReportView` receives every row as a prop (`view/page.tsx:93`).

## Goal

A job built from many large statements — overlapping exports, tens of thousands of rows, hundreds of
merchants — runs end to end, fails **loudly and by file name** when it cannot, and stays correct to
the agora. Targets (chosen from E2's linear extrapolation, to be re-measured by the fixture):
**50,000 transactions per job** (measured ≈ 20 s of `prepare` + `finalize`, a >10× margin under the
agent exec ceiling of 300 s — so the cap is chosen by what the request, the database and the admin
UI tolerate, **not** by Python speed), no step holding more than ~200 rows in
the model's context or ~1,000 rows in a request body.

## Decisions (defaults — to be attacked)

1. **A bank row's key includes the running balance** — `label|date|description|amount|balance_after`
   (+ `|seq` only on an exact repeat **within one file**, e.g. Codex's purchase/refund/purchase). The
   app-side `duplicate dedupKey` guard keeps working per file; the key is *not* used to decide
   whether two files hold the same physical row.
2. **Cross-file dedup is a per-day partition, not a set union.** Each export declares its period
   `[from, to]` (parsed from its header; fallback: min/max row date, which can only under-claim).
   For every calendar day, rows are taken from **exactly one** export — the one covering that day
   with the **latest `to`** (most recent export; ties → manifest order). Every *other* export that
   covers that day must hold a **contiguous, order-preserving sub-sequence** of the chosen export's
   rows for that day (allowing an earlier export generated mid-day on its last day); anything else
   — a different count, order or content — is an **ambiguous merge and `prepare` refuses**, naming
   the two files and the day, rather than guessing which rows are real. Days covered by one export
   only are taken as-is. Rows are never removed on content equality alone.
3. **Completeness across files is the chain, not file order.** After the partition, every row except
   the overall oldest must have a successor row whose `balance_after == balance + amount`; a row
   without one is a **gap warning naming the date**, and a day claimed by no export between two
   periods is reported as an uncovered range. The check assumes no ordering of files. It is a
   completeness *warning*, never the reason a row is kept or dropped (Codex's example passes it).
4. **Judgment is batched, ordered by money, and its coverage is reported**; the model never sees
   more than one batch.
5. **The merchant dictionary is resolved server-side**: the agent sends the distinct merchants it has,
   the server answers only for those. No cap on dictionary size; no dictionary in the manifest for a
   new skill.
6. **Results upload in chunks and the workbook is a separate artifact upload.** v2 protocol for large
   jobs; **v1 (single POST, ≤ 5,000 rows) stays working** for old skills. Caps are raised to
   explicit, documented numbers — never removed.
7. **Parse results are cached per file in the app DB**, keyed to that file row + its content hash +
   a parser-code hash. Never shared across files or jobs.
8. **Every per-file failure names the file** and stops the run before anything partial is reported.
9. **The admin tables paginate server-side**, and polling reads status + counts only.
10. **OCR is out of scope.** This plan adds only the seam that makes a scanned PDF a *named,
    specific* error instead of "unrecognized PDF".

## Hard boundary

Per AGENTS.md rule 0 only Plusim files change; the skill reaches the onlyclaw workspace through the
`AGENT_SETUP.md` §7 re-install (new/changed files listed under Phase D). The platform-side PDF/OCR
capability (`cryptolir/openclaw-dashboard#811`) is not touched and nothing here depends on it.

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| `bank_rows.py` (`check_balance_chain`, `classify_bank_row`) | the merge + cross-file gap check live next to them |
| `ParseResult` / `Txn` (`parse_isracard_xlsx.py`), `charge_cycles`, `bank_labels` | the cached payload shape |
| `authorizeAgentJobRequest`, `acceptingWhere` CAS (`result/route.ts:40`) | every new agent route; the v2 commit reuses the CAS verbatim |
| `parseAgentResult` / `verifyAgentResult` / `decodeXlsx` | v2 commit runs the **same** functions over the assembled rows |
| `authorizeReportsRequest`, `AGENT_OWNS_ROWS` write predicate | the admin pagination route |
| `safe_workdir`, `UnknownStatementError` (`run_job.py`) | per-file error naming |
| `pendingReplyPickup`-style bounded polling | none — polling shrinks, it is not extended |

## Plan

### Phase A — agent skill (`agent/skills/plusim-reports/scripts/`)

- **A1. Balance-keyed keys and the per-day cross-file merge.**
  - `parse_bank_pdf._emit` (`:260-272`) and `parse_discount_xlsx` fallback key: `…|<balance_after>`;
    `Txn` gains `balance_agorot` (bank rows). `ParseResult` gains `periods: dict[label, (from, to)]`:
    Hapoalim's `dd/mm/yyyy-dd/mm/yyyy` line and Leumi's `בין התאריכים dd.mm.yy-dd.mm.yy` line,
    taking min/max of the two dates (printed direction differs by RTL); no printed period ⇒
    min/max row date.
  - `bank_rows.merge_bank_exports(results) -> (merged_results, notes, warnings)`: group by bank
    label; for each day choose the export per Decision 2; verify the other covering exports' rows
    for that day are an order-preserving contiguous sub-sequence (full key **and** Leumi
    reference compared); on violation raise `AmbiguousBankMergeError(file_a, file_b, day, detail)`.
    One non-blocking note per merged label — `"N שורות חופפות מהקבצים <f1> ו־<f2> (<from>–<to>) לא נספרו פעמיים"`
    — goes into `agentNotes` and the `prepare` summary (`bankOverlapRemoved: n`). Called from
    `cmd_prepare` after the file loop (`run_job.py:436-520`), replacing today's bare
    `duplicate source label` warning (`:514`) for bank sources (card sources keep it).
  - Chain check across the merged rows (Decision 3). The Leumi "oldest row excluded" rule is
    unchanged; a neighbour export now supplies that row as a normal row, and without one the gap
    warning names it (E1-4).
  - Different accounts that share a last-4 collapse to one label; their periods overlap with
    different content, so the merge **refuses** rather than mixing them — the right outcome.
- **A2. Judgment batching.** `prepare` writes `needs_judgment.json` as an index
  (`{reportRules, batches: n, entries: m}`) and `judgment_batches/batch-NNN.json`, **≤ 40 entries
  each, ordered by Σ|amount| descending**, each entry gaining `count` and `totalAgorot`. New
  `run_job.py judge-status --workdir` prints `{batches, judgedBatches, entriesJudged, remaining}`.
  `finalize` merges `judgments.json` **and** every `judgments-NNN.json` (a key in two files is a
  warning; a key not in the shortlist is a warning), and states coverage in `agentNotes`:
  `"N בתי עסק לא נבדקו — נשארו ללא סיווג"`. `SKILL.md` step 3 becomes a loop (read batch → write
  `judgments-NNN.json` → next) with the same never-guess rule. A job with ≤ 40 entries is one batch:
  the small-job flow is unchanged in effect.
- **A3. Server-side dictionary.** After parsing, `prepare` collects the distinct normalized merchants
  of expense rows and calls the manifest's `dictionaryResolveUrl` in chunks of 500
  (`POST {merchants:[…]}` → `{hits:{merchant: category}}`); `categorize()` consumes the merged hits
  exactly as it consumes `dictionary` today (`run_job.py:523-527`). **Fallback:** a manifest without
  `dictionaryResolveUrl` (old app) uses the inline `merchantDictionary`, byte-for-byte today's path.
- **A4. Per-file parse cache.** Manifest file entries gain `sha256`, `parsedUrl`. For each file:
  `GET parsedUrl?v=<PARSER_VERSION>`; **hit** ⇒ skip download and parse; **miss** ⇒ download, parse,
  `PUT` the serialized `ParseResult` (transactions, source totals, charge cycles, bank labels,
  warnings, **and the `sourceLabel` it was parsed under**). `PARSER_VERSION` = sha256 of the bytes
  of `parse_*.py`, `bank_rows.py`, `parse_isracard_xlsx.py` computed at start — it cannot be
  forgotten when a parser changes. Cached rows go through the identical merge → categorize →
  verify path, so a stale or tampered cache is caught by the same checks as fresh rows
  (card sources: Σ = printed total; banks: chain).
- **A5. Per-file limits and named errors.** `parse_with_limits(name, fn)`: `signal.setitimer`
  timeout per file (default 120 s, env `PLUSIM_PARSE_TIMEOUT_S`), page cap (default 600 pages),
  and a `ParseFileError(name, reason)` wrapping **any** exception from download or parse:
  `"<name>: parse timed out after 120s"`, `"<name>: unreadable PDF (<exception class>)"`,
  `"<name>: more than 600 pages"`. `cmd_prepare` aborts on the first failure with that message
  (no partial report), which rides the existing `FAILED <jobId> <reason>` path
  (`SKILL.md` failure handling) into `ReportJob.error`. **OCR seam:** a PDF whose pages carry
  < 20 characters of text raises `ScannedPdfError(name)` →
  `"<name>: קובץ PDF סרוק (אין בו שכבת טקסט). הפרסר אינו מבצע OCR — ייצאו מחדש מאתר הבנק/החברה"`,
  checked in `parse_pdf_auto` before the generic "unrecognized PDF" refusal.
- **A6. Result v2 client + workbook.** When the manifest carries `callback.beginUrl`, `finalize`
  uploads via v2 (below): rows in chunks of 1,000, then the workbook bytes, then commit. Otherwise
  the single POST. `build_workbook` is unchanged (86 % of finalize, linear; 50 k ≈ 14 s is far inside
  the budget) — `openpyxl` write-only mode is a recorded later option, not part of this plan.

### Phase B — app (trust boundary)

- **B1. Schema** — one migration `report_scale`:
  ```
  StatementFile       + sha256 String?                       // set at upload; null on old rows ⇒ no cache
  ParsedStatement     { id, fileId → StatementFile (cascade), parserVersion String,
                        sourceLabel String?, payload Json, createdAt;
                        @@unique([fileId, parserVersion]) }
  ReportResultStage   { id, jobId → ReportJob (cascade), uploadId String, kind String, // "rows"|"artifact"
                        seq Int, size Int, rowCount Int, payload Json?, bytes Bytes?, createdAt;
                        @@unique([jobId, uploadId, kind, seq]) }
  ReportJob           + resultUploadId String?
  ```
- **B2. Upload hash and exact-duplicate refusal.** `reportStatementUpload.ts` computes sha256 of the
  bytes it already holds; the same bytes already on **this job** ⇒ 409 (Hebrew) "הקובץ כבר הועלה
  לעבודה הזו". (Cheapest overlap fix of all: an identical re-upload never reaches the parser.)
- **B3. Dictionary route** — `POST /api/agent/jobs/[jobId]/dictionary`, `authorizeAgentJobRequest`;
  body `{merchants: string[]}`, 1–500 strings of ≤ 200 chars; `merchantMapping.findMany({ where: {
  approved: true, merchantPattern: { in } } })`; **returns only** categories in the merged valid
  set and **not** in an income leaf (the skill's own rule). The manifest keeps inline
  `merchantDictionary` (top 2,000, **deprecated, kept for old skills**) and adds
  `dictionaryResolveUrl`, `callback.beginUrl`, `files[].sha256`, `files[].parsedUrl`.
- **B4. Parse cache routes** — `GET|PUT /api/agent/jobs/[jobId]/files/[fileId]/parsed?v=`: bound to
  `{ id: fileId, jobId }` of the authorized job; `PUT` accepted only when the row has a `sha256`
  and the `parserVersion` is a 64-hex string; payload ≤ 20 MB; stored with `upsert`.
- **B5. Result v2** — every route runs `authorizeAgentJobRequest`, and **every write is one
  interactive `$transaction` whose first statement claims the job row** — an `updateMany` on
  `{ id, status in (dispatched|processing), agentTokenHash, resultUploadId: <uploadId> }`
  (`begin` is the exception: it claims on the v1 predicate and **sets** `resultUploadId`).
  `count 0` ⇒ 409 and nothing else in that transaction runs. The claim takes the job row's lock
  until the transaction ends, so `begin`, `chunk` and `commit` are **serialized against each other**
  and against the result route / publish / run CASes (Codex P1: a commit can no longer finalize an
  upload that a concurrent `begin` has superseded — it either claims first, and the later
  `begin` then fails the status predicate, or loses the claim and is rejected).
  - `POST …/result/begin` — claim on the v1 predicate; `stage.deleteMany({ jobId })`; mint
    `uploadId`; set `resultUploadId`; return `{uploadId}`.
  - `POST …/result/chunk?u=` — claim as above, then **ingestion quotas, inside the same
    transaction (so under the lock — atomic, no check-then-write gap)** (Codex P2): `seq` an
    integer in `[0, 50)`; rows per chunk ≤ 1,000; request body ≤ 2 MB; staged rows for this
    `(jobId, uploadId, "rows")` plus this chunk (minus the chunk it replaces) ≤ 50,000 and staged
    bytes ≤ 64 MB (aggregates of the `rowCount` / `size` columns); violation ⇒ **413 before
    persistence**. A chunk is idempotent per `seq` (replace). Rows are parsed with the same per-row
    parser as v1 (extracted from `parseAgentResult`) *before* the transaction opens.
  - `PUT …/result/artifact?u=` — same claim; **a single slot** (`seq` fixed at 0, replace allowed);
    raw bytes, `decodeXlsx`-checked, ≤ 40 MB, counted in the same 64 MB budget.
  - `POST …/result/commit` — body `{uploadId, chunks, txCount, settlements, sourceTotals,
    proposedMappings, status, agentNotes, xlsxFilename}`. One transaction: **(1) claim** with
    `resultUploadId: uploadId`, setting `resultUploadId = null` in that same statement (so no later
    `chunk` can touch it and a second `commit` cannot claim); **(2) only then load the stage**
    `0..chunks-1` (gap or `Σ rowCount ≠ txCount` ⇒ throw ⇒ rollback ⇒ the claim is undone and 409);
    **(3)** assemble an `AgentResult`, run the v1 caps-aware parse and **`verifyAgentResult`
    unchanged**; **(4)** the same writes as v1 (delete rows/settlements/artifact → `createMany` in
    batches of 3,000 → artifact from the staged bytes → delete this upload's stage rows → job update
    with status/verification). `maxDuration = 120`.
  - **Caps (explicit)**: v1 unchanged (5,000 rows). v2: `MAX_TXNS_V2 = 50,000`, `MAX_SETTLEMENTS_V2 =
    10,000`, per-source net total `|v| < 10¹²` agorot (a **separate** `intTotalAgorot`; the per-row
    `|v| < 10⁹` stays — E2 shows the row cap is not the problem, the sum cap is), artifact ≤ 40 MB.
  - **Stored verification is bounded**: `problems` / `notes` persisted to `ReportJob.verification`
    are truncated to the first 200 each with `problemsTotal` / `notesTotal`; `fatal` is computed
    from the full list. (At 50 k rows one systematic fault would otherwise write 50 k strings into a
    Json column the admin page polls.)
- **B6. Admin transactions route** — `GET /admin/api/reports/[jobId]/transactions?page&pageSize(≤200)
  &q&filter=all|uncategorized&month&leaf…`, `authorizeReportsRequest`; `orderBy [{month},{date},{id}]`,
  `skip/take`; returns `{rows, total}`. The job-detail GET (`[jobId]/route.ts`) stops selecting
  `transactions` and returns `transactionCounts {total, uncategorized}`; the settlement list and
  everything else stay.
- **B7. Unchanged on purpose**: publish route, run route, admin edit route, `resultMergedSet` /
  `resultRace` semantics (v2 commit satisfies them through the shared CAS).

### Phase C — admin UI (paginated tables)

- **C1. `ReportJobDetail`**: the 10-second poll fetches `status`, counts and `verification` only
  (`GET [jobId]?slim=1`); rows load through B6 with 100 per page, a search box (debounced, server
  `q` on merchant/category/note), an "ללא סיווג בלבד" toggle, and prev/next + page numbers. The
  uncategorized assignment table is the same route with `filter=uncategorized`. Edits (`assign`,
  `date`) refresh the current page only.
- **C2. `ReportView` (online report)**: the analysis stays server-built (ms at 50 k); the page stops
  passing every row to the client. The month filter becomes a URL search param (`?hide=2026-01`)
  recomputed on the server; drill-downs and the ledger tab fetch through B6 with
  `month`/`leaf` filters. `TxnTable` renders ≤ 200 rows.
- **C3. `/report`** (client page): select only the columns it renders; the uncategorized lists render
  the first 200 rows plus "ועוד N" — the matrix and income are aggregates already.
- **C4. Docs (rule 4)**: `ADMIN_GUIDE.he.md` — duplicate-file refusal, overlapping bank exports
  merged (and the overlap note), large-job behaviour, paginated tables, the new FAILED reasons;
  date bump. `docs/REPORTS_PIPELINE.md` (flow, caps table, files, tests). `CLIENT_GUIDE.he.md` only
  if the `/report` truncation line ("ועוד N") ships — quoted there.

### Phase D — scale fixture, tests, ops

- **D1. Fixture generator** `scripts/gen_scale_fixture.py` — deterministic (seeded), synthetic,
  **no PII**, `--rows N` (default 5,000): a Hapoalim-shaped bank export split into three exports
  with configurable overlaps and boundaries that **split identical same-day rows**; a Leumi-shaped
  bank export; a MAX-shaped card statement; an Isracard-shaped xlsx. Generated at test time, never
  committed. `scripts/bench_scale.py` prints the E2 table for any N.
- **D2. Ops (post-merge)**: ship the **app first** (migration on start; old skills keep working —
  v1, inline dictionary, no cache); then re-install the skill (`AGENT_SETUP.md` §7: the changed
  scripts + `SKILL.md`, no vendor rebuild); then one real two-overlapping-export job and one
  ~5,000-row job.

## Delivery — four PRs, each carrying its own tests, each green on its own

1. **PR-1 identity & merge** — A1, B2 (+ `sha256` column) and the E1 tests. Fixes the observed
   failure; smallest blast radius.
2. **PR-2 judgment & limits** — A2, A3 + B3, A5.
3. **PR-3 caps** — B1 (rest), B4, B5, A4, A6 and the D1 fixture growth.
4. **PR-4 UI** — B6, C1–C3, C4.
   Each PR re-runs the plan's matching verification subset; the fixture lands with PR-1 and grows.

## Non-goals

- **OCR / scanned PDFs** — later item (below); only the named-error seam ships here.
- Parallel parsing of files, a streaming `openpyxl` workbook, and a background pre-parse on upload
  (recorded as later options if the fixture shows the 2-minute budget threatened).
- Cross-job or cross-client parse sharing (cache is per file row, Decision 7).
- Merging **card** statement overlaps (card exports bill distinct cycles; a repeated card
  statement is caught by the `sha256` refusal and, if re-exported differently, by the existing fatal).
- Re-judging only the unjudged merchants without a re-run (the coverage note makes the gap visible;
  a "resume judgment" command is later).
- Raising `MAX_TXNS` for v1 or removing any cap entirely.

## Later: OCR (not planned in detail here)

Preconditions: the platform's document-processing capability from `openclaw-dashboard#811` is
available to the onlyclaw agent. Shape of the future plan: OCR output becomes **text lines fed to the
existing detectors/parsers** (no new parser per bank), every OCR-derived row is flagged and the
statement's printed totals / balance chain remain the acceptance test (an OCR digit error breaks
the chain or the total — fatal by the existing machinery), and scanned files carry a
lower-confidence note to the admin. This plan's `ScannedPdfError` is the single place that later
plan would hook.

## Ponytail cuts

- **yagni:** recovering Leumi's excluded oldest row from the neighbour file — the day-partition
  already takes it as a normal row when a neighbour export covers that day, and the gap warning
  names it when not.
- **yagni:** content-based row alignment between exports — *Rev 1's set union was exactly this and
  Codex broke it* (repeating balances). The per-day partition needs only each export's period and
  an order-preserving sub-sequence check, and refuses what it cannot prove.
- **yagni:** a cross-job parse cache or content-addressed store — per-file rows only.
- **yagni:** a `judge` subcommand that calls the model — batching is files + a status command.
- **yagni:** dictionary result caching on the app — one indexed `IN` query per 500 merchants.
- **Correction recorded:** the first draft of E2 over-stated runtime ~5× (profiler/`tracemalloc`
  overhead) and proposed engineering around it; measured honestly, parallel parsing, a streaming
  workbook and a pre-parse-on-upload are not needed, and the parse cache (A4) is justified by
  **avoided downloads and re-parsing on every update re-run**, not by parse speed. *Review ask: is
  A4 still worth its tables?*
- **yagni:** streaming/parallel everything (non-goals above) before the fixture says it is needed.
- **Kept deliberately:** the app-side `duplicate dedupKey` fatal and the v1 protocol — the first is
  the safety net under the new merge, the second is what keeps an old skill working during rollout.

## Risks / contingencies

- **A merge bug hides or double-counts a row.** Rows are never removed on content equality: a day's
  rows come from one export, and any other export's rows for that day must match it as an
  order-preserving sub-sequence or the merge **refuses** (Codex P1 — the repeating-balance case is a
  named test). What can still go wrong is an export whose *printed period is wrong or missing*: the
  fallback (min/max row date) only under-claims, which leaves days to a single export — never
  removes. Residual: two exports that both omit the same day's rows are indistinguishable from
  an empty day — the chain gap warning and the overlap note are the only signals. The app-side
  `duplicate dedupKey` fatal remains for the double-count direction.
- **Chain-existence check is a weak completeness test** (a missing run of rows whose end balance
  coincidentally equals another row's). It is a *warning* and strictly stronger than today's
  per-file check, which cannot see between files at all; documented in `categorization-rules.md`.
- **Poisoned cache**: a hijacked turn could `PUT` altered parse results for a file. Cached rows get
  the same verification as fresh ones (card Σ / bank chain), so amount changes fail; **date or
  merchant** edits would not. Mitigation: per-file binding + sha256 + parser hash; the cache dies
  with the file/job; re-uploading the file (or any parser change) cold-starts it. *Review ask.*
- **Staging growth**: bounded **at ingestion** per job — 50 chunks, 50,000 rows, 64 MB, one
  artifact slot (B5) — so an abandoned or hostile upload costs at most 64 MB until the next `begin`
  (always the first call of the next run), a `commit`, or cascade with the job. No sweeper.
- **Judgment time**: 580 merchants = 15 batches ≈ 15 model rounds. Slower than one huge read, but the
  one huge read does not fit; ordering by money puts the decisions that matter first.
- **Admin pagination removes "all rows on one page"** — copy/export of the whole ledger
  (`ReportView` TSV) becomes the downloaded Excel; the TSV copy buttons act on the current page and
  say so.
- **Exec ceiling**: 50 k rows ≈ 20 s of the 300 s agent exec limit; the fixture asserts a loose
  budget (below) so a 10× regression fails, and the cap is the knob if production numbers disagree.

## Verification

Skill (`python3 -m unittest`, generated fixtures, no PII):

- `test_overlapping_day_aligned_exports_are_not_double_counted` (E1 rows 1–2 rebuilt on day
  boundaries, both banks: emitted == physical),
  `test_split_export_with_repeating_balance_keeps_both_purchases` (**Codex P1**: purchase→90,
  refund→100, identical purchase→90 on one day, split across two exports — all three rows survive),
  `test_adjacent_exports_with_identical_same_day_pair_keep_both_rows`,
  `test_row_count_split_inside_a_day_refuses_naming_files_and_day` (E1 rows 3–4 as stress: ambiguous
  ⇒ `AmbiguousBankMergeError`, never a silent drop),
  `test_earlier_export_partial_last_day_is_a_subsequence_and_merges`,
  `test_conflicting_content_on_a_shared_day_refuses`,
  `test_missing_printed_period_falls_back_to_row_range_and_never_removes`,
  `test_two_accounts_with_same_last4_refuse_instead_of_mixing`,
  `test_period_parsed_from_hapoalim_and_leumi_headers`, `test_contained_file_adds_nothing`, `test_same_file_twice_adds_nothing`,
  `test_overlap_note_names_both_files_and_count`, `test_gap_between_exports_is_a_warning_naming_the_date`,
  `test_leumi_oldest_row_present_in_neighbour_file_is_kept`, `test_discount_fallback_key_includes_balance`,
  `test_card_sources_still_warn_on_duplicate_label`.
- `test_batches_are_at_most_40_ordered_by_total_amount`, `test_finalize_merges_all_judgment_files`,
  `test_duplicate_or_unknown_judgment_key_is_a_warning`, `test_unjudged_count_is_reported_in_agent_notes`,
  `test_small_job_is_one_batch`, `test_judge_status_counts`.
- `test_dictionary_resolved_in_chunks_of_500`, `test_old_manifest_uses_inline_dictionary`,
  `test_resolved_income_leaf_is_ignored`.
- `test_cache_hit_skips_download_and_parse`, `test_cache_miss_puts_result`,
  `test_cache_ignored_on_parser_version_change`, `test_cache_ignored_on_label_change`,
  `test_cached_rows_are_verified_like_fresh_rows`.
- `test_parse_timeout_names_the_file`, `test_any_parse_exception_names_the_file`,
  `test_page_cap_names_the_file`, `test_scanned_pdf_gets_the_named_error`, `test_prepare_aborts_on_first_failing_file`.
- `test_scale_5000_rows_budget_and_exactness` (every row once, no fatal, `prepare` ≤ 20 s, `finalize` ≤ 30 s at
  5,000 rows — ≈ 10–20× the measured 0.4 s / 1.3 s, so CI noise cannot trip it but a quadratic
  regression does; peak ≤ 100 MB), `test_runtime_is_roughly_linear` (2× rows ≤ 3× time), `test_v2_upload_chunks_are_at_most_1000_rows`.

App (`pnpm test`):

- `reportResultScale.test.ts`: v2 begin/chunk/commit end to end with a mocked db at 50,000 rows;
  chunk idempotency; gap or count mismatch ⇒ 409; **`test_commit_after_superseding_begin_is_rejected`**
  (interleaved: A claims/loads, B `begin`s, A's write is refused — and the converse order),
  `test_second_commit_of_the_same_upload_is_rejected` (claim nulls `resultUploadId`),
  **`test_chunk_over_quota_is_rejected_before_persistence`** (seq ≥ 50, > 1,000 rows, > 2 MB body,
  cumulative rows > 50,000, cumulative bytes > 64 MB — each 413 with the stage unchanged),
  `test_second_artifact_replaces_the_single_slot`, `test_every_v2_write_claims_with_upload_id`
  (source-level: no v2 transaction writes before its claim); commit without CAS ⇒ 409 and **nothing** written;
  wrong/old `uploadId` ⇒ rejected; v1 still rejects 5,001 rows; v2 rejects 50,001; a ₪20 M source
  total accepted in v2 and still `bad totals` in v1; stored `problems` truncated to 200 with
  `problemsTotal`, `fatal` unchanged; `resultMergedSet` / `resultRace` pass unchanged.
- `agentRoutes.test.ts` extended: dictionary, parsed (GET/PUT), begin/chunk/artifact/commit each call
  the guard; another job's file id ⇒ 404; `PUT parsed` without `sha256` ⇒ 409.
- `dictionaryRoute.test.ts`: only approved, only requested, only valid non-income leaves, > 500 ⇒ 400.
- `uploadDuplicate.test.ts`: same bytes twice on one job ⇒ 409 (Hebrew); same bytes on another job ⇒ allowed.
- `adminTransactionsRoute.test.ts`: auth, `pageSize` clamp, filters, stable order, `total`.
- `reportJobDetail` / `reportView` source assertions: slim poll URL; no `transactions` prop on `ReportView`;
  `TxnTable` ≤ 200 rows. `hebrewErrors.test.ts` passes.

Manual: upload the two real overlapping exports of one account → one merged report, overlap note
visible, publishable; a 5,000-row fixture job end to end; a deliberately corrupt PDF → the job's error
names that file; delete it, re-run, passes.
