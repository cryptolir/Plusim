# Statement-categorization pipeline (admin upload → onlyclaw → client report)

Admin uploads credit-card statements, the `onlyclaw` AgentGlob agent
categorizes them into the household budget taxonomy, and the target user sees
the processed report in `/report`. Agent-side skill + ops runbook:
[`agent/skills/plusim-reports/`](../agent/skills/plusim-reports/) (see
`AGENT_SETUP.md` there).

## Flow

```
/admin/reports (upload, pick target user — must have an assigned Drive folder)
   → raw statements written to the user's Google Drive folder (owner OAuth,
     containment re-checked at write time) → ReportJob + StatementFile rows
     (driveFileId + driveFolderId only — NO bytes in Postgres)
   → POST /admin/api/reports/:id/run
        mints per-job token → callAgent() on session app:plusim:report-job:<id>
        message: "PLUSIM_REPORT_JOB v1 / manifest: <url?t=token>"  (≤3000 chars)
   → onlyclaw (plusim-reports skill):
        GET  /api/agent/jobs/:id/manifest   (files, taxonomy, dictionary, report_rules, callback)
        GET  /api/agent/jobs/:id/files/:fid
        python: parse (Isracard xlsx / MAX pdf) → dedup → deterministic categorize
        model: judge the unknown-merchant shortlist (never guesses → un_categorized),
               applying the admin report_rules carried in the manifest
        python: build workbook (month sheets + income block, ניתוח תוצאות,
                התפלגות ההוצאות + pie, טופס עזר למיפוי, חישוב יעדים,
                un_categorized, ledger) → verify to the agora
        POST /api/agent/jobs/:id/result     (transactions, totals, xlsx, proposed mappings)
   → app re-verifies INDEPENDENTLY (lib/reportResult.ts) → completed | needs_review
   → admin reviews uncategorized rows + approves merchant mappings → Publish
        publish exports the xlsx to Google Sheets (owner Drive OAuth, user's folder)
   → /report shows published reports: native RTL tables + xlsx download + Sheet link
```

**Updating a ready report** (many statements arrive in batches — one report, not
several):

```
/admin/reports/<id> on a completed | needs_review | published job
   → POST /admin/api/reports/:id/files   (multipart, same containment as create;
        refused while the agent is running, or if existing rows point at a
        previously assigned folder)
   → Re-run (a published job requires {"confirmUpdate":true}; the job LEAVES
        `published`, so the client stops seeing it until re-published)
   → the agent re-parses the UNION of files, dedups by dedupKey, rebuilds the
        whole workbook; the result callback replaces transactions + artifact
   → review as usual → Publish again: the SAME Google Sheet is updated in place,
        so the client's bookmarked link stays valid and current
```

The merge is free: the result callback already full-replaces a job's rows and
artifact, and the manifest already lists every `StatementFile` of the job — so
"add data to a ready report" is append rows + re-dispatch, with no new report
format, no schema change, and no agent-skill change.

## Key properties

- **Money is agorot integers** end to end; floats only at render time.
- **Nothing is trusted twice**: the skill verifies before POSTing; the app
  re-verifies from raw transactions before accepting. Any mismatch →
  `needs_review` with per-source diagnostics, never a silent partial report.
- **Month = transaction calendar month**, not billing month; charge amount
  after discounts/installments; credits negative; pending-vs-billed deduped.
- **Learning loop**: agent-proposed mappings land unapproved; admin approval
  (or "remember" during review) adds them to every future manifest, shrinking
  the judgment tail over time.
- **The taxonomy is base ∪ admin-added categories.** `reportTaxonomy.ts` is the base constant;
  admins extend it from the review UI (`ReportCategory` rows, **add-only**, each joining an existing
  base section). ONE filtered merge (`mergeTaxonomy` → `getMergedTaxonomy`/`getValidLeafSet` in
  `lib/reportCategories.ts`) feeds every consumer — agent manifest, result verification, admin
  category validation, the assign picker, `/report` — so app and agent still never disagree on
  category names (add-only ⇒ the manifest set is always ⊆ the later verification set). The pure
  verifier takes the valid set as a **required** argument; forgetting to pass it is a typecheck
  error, never a base-only fallback. Full design: `docs/plans/report-custom-categories.md`.
- **Admin categorization rules** (`report_rules`, set in `/admin/settings`) ride
  in every job manifest and steer the model's judgment of the **unresolved**
  shortlist only — they do NOT override a category the deterministic pass already
  assigned. Hard per-merchant overrides go through the merchant dictionary (which
  runs first and wins). Blank ⇒ the built-in playbook only. The skill consumes the
  field in `run_job.py prepare` (into `needs_judgment.json`) and `SKILL.md` step 3.
- **Auth**: `/api/agent/*` is middleware-public but demands the static runtime
  bearer (`PLUSIM_AGENT_RUNTIME_TOKEN` ≡ agent-side `PLUSIM_RUNTIME_TOKEN`)
  AND a sha256-stored, 24h per-job token minted at dispatch. Published jobs
  clear their token, so late callbacks can't mutate a published report. The
  result callback persists in one transaction whose job update is conditional on
  `status in (dispatched|processing)` + the authorizing token hash — 0 rows ⇒
  409, nothing written (closes the publish/result race).
- **Drive confinement**: raw statements live in the client's folder. On upload
  (create AND append — one shared module, `lib/reportStatementUpload.ts`) the
  parent is the DB `UserDriveFolder` (never the request), re-contained with
  `assertEntryUnderRoot` at write time. On agent download, the read is bound to
  the job user's CURRENT folder — the row's `driveFolderId` must match and
  `assertEntryUnderFolder(driveFileId, folderId)` must pass — so a stale or
  cross-linked file in another user's folder is rejected. The Sheet export runs
  **both** assertions: `assertEntryUnderFolder` proves the sheet belongs to this
  client but walks only as far as `folderId` and never consults the root, so the
  assigned folder itself is re-contained too.
- **A publish only ever ships the result it verified, from the newest run.**
  Beyond the fatal-verification gate, publish asserts — at the pre-check AND
  inside a conditional `updateMany` — that `completedAt >= dispatchedAt` (a
  rejected callback writes `status`/`error` and leaves `completedAt` alone, so a
  failed re-run must not publish the previous artifact) and that no
  `StatementFile.createdAt >= dispatchedAt` (files the run cannot be proven to
  have seen; `>=` because both are `TIMESTAMP(3)` and a same-millisecond tie must
  fail closed). The write pins both watermarks and the file set, so a run or
  callback landing mid-publish yields 0 rows ⇒ 409, nothing published.
- **Re-publish never leaves a stale Sheet link**: the existing spreadsheet is
  updated in place when still contained; otherwise a fresh one is created and the
  superseded one trashed (best-effort, and a trash failure can never discard the
  new link); if both export paths fail, `sheetUrl` is cleared rather than serving
  the previous workbook next to updated tables.
- **Fail closed**: re-verification tags integrity failures (per-source total
  mismatch, unknown category, date-outside-month, duplicate dedupKey, non-xlsx)
  as **fatal**, distinct from reviewable uncategorized rows. Publish refuses any
  job with fatal diagnostics (409); the agent's own `status:"ok"` never overrides
  the app's recompute.
- **Dispatch tolerates timeouts**: the AgentGlob run continues after a client
  abort; the callback (not the chat reply) completes the job. Admin detail
  page polls while `processing` and offers Re-run.
- **Sub-report sheets are formula-derived and app-invisible by design**: the
  analysis / distribution / helper-form / goals sheets (and the month-sheet
  income block) are live formulas over the month sheets, generated from
  per-sheet geometry maps (`reference/layout-spec.md`). App-side verification
  never parses workbook sheets — their correctness is guarded by the named
  tests in `agent/skills/plusim-reports/scripts/test_build_report_xlsx.py`
  plus the operator baseline. Income is manual-fill (no bank-statement source);
  analysis totals cover categorized spend only.

## Files

```
prisma/…/20260719120000_report_pipeline   ReportJob, StatementFile, ReportArtifact,
                                          ReportTransaction, MerchantMapping
prisma/…/20260722130000_report_category   ReportCategory (admin-added taxonomy leaves, add-only)
src/config/reportTaxonomy.ts              BASE taxonomy + pure merge (mergeTaxonomy/mergedLeafSet)
src/lib/reportCategories.ts               DB-backed merged-taxonomy accessors (the only
                                          ReportCategory reader)
src/lib/agentRuntimeAuth.ts               bearer + per-job token auth, appBaseUrl()
src/lib/reportResult.ts                   result parsing + independent verification
src/lib/reportsAdminAuth.ts               dual-auth for admin reports APIs (scope "reports")
src/app/api/agent/jobs/[jobId]/…          manifest | files/[fileId] | result
src/app/admin/api/reports/…               create+list | [jobId] detail | run | publish |
                                          [jobId]/files append | transactions/[txId] review
src/lib/reportStatementUpload.ts          shared statement validation + contained upload
                                          (create and append apply identical rules)
src/app/admin/api/report-mappings/[id]    approve/reject proposed mappings
src/app/admin/api/report-categories       add a custom category (POST; Hebrew errors)
src/app/admin/(dash)/reports/…            admin UI (upload form, job list, job detail)
src/components/admin/ReportUploadForm.tsx, ReportJobDetail.tsx
src/app/report/page.tsx                   client report section (published only)
src/app/api/reports/[jobId]/download      xlsx download (Clerk + ownership)
src/lib/googleDrive.ts                    + uploadBinaryFile() (raw statement upload),
                                          getFileBytes() (agent download), uploadXlsxAsSpreadsheet()
                                          (publish export), updateXlsxSpreadsheet() (in-place
                                          re-publish), assertEntryUnderFolder() (read confinement)
agent/skills/plusim-reports/              the onlyclaw skill (source of truth);
                                          workbook layout: reference/layout-spec.md +
                                          scripts/build_report_xlsx.py (+ its
                                          scripts/test_build_report_xlsx.py unit suite,
                                          run with bare python3 -m unittest)
```

## Tests

`pnpm test` (vitest) — one per trust-boundary invariant:

```
src/lib/reportResult.test.ts              verifyAgentResult fatal-vs-reviewable per class;
                                          parseAgentResult fail-closed; decodeXlsx non-zip
src/lib/agentRuntimeAuth.test.ts          both auth layers (bearer + per-job token) — 401/404 matrix
src/app/api/agent/agentRoutes.test.ts     each public route invokes the guard; files/ folder-confinement
src/app/api/agent/resultRace.test.ts      conditional write: 0 rows ⇒ 409, nothing persisted
src/app/admin/api/reports/publishGuard.test.ts    every fatal class ⇒ publish 409; non-fatal ⇒ publishes;
                                          result freshness + file coverage + both race pins;
                                          Sheet in-place update / fallback / cleared-on-failure
src/app/admin/api/reports/uploadContainment.test.ts   no folder / not connected / moved-or-deleted ⇒ 409
src/app/admin/api/reports/appendFiles.test.ts     append: mid-run 409, published stays visible,
                                          containment matrix, folder mismatch, rollback keeps the job
src/app/admin/api/reports/runUpdateGuard.test.ts  re-running a published job needs confirmUpdate
src/app/api/agent/reportRulesManifest.test.ts     manifest carries report_rules (set ⇒ value; blank ⇒ "")
src/config/reportTaxonomy.test.ts         pure merge: section append, invalid-section drop, set≡merge
src/config/taxonomyInvariants.test.ts     manifest leaves ≡ getValidLeafSet (same rows, malformed too);
                                          no consumer left on the base-only check (source+behavior)
src/app/api/agent/resultMergedSet.test.ts result callback verifies against the merged set — DB-leaf
                                          result non-fatal, mapping survives; without the row → fatal
src/app/admin/api/report-categories/createCategory.test.ts   create endpoint fail-closed matrix
src/app/admin/api/reports/mergedCategoryGuards.test.ts       assign/mapping accept DB leaves; picker
                                          source (categoryLeaves) carries them in section order
src/app/report/reportPage.test.ts         /report renders a published DB-leaf txn under its section
```

Test files are excluded from the production TypeScript build (`tsconfig` +
vitest's own config), so `next build` never needs the `vitest` devDependency.

## Verified baseline

The skill's pipeline was validated against 5 real statements (2 Isracard xlsx,
3 MAX pdf): 109 transactions; month totals ₪918.26 / ₪2,422.50 / ₪8,914.48 /
₪2,446.85; 11 uncategorized (₪621.00); every per-source sum equal to the
statement's printed total to the agora, and the generated workbook's live
formulas reproduce the same numbers. Re-run this baseline after any parser
change (real statements stay out of git — PII).
