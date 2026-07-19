# Statement-categorization pipeline (admin upload → onlyclaw → client report)

Admin uploads credit-card statements, the `onlyclaw` AgentGlob agent
categorizes them into the household budget taxonomy, and the target user sees
the processed report in `/report`. Agent-side skill + ops runbook:
[`agent/skills/plusim-reports/`](../agent/skills/plusim-reports/) (see
`AGENT_SETUP.md` there).

## Flow

```
/admin/reports (upload, pick target user)
   → ReportJob + StatementFile rows (bytea in Postgres)
   → POST /admin/api/reports/:id/run
        mints per-job token → callAgent() on session app:plusim:report-job:<id>
        message: "PLUSIM_REPORT_JOB v1 / manifest: <url?t=token>"  (≤3000 chars)
   → onlyclaw (plusim-reports skill):
        GET  /api/agent/jobs/:id/manifest   (files, taxonomy, approved dictionary, callback)
        GET  /api/agent/jobs/:id/files/:fid
        python: parse (Isracard xlsx / MAX pdf) → dedup → deterministic categorize
        model: judge the unknown-merchant shortlist (never guesses → un_categorized)
        python: build month-sheet xlsx → verify to the agora
        POST /api/agent/jobs/:id/result     (transactions, totals, xlsx, proposed mappings)
   → app re-verifies INDEPENDENTLY (lib/reportResult.ts) → completed | needs_review
   → admin reviews uncategorized rows + approves merchant mappings → Publish
        publish exports the xlsx to Google Sheets (owner Drive OAuth, user's folder)
   → /report shows published reports: native RTL tables + xlsx download + Sheet link
```

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
- **Auth**: `/api/agent/*` is middleware-public but demands the static runtime
  bearer (`PLUSIM_AGENT_RUNTIME_TOKEN` ≡ agent-side `PLUSIM_RUNTIME_TOKEN`)
  AND a sha256-stored, 24h per-job token minted at dispatch. Published jobs
  clear their token, so late callbacks can't mutate a published report.
- **Dispatch tolerates timeouts**: the AgentGlob run continues after a client
  abort; the callback (not the chat reply) completes the job. Admin detail
  page polls while `processing` and offers Re-run.

## Files

```
prisma/…/20260719120000_report_pipeline   ReportJob, StatementFile, ReportArtifact,
                                          ReportTransaction, MerchantMapping
src/config/reportTaxonomy.ts              taxonomy (single source; serialized into manifests)
src/lib/agentRuntimeAuth.ts               bearer + per-job token auth, appBaseUrl()
src/lib/reportResult.ts                   result parsing + independent verification
src/lib/reportsAdminAuth.ts               dual-auth for admin reports APIs (scope "reports")
src/app/api/agent/jobs/[jobId]/…          manifest | files/[fileId] | result
src/app/admin/api/reports/…               create+list | [jobId] detail | run | publish |
                                          transactions/[txId] review
src/app/admin/api/report-mappings/[id]    approve/reject proposed mappings
src/app/admin/(dash)/reports/…            admin UI (upload form, job list, job detail)
src/components/admin/ReportUploadForm.tsx, ReportJobDetail.tsx
src/app/report/page.tsx                   client report section (published only)
src/app/api/reports/[jobId]/download      xlsx download (Clerk + ownership)
src/lib/googleDrive.ts                    + uploadXlsxAsSpreadsheet() (publish export)
agent/skills/plusim-reports/              the onlyclaw skill (source of truth)
```

## Verified baseline

The skill's pipeline was validated against 5 real statements (2 Isracard xlsx,
3 MAX pdf): 109 transactions; month totals ₪918.26 / ₪2,422.50 / ₪8,914.48 /
₪2,446.85; 11 uncategorized (₪621.00); every per-source sum equal to the
statement's printed total to the agora, and the generated workbook's live
formulas reproduce the same numbers. Re-run this baseline after any parser
change (real statements stay out of git — PII).
