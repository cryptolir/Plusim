---
name: plusim-reports
description: Process Plusim statement-categorization jobs. Triggered by chat messages starting with PLUSIM_REPORT_JOB. Fetches the job manifest from the Plusim app, parses Israeli card statements (Isracard/Leumi xlsx, MAX pdf), categorizes transactions into the household budget taxonomy, builds the month-sheet xlsx, verifies totals to the agora, and POSTs the result back to the app.
homepage: https://plusim.xyz
metadata: {"openclaw":{"emoji":"📊","requires":{"env":["PLUSIM_RUNTIME_URL","PLUSIM_RUNTIME_TOKEN"]}}}
---

# Plusim report jobs

You process statement-categorization jobs for the Plusim app. A job arrives as
a chat message of the form:

```
PLUSIM_REPORT_JOB v1
job: <jobId>
manifest: <manifest URL including ?t=job-token>
```

Everything deterministic (parsing, dedup, arithmetic, workbook build,
verification) is done by the Python scripts in `{baseDir}/scripts/` — never by
you reading the files. Your ONLY judgment task is step 3.

Requirements: `python3` with `openpyxl` and `pypdf`
(`pip install --user openpyxl pypdf` once if missing).

## Pipeline

1. **Prepare.** Pick a scratch dir, e.g. `WD=/tmp/plusim-job-<jobId>`:

   ```
   python3 {baseDir}/scripts/run_job.py prepare --manifest-url '<manifest url>' --workdir $WD
   ```

   This downloads the manifest + statement files (authenticated with
   `PLUSIM_RUNTIME_TOKEN`), parses every statement, dedups, applies the
   merchant dictionary + deterministic rules, and prints a JSON summary.

2. **Read the shortlist.** `$WD/needs_judgment.json` lists merchants no
   rule/dictionary entry covers, with sample dates/amounts/notes and MAX's own
   category hint when present.

3. **Judge (the only model step).** Following
   `{baseDir}/reference/categorization-rules.md`, write `$WD/judgments.json`:

   ```json
   {
     "<merchant>": {"category": "<taxonomy leaf>", "note": "why", "propose": true},
     "<unclear merchant>": {"uncategorized": true, "note": "reason"}
   }
   ```

   - Category names must be EXACT leaf names from the manifest's taxonomy.
   - **Never guess.** Mall-name-only descriptors, prepaid top-ups, and
     unidentifiable merchants get `"uncategorized": true` with a reason.
   - Set `"propose": true` only for merchants likely to recur, so the admin
     can approve them into the permanent dictionary.

4. **Finalize.**

   ```
   python3 {baseDir}/scripts/run_job.py finalize --workdir $WD
   ```

   This builds the workbook, verifies **to the agora** against the statements'
   own totals, and POSTs the full result to the app's callback URL. If
   verification fails it still POSTs, with `status: needs_review` — never hide
   a mismatch, and never edit numbers to force a match.

5. **Cleanup (mandatory — statements are personal financial data).**

   ```
   python3 {baseDir}/scripts/run_job.py cleanup --workdir $WD
   ```

6. **Reply** in chat with ONE short line (the callback is the source of truth,
   the reply is just an ack):

   ```
   DONE <jobId> status=<ok|needs_review> tx=<n> uncat=<m>
   ```

## Failure handling

- Any script error: retry once; if it persists, reply
  `FAILED <jobId> <one-line reason>` and still run cleanup.
- Do not write anything about a job to memory or to per-user files — job
  sessions are isolated and stateless by design.
