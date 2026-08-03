---
name: plusim-reports
description: Process Plusim statement-categorization jobs. Triggered by chat messages starting with PLUSIM_REPORT_JOB. Fetches the job manifest from the Plusim app, parses Israeli card statements (Isracard/Leumi xlsx, MAX pdf) and Bank Discount current-account (עובר ושב) xlsx exports, categorizes transactions into the household budget taxonomy, builds the month-sheet xlsx, verifies totals to the agora, and POSTs the result back to the app.
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

Requirements: bare `python3` only — `openpyxl` and `pypdf` are **vendored** in
`{baseDir}/vendor/` (the sandbox wipes `~/.local` between exec calls, so
`pip install --user` does not survive; `run_job.py` adds `vendor/` to
`sys.path` itself). If `vendor/` is ever missing, rebuild it once:

```
python3 -m pip install --target {baseDir}/vendor openpyxl pypdf
```

## Pipeline

1. **Prepare.** Pick a scratch dir. It **must** be an absolute path under
   `/tmp` — always `WD=/tmp/plusim-job-<jobId>`. The scripts refuse anything
   else, because statements are customer financial data and the workspace is
   persistent: a scratch dir inside it leaves the PDFs behind after cleanup.
   Pass `--workdir` as its own argument and never let shell/JSON punctuation
   glue onto it (a mangled value once created a directory named
   `,timeout:300}` in the skill folder and leaked a statement into it):

   ```
   python3 {baseDir}/scripts/run_job.py prepare --manifest-url '<manifest url>' --workdir $WD
   ```

   This downloads the manifest + statement files (authenticated with
   `PLUSIM_RUNTIME_TOKEN`), parses every statement, dedups, applies the
   merchant dictionary + deterministic rules, and prints a JSON summary.

2. **Read the shortlist.** `$WD/needs_judgment.json` is an object with two keys:
   - `merchants` — the merchants the deterministic pass (merchant dictionary →
     built-in rules → MAX category) could NOT place, with sample
     dates/amounts/notes and MAX's own category hint when present.
   - `reportRules` — admin-authored guidance for THIS job (a string; may be
     empty). It steers your judgment of `merchants` only; it does **not** change
     categories the deterministic pass already assigned (exact per-merchant
     overrides are made app-side via the merchant dictionary, which runs first).

3. **Judge (the only model step).** Following
   `{baseDir}/reference/categorization-rules.md` **plus** any `reportRules` from
   `needs_judgment.json` (when `reportRules` conflicts with the reference doc,
   follow `reportRules`; an empty `reportRules` means the static playbook only),
   assign a category to each merchant in `merchants` and write `$WD/judgments.json`:

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
- **Rejected `--workdir`** (`UnsafeWorkdirError`): do NOT retry with a different
  directory or work around it. Re-run the SAME command with
  `--workdir /tmp/plusim-job-<jobId>`; the guard exists because scratch outside
  `/tmp` leaves customer statements in the persistent workspace.
- Do not write anything about a job to memory or to per-user files — job
  sessions are isolated and stateless by design.
