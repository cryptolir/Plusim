# Plusim — Update a ready report (append statements + re-run the same job)

> **Status:** Draft — **Rev 4**, Codex round-3 findings folded; awaiting re-review.
> Nothing implemented yet.
>
> **Process** (self-contained, per protocol): plan PR → adversarial review → each
> review round becomes a new Rev on this branch with resolution notes (never
> silently rewrite reviewed text) → every caught hole becomes a named test the
> implementation PR must carry → once approved, implement exactly the plan;
> deviations go back to the owner.
>
> **Review log:**
> - Rev 1 — authored from a file-anchored read of the pipeline (routes, auth,
>   UI, schema all quoted below). Ponytail pass ran before handoff (see
>   "Ponytail cuts").
> - Rev 2 — Codex review round 1 (PR #23): **P1** — a totally failed re-export
>   (in-place update AND fallback create both failing) would keep serving the
>   old Google Sheet link as current next to updated `/report` tables. Resolved:
>   on re-publish, total export failure **clears `sheetUrl`** — no link until a
>   later successful export; banked as `republish_failed_export_clears_sheet_url`.
>   **P2** — root containment is not folder containment: a sheet moved into
>   ANOTHER client's folder (or orphaned by folder reassignment) would be
>   updated in place with this user's data. Resolved: the in-place path now
>   requires `assertEntryUnderFolder(sheetId, currentFolder)` — the same binding
>   the statement-read route uses (Context 7); any failure falls back to
>   create-new in the assigned folder, best-effort trashing the old sheet;
>   banked as `republish_sheet_outside_user_folder_falls_back`. **P1** — append
>   refuses a running job, but run/publish could start mid-append and publish a
>   report missing listed files (the `completedAt` guard postdates appended
>   rows). Resolved: serialize **outcomes**, not requests — the publish guard
>   compares against **`dispatchedAt`** and is enforced twice: a friendly
>   pre-check AND the same predicate inside a conditional `updateMany` (the
>   result route's proven pattern), so every interleaving degrades to a 409 +
>   re-run, never a silently partial report; banked as
>   `publish_with_unprocessed_files_409` + `publish_append_race_conditional_409`.
> - Rev 3 — Codex review round 2 (PR #23): **P1 (new)** — the *reverse*
>   publish/result race: a publish that pre-checked a clean `completed` job can
>   still land its conditional write AFTER a concurrent re-run's callback wrote
>   a **fatal** `needs_review` result — `needs_review` is publishable and no file
>   is newer than the (new) `dispatchedAt`, so the predicate matched and a fatal
>   result got published without re-running the fatal guard. Resolved: the
>   conditional write now also pins **`completedAt` to the value read in the
>   pre-check** — any newly landed result moves it, so the stale publish matches
>   0 rows ⇒ 409. Banked as `publish_reverse_result_race_409`. **P1 (carried
>   over from round 1, thread `3632830672`)** — its text argues against the
>   `completedAt` watermark that Rev 2 already replaced with `dispatchedAt`;
>   re-examined rather than re-patched, and the full interleaving matrix (C,
>   below) shows every append/run/publish ordering ends at a processed report or
>   an explicit 409. No lock added — a mutual-exclusion mechanism would be
>   machinery the watermark already makes unnecessary. Banked as
>   `publish_partial_append_during_dispatch_409`.
> - Rev 4 — Codex review round 3 (PR #23): **P1 (new)** — the `completedAt` pin
>   misses the **rejected**-callback path (`result/route.ts:129-132` writes
>   `status`/`error` only), so a re-run whose result was rejected could leave a
>   publish-in-flight free to stamp `published` on the previous artifact while
>   the latest run had actually failed. Resolved: the conditional write now also
>   pins **`dispatchedAt`** — every run sets it (`run/route.ts:42-51`), and no
>   result-route write can occur without a dispatch that postdates the
>   pre-check (a callback requires `status ∈ dispatched|processing`, which a
>   publishable job only re-enters via a new dispatch). `completedAt` is kept
>   alongside it as the result-side watermark, so the pair still holds if a
>   future result path is added. Banked as `publish_rejected_callback_race_409`.
>   **P2 (new)** — `TIMESTAMP(3)` ties: a file appended in the *same millisecond*
>   as the dispatch compares equal, so a strict `gt` would wave an unprocessed
>   file through. Resolved: the boundary is now **`gte`** (same-millisecond ⇒
>   409 ⇒ visible re-run, the safe direction). Banked as
>   `publish_same_millisecond_append_409`. Two threads (`3632830672`,
>   `3632947421`) were re-anchored unchanged by the bot and are already resolved
>   in Rev 2 / Rev 3.

## Problem

When a client has many statements, the admin processes them in batches. Today
every batch is a **new** `ReportJob` → a second, separate report next to the
first. The admin needs to pick a report that is already done (`completed` /
`needs_review` / `published`), add more statement files to it, and run the
process again so the **same** report absorbs the new data — same review flow,
same workbook, same `/report` output formats as today.

## Context — what exists today (read from the code, not memory)

1. **The result callback already replaces everything.** On every agent
   callback, `src/app/api/agent/jobs/[jobId]/result/route.ts:73-91` runs
   `reportTransaction.deleteMany` + `reportArtifact.deleteMany`, then
   `createMany` from the new result inside one conditional transaction. A re-run
   is already a full rebuild, not an increment.
2. **The manifest already lists every StatementFile of the job.**
   `src/app/api/agent/jobs/[jobId]/manifest/route.ts:20-24` selects
   `statementFile.findMany({ where: { jobId } })` — no filtering by "already
   processed". Whatever rows exist at dispatch time is what the agent parses.
3. **Re-dispatch is already safe and re-mints the token.**
   `src/app/admin/api/reports/[jobId]/run/route.ts:41-51` mints a fresh per-job
   token on every run; `src/lib/agentRuntimeAuth.ts:80-88` authorizes a callback
   only when `sha256(presented) == job.agentTokenHash` — so the mint itself
   invalidates any older token. The result write is additionally conditional on
   `status in (dispatched|processing) AND agentTokenHash == auth.tokenHash`
   (`result/route.ts:39-43`), closing the publish/result race.
4. **The only hard stop is `published`:** `run/route.ts:34-36` returns 409
   `job already published`. Publish clears the token
   (`publish/route.ts:86-95`) so late callbacks can't mutate a published
   report, and the UI disables the run button for published jobs
   (`src/components/admin/ReportJobDetail.tsx:152`).
5. **Publish already supports re-publish but reuses a stale sheet.**
   `publish/route.ts:28-30` accepts `completed | needs_review | published`;
   `:51-53` only exports to Google Sheets `if (!sheetUrl)` — a re-publish after
   new data would keep linking a spreadsheet with the OLD workbook and never
   export the new one.
6. **Upload = create-a-new-job, with the containment we must mirror.**
   `src/app/admin/api/reports/route.ts` sniffs magic bytes (`:30-39`), requires
   the target user's `UserDriveFolder` and re-contains it at write time with
   `assertEntryUnderRoot` (`:76-99`), then creates the job + uploads each file +
   creates `StatementFile` rows; on failure it trashes what it wrote **and
   deletes the job** (`:131-137`). There is no way to add files to an existing
   job.
7. **Agent download is bound to the job user's CURRENT folder.**
   `src/app/api/agent/jobs/[jobId]/files/[fileId]/route.ts:34-37` 404s when the
   row's `driveFolderId` no longer equals the user's current
   `UserDriveFolder.folderId`. So a job whose user was re-assigned a folder
   after upload cannot run — its old rows fail the read binding. Any append
   flow inherits this.
8. **Manual review edits live only in the transaction rows.**
   `transactions/[txId]/route.ts:35-46` sets `category` on the row and, only
   when "לזכור" is checked (default on, `ReportJobDetail.tsx:397`), upserts an
   **approved** `MerchantMapping` — which rides in every future manifest
   (`manifest/route.ts:25-30`). An assignment made *without* remember is wiped
   by the next run's `deleteMany` (today's re-run behavior already; not new).
9. **`/report` shows `status: "published"` only**
   (`src/app/report/page.tsx:41-43`), ordered by `publishedAt desc`. The
   client-side rendering, xlsx download, and Sheet link all read the job's
   current rows/artifact — formats untouched by this plan.
10. **Admin-defined categories (PR #21) compose for free.** The manifest now
    serves the merged (base ∪ DB `ReportCategory`) taxonomy at fetch time, so
    an update re-run sees current categories exactly like a fresh job — no
    interaction with this plan.
11. **Schema needs nothing new.** `prisma/schema.prisma:67-138` — jobs own
    files/transactions/artifacts by `jobId`; `dedupKey` is already the
    cross-statement identity used by the agent's dedup.

**Core insight:** because of (1)+(2), *the merge is free*. "Add data to a ready
report" = append `StatementFile` rows to the same job + re-dispatch. The agent
re-parses the union, dedups overlaps via `dedupKey`, rebuilds the full workbook
in exactly today's format, and the callback replaces the stored report
atomically. No schema change, no agent-skill change, no `/report` change, no
new report format.

## User flow (admin)

1. Open the done report at `/admin/reports/[jobId]` (list page already links it).
2. New **"הוספת דפי חשבון"** control in the files section → pick files → they
   upload into the same job (visible immediately in the files list).
3. Click the existing **הרצה מחדש של הסוכן** button (now also enabled for
   published jobs, behind a confirm). Status → `dispatched`/`processing`, the
   detail page polls as today.
4. Review uncategorized rows / approve mappings exactly as today.
5. **פרסום מחדש** — the same job re-publishes; the linked Google Sheet is
   updated in place; `/report` shows the updated report.

One flow, one job, one report. The client never sees two reports for one
period.

## Design

### A. Append endpoint — `POST /admin/api/reports/[jobId]/files`

New route, multipart `files[]` only (`targetUserId`/`title` come from the job).
Reuses the create route's validation verbatim — same `MAX_FILES = 12` per
request, 10 MB cap, `sniffMime` magic-byte check (`route.ts:27-39`). Extract the
shared prepare/upload steps from `route.ts` into a helper both routes call
(same file or `src/lib/…` — implementer's choice, no behavior change to
create).

Guards, in order:
- job exists → else 404.
- `status in (dispatched|processing)` → 409 `agent is running` — appending
  mid-run would desync the manifest the agent already fetched from the files
  list. All other statuses (`uploaded|completed|needs_review|published|failed`)
  may append. Appending alone changes **nothing** the client sees — a published
  job stays `published` (run is the state-changer).
- Drive connected + user has a `UserDriveFolder` + `assertEntryUnderRoot` at
  write time → else 409 (identical to create, `route.ts:76-99`).
- **Folder-consistency pre-flight:** if any existing `StatementFile.driveFolderId`
  differs from the user's current `folderId` → 409 `statement files live in a
  previously assigned folder — reassign or re-upload`. Without this the job
  becomes un-runnable only later, mid-agent-run, at the read binding
  (Context 7); fail early and clearly instead.

Rollback on mid-loop Drive failure: trash only the **newly** uploaded Drive
files and delete only the **newly** created rows — never the job, never
pre-existing files (unlike create's job-delete at `route.ts:131-137`).

**Race posture (Rev 2, matrix in C):** append takes no lock against a
concurrent run or publish. Instead every bad interleaving is made harmless
downstream: any row whose `createdAt` postdates the run's `dispatchedAt` trips
the publish guard (C) — worst case is an explicit 409 + re-run, never a
published report that silently omits files it lists. A *partially* completed
append is covered the same way, row by row: each row is independently either
pre-dispatch (in the manifest, processed) or post-dispatch (409).

### B. Run gate — allow a deliberate update of a published job

`run/route.ts:34-36` changes from a flat 409 to:

- `published` **without** JSON body `{ "confirmUpdate": true }` → 409 exactly as
  today (accidental/legacy callers keep the guard).
- `published` **with** the flag → proceed: fresh token minted, status →
  `dispatched` (leaves `published`). `publishedAt` and `sheetUrl` are **kept**
  (history + in-place re-export target for C). Nothing else in the route
  changes.

Token safety is inherited, not new: the mint rotates `agentTokenHash`, so a
straggler callback from any earlier run fails auth with 404
(`agentRuntimeAuth.ts:80-88`), and the conditional write (`result/route.ts:39-43`)
still refuses anything that isn't the current run of a job in
`dispatched|processing`.

**Accepted UX consequence (explicit):** between update-run and re-publish the
job is not `published`, so `/report` hides it (Context 9). The old report
disappears for the minutes-to-hours the admin takes to review and re-publish.
Keeping the old version visible would require snapshot/versioning tables —
rejected below.

### C. Publish exports the CURRENT artifact every time

Replace the `if (!sheetUrl)` skip (`publish/route.ts:51-53`) with:

- `sheetUrl` set → parse the spreadsheet id from the URL (publish itself minted
  it as `https://docs.google.com/spreadsheets/d/<id>/edit`, `:70`), then
  **`assertEntryUnderFolder(id, currentFolder.folderId)`** — the user's CURRENT
  `UserDriveFolder`, the same binding the statement-read route enforces
  (Context 7); root containment alone would allow updating a sheet that was
  moved into another client's folder (Rev 2 — Codex P2). Only then **update the
  same spreadsheet in place** via a new `googleDrive.ts` helper
  `updateXlsxSpreadsheet({ fileId, xlsx })` — a `files.update` media upload
  (PATCH) with the xlsx body, mirroring `uploadXlsxAsSpreadsheet`
  (`googleDrive.ts:315`) which already does the create-side conversion. The
  user's bookmarked link stays valid and current. (Verify the
  convert-on-update semantics against the Drive API during implementation; the
  fallback below covers a refusal.)
- In-place path fails for any reason (not under the user's folder, deleted,
  API refusal) → fall back to the existing create-new path in the assigned
  folder, overwrite `sheetUrl`, and **best-effort trash the old spreadsheet**
  (a stale sheet next to the new one is the same confusion as a stale link;
  trash failure is ignored).
- Both in-place update AND fallback create fail on a job that HAS a `sheetUrl`
  → **clear `sheetUrl`** (and set `exportNote`): publish still succeeds, but
  the old link is never served as current next to updated tables (Rev 2 —
  Codex P1). First publish keeps today's semantics (no link existed, none
  shown).
- No `sheetUrl` → create-new path, unchanged.
- Export remains best-effort exactly as today: an export failure never blocks
  publish — it only downgrades or clears the link.

**New publish guard — files not older than the last dispatch:** refuse with 409
when any `StatementFile.createdAt >= dispatchedAt` — files the last run cannot
be proven to have covered. The boundary is `>=`, not `>`: both columns are
`TIMESTAMP(3)`, so a file appended in the same millisecond as the dispatch
compares equal and a strict `>` would treat it as processed (Rev 4 — Codex P2).
A tie now costs one visible re-run instead of a silently incomplete report. `completedAt` is the wrong watermark for the file boundary: rows appended while
a run is in flight land BEFORE the callback sets `completedAt` and would slip
through (Rev 2 — Codex P1); `dispatchedAt` is conservative-correct (a file appended
between dispatch and the agent's manifest fetch may 409 despite being
processed — the remedy is the same visible re-run). Enforced twice:
1. **Pre-check** before the export work → friendly 409, no wasted Sheet write.
2. **Conditional publish write** — the final `update` becomes an `updateMany`
   whose `where` carries `status ∈ (completed|needs_review|published)` AND
   `files: { none: { createdAt: { gt: dispatchedAt } } }`; 0 rows ⇒ 409,
   nothing published — closing the pre-check→update TOCTOU the same way the
   result route closes the publish/result race (`result/route.ts:39-43`).

**Conditional predicate, exactly (Rev 3):**

```
updateMany({ where: {
  id: jobId,
  status: { in: ["completed", "needs_review", "published"] },
  dispatchedAt: preChecked.dispatchedAt,                       // run watermark
  completedAt: preChecked.completedAt,                         // result watermark
  files: { none: { createdAt: { gte: preChecked.dispatchedAt } } },
}, data: { status: "published", publishedAt, sheetUrl, agentTokenHash: null, … } })
```

All three watermarks are the **values read in the pre-check**, not field
references — Prisma cannot compare two columns of the same row in a `where`, so
a plan that says "createdAt >= dispatchedAt" must be implemented with the
pre-read value or it will not compile.

**Why `dispatchedAt` is the load-bearing pin (Rev 4).** Every dispatch sets it
(`run/route.ts:42-51`), and **no result-route write can happen without one**: a
callback is accepted only while `status ∈ (dispatched|processing)`
(`result/route.ts:39-43`), which a publishable job can re-enter only through a
new dispatch. So the pin catches the whole class — successful callbacks,
**rejected** callbacks (`result/route.ts:129-132`, which write `status`/`error`
and deliberately leave `completedAt` alone — Rev 4, Codex P1), and a re-run
still in flight. `completedAt` stays as the result-side watermark so the pair
still holds if a future result path is added that writes outside this
invariant.

**Interleaving matrix (answers the round-1 append/run/publish thread):**

| when appended rows land | in the agent's manifest? | `createdAt >= dispatchedAt`? | outcome |
|---|---|---|---|
| strictly before `dispatchedAt` | yes (manifest is fetched after dispatch) | no | processed → publishable ✓ |
| same millisecond as the dispatch | maybe | yes (`gte`) | 409 → visible re-run ✓ |
| between dispatch and manifest fetch | yes | yes | 409 → visible re-run (conservative false positive) |
| after the manifest fetch | no | yes | 409 → re-run ✓ |
| while no run is in flight | n/a | yes | 409 at pre-check, and again at the conditional write ✓ |
| append still mid-loop when run starts | per row, as above | per row | any post-dispatch row ⇒ 409 ✓ |

No ordering yields a published report that omits a file the job lists.

**Accepted leftover:** export runs before the conditional write (as today), so a
publish that 409s on the race may already have refreshed the Google Sheet with
the **pre-checked** artifact. That artifact is itself verified and non-fatal —
no fatal data reaches the client — and the admin's remedy is the ordinary
re-publish after review. Reordering export after the claim was rejected: it
would leave a window where a published job still links the old sheet, which is
the failure round 1 asked us to close.

Fatal-verification 409 (`:34-44`) and token-clearing (`:92-94`) are unchanged.

### D. UI — `ReportJobDetail.tsx` only

- Files section gains an add-files control (file input + button, mirroring
  `ReportUploadForm.tsx` mechanics) → POST to the new endpoint → `load()`.
  Hidden while `dispatched|processing`.
- Run button: drop `disabled={… || job.status === "published"}`
  (`:152`); when `published`, wrap the action in `window.confirm` (Hebrew) that
  states both consequences before POSTing `{ confirmUpdate: true }`:
  the report is hidden from the client until re-publish, and manual category
  assignments not saved with "לזכור" will be recomputed by the agent.
- Publish button already handles re-publish (`:157-164`) — unchanged.
- Upload form on the index page: unchanged. The job detail page IS the update
  surface.

### No changes anywhere else

Schema, migrations, `/report` page, download route, agent skill
(`agent/skills/plusim-reports/`), manifest/files/result routes, taxonomy,
verification (`lib/reportResult.ts`) — all untouched. The workbook is built by
the same script over the union of files, so output formats are byte-for-byte
the same shapes as today.

## Invariants (what review should attack)

0. **A publish only ever publishes the exact result it verified** — status,
   run watermark (`dispatchedAt`), result watermark (`completedAt`) and file set
   are all re-asserted in the write, so no run or callback landing mid-publish —
   successful, rejected, or still in flight — can be published unverified.
1. **No stale callback ever mutates a report the client can see.** Published ⇒
   token null ⇒ 404. Updated-then-republished ⇒ old tokens fail the hash check;
   only the current run's token passes auth AND the conditional write.
2. **Append writes are contained exactly like create writes:** DB-owned parent
   folder, `assertEntryUnderRoot` at write time, rollback leaves no orphan
   Drive files, no orphan rows, and never deletes the job or old files.
3. **What the client sees is always an admin-published, verified artifact:**
   fatal verification still blocks publish; appended-but-unprocessed files now
   also block publish (race-proof via the conditional write); the exported
   Sheet either matches the stored artifact or is not linked at all.
4. **Append during a run is impossible** (manifest/files-list consistency).
5. **Report formats unchanged** — `/report` rendering, xlsx workbook, Sheets
   export are the same code paths over the same shapes.

## Ponytail cuts (deliberately NOT building)

- **No report versioning / snapshots.** Keeping the old report visible during
  the update window means snapshot tables + swap-on-publish for a cosmetic,
  admin-controlled gap. Cut; the gap is stated in B and confirmed in the UI.
- **No incremental agent processing** ("send only new files, merge
  server-side"). Re-running the union IS the merge; `dedupKey` already handles
  overlap; the agent stays stateless; app-side merge would need workbook-rebuild
  logic the app deliberately doesn't have.
- **No schema change.** Nothing needs one.
- **No per-job total-file cap** (12/request stays). Operator-controlled admin
  surface; agent runtime scales with files either way. Add a cap when a real
  run hits a real limit.
- **No auto-remember of manual assignments before re-run.** Silently promoting
  mappings the admin chose not to remember is worse than the confirm-dialog
  warning. The "לזכור" default-on checkbox already covers the common case.
- **No new update mode in the index upload form** — the detail page already has
  the files list, run, review, and publish.

## Tests (named; the implementation PR must carry all of them)

New `appendFiles.test.ts` (mirrors `uploadContainment.test.ts` fixtures):
- `append_while_running_409` — `dispatched`/`processing` ⇒ 409, no rows, no Drive writes.
- `append_keeps_published_visible` — append to a `published` job ⇒ 200, rows
  added, `status`/`publishedAt` untouched.
- `append_containment_matrix` — no folder / folder moved outside root / Drive
  disconnected ⇒ 409, nothing written (same classes as create).
- `append_rollback_preserves_job` — mid-loop Drive failure ⇒ new uploads
  trashed, new rows gone, job + old rows + old artifact intact.
- `append_folder_mismatch_409` — existing rows carry a stale `driveFolderId` ⇒
  409 before any upload.

New `runUpdateGuard.test.ts`:
- `run_published_without_confirm_409` — body absent/false ⇒ 409, token stays null.
- `run_published_with_confirm_dispatches` — ⇒ `dispatched`, fresh
  `agentTokenHash`, `publishedAt` + `sheetUrl` preserved.

`agentRuntimeAuth.test.ts` add:
- `remint_invalidates_prior_token` — after a hash rotation the previously valid
  token ⇒ 404.

`publishGuard.test.ts` add:
- `publish_with_unprocessed_files_409` — a `StatementFile.createdAt >
  dispatchedAt` ⇒ 409 at the pre-check: no export call, no state change.
- `publish_append_race_conditional_409` — the conditional `updateMany`
  (status + no-newer-files predicate) matches 0 rows ⇒ 409, job not published
  (the `resultRace.test.ts` pattern).
- `publish_reverse_result_race_409` — a fatal `needs_review` result lands
  between pre-check and the conditional write (moving `completedAt`) ⇒ 0 rows ⇒
  409; the job is NOT published and the fatal result stays reviewable.
- `publish_rejected_callback_race_409` — a re-run whose callback is REJECTED
  (status/error written, `completedAt` untouched) lands between pre-check and
  write ⇒ the `dispatchedAt` pin mismatches ⇒ 409; the stale artifact is not
  published while the latest run has failed.
- `publish_same_millisecond_append_409` — a `StatementFile.createdAt` exactly
  equal to `dispatchedAt` ⇒ `gte` trips ⇒ 409; the tie is never treated as
  covered.
- `publish_partial_append_during_dispatch_409` — a file row created after
  `dispatchedAt` while the agent run is in flight ⇒ 409, regardless of whether
  the row predates the callback's `completedAt`.
- `republish_updates_sheet_in_place` — `sheetUrl` set ⇒ update helper called
  with the parsed id only after `assertEntryUnderFolder` against the user's
  CURRENT folder; no new spreadsheet created.
- `republish_sheet_outside_user_folder_falls_back` — sheet under the root but
  NOT under the user's current folder ⇒ no in-place write; create-new in the
  assigned folder; `sheetUrl` replaced; old sheet trashed best-effort.
- `republish_sheet_update_falls_back_to_create` — update throws ⇒ create-new
  path runs, `sheetUrl` replaced, publish still succeeds.
- `republish_failed_export_clears_sheet_url` — update AND create both fail on a
  job with an existing `sheetUrl` ⇒ publish succeeds, `sheetUrl` cleared,
  `exportNote` set.

## Sequencing (one implementation PR)

1. `googleDrive.ts`: `updateXlsxSpreadsheet` helper.
2. Extract shared upload/validation helper; add `[jobId]/files` route.
3. `run` gate (B), `publish` export + guard (C).
4. `ReportJobDetail.tsx` (D).
5. Tests above; `pnpm test` + typecheck + build.
6. Docs: fold the new flow into `docs/REPORTS_PIPELINE.md` (flow diagram +
   properties list).
