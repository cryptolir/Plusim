# Plusim — Update a ready report (append statements + re-run the same job)

> **Status:** Draft — **Rev 1**, awaiting first Codex review. Nothing implemented yet.
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
  `assertEntryUnderRoot(id)` and **update the same spreadsheet in place** via a
  new `googleDrive.ts` helper `updateXlsxSpreadsheet({ fileId, xlsx })` —
  a `files.update` media upload (PATCH) with the xlsx body, mirroring
  `uploadXlsxAsSpreadsheet` (`googleDrive.ts:315`) which already does the
  create-side conversion. The user's bookmarked link stays valid and current.
  (Verify the convert-on-update semantics against the Drive API during
  implementation; the fallback below covers a refusal.)
- Update fails (deleted / moved outside root / API refusal) → fall back to the
  existing create-new path in the assigned folder and overwrite `sheetUrl`.
- No `sheetUrl` → create-new path, unchanged.
- Export remains best-effort exactly as today: any export failure sets
  `exportNote`, never blocks publish.

**New publish guard — files newer than the last result:** refuse with 409 when
`max(StatementFile.createdAt) > completedAt` — i.e. files were appended but the
agent never ran over them. Without this, re-publish would silently ship a
report that ignores statements the admin just uploaded (and the Sheet would be
"updated in place" to the same stale content, making it look fresh). Fatal-
verification 409 (`:34-44`) and token-clearing (`:92-94`) are unchanged.

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

1. **No stale callback ever mutates a report the client can see.** Published ⇒
   token null ⇒ 404. Updated-then-republished ⇒ old tokens fail the hash check;
   only the current run's token passes auth AND the conditional write.
2. **Append writes are contained exactly like create writes:** DB-owned parent
   folder, `assertEntryUnderRoot` at write time, rollback leaves no orphan
   Drive files, no orphan rows, and never deletes the job or old files.
3. **What the client sees is always an admin-published, verified artifact:**
   fatal verification still blocks publish; appended-but-unprocessed files now
   also block publish; the exported Sheet always matches the stored artifact.
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
- `publish_with_unprocessed_files_409` — `StatementFile.createdAt > completedAt`
  ⇒ 409, no state change.
- `republish_updates_sheet_in_place` — `sheetUrl` set ⇒ update helper called
  with the parsed id after containment; no new spreadsheet created.
- `republish_sheet_update_falls_back_to_create` — update throws ⇒ create-new
  path runs, `sheetUrl` replaced, publish still succeeds.

## Sequencing (one implementation PR)

1. `googleDrive.ts`: `updateXlsxSpreadsheet` helper.
2. Extract shared upload/validation helper; add `[jobId]/files` route.
3. `run` gate (B), `publish` export + guard (C).
4. `ReportJobDetail.tsx` (D).
5. Tests above; `pnpm test` + typecheck + build.
6. Docs: fold the new flow into `docs/REPORTS_PIPELINE.md` (flow diagram +
   properties list).
