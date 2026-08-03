# Plusim — Installment transactions (תשלומים / קרדיט): correct month, visible badge, editable date

> **Status:** Draft — Rev 1. Nothing implemented yet.
>
> **Process** (self-contained — canonical protocol in `docs/PLAN_REVIEW_PROTOCOL.md`): plan PR →
> adversarial Codex review → each round becomes a new Rev with resolution notes (never silently
> rewrite reviewed text) → every caught hole becomes a named test the implementation PR must carry →
> once approved, implement exactly the plan; deviations go back to the owner.
>
> **Why a plan:** this changes how money is **bucketed by month** in every rendering of the report
> (client `/report`, admin online view, the exported workbook), touches the report-verification
> interplay (`date`↔`month` consistency is a FATAL check, `src/lib/reportResult.ts:251-253`), and
> widens an admin mutation route. A bug here scatters or double-buckets real charges in a
> client-facing financial report. No schema migration and no agent-contract change — that is a
> headline design decision this review should attack (Ask 1).
>
> **Review asks (attack these):**
> 1. **The no-new-field decision.** The installment marker rides the existing free-text `note`
>    (parser-normalized, regex-detected in UI). Is there an interleaving where note text is
>    rewritten/appended (judgment notes are appended with `" · "`, `run_job.py:472-481`) such that
>    the badge regex false-positives or false-negatives? Would a dedicated column actually be safer,
>    given it costs a migration + agent-contract change + result-route validation?
> 2. **Date substitution vs verification.** After substituting the statement charge date into
>    installment rows, is there ANY path where `verifyAgentResult` newly reports a problem
>    (date-outside-month, duplicate dedupKey, total mismatch) on a statement that verified clean
>    before? Dedup keys embed the date — two same-merchant same-amount installments now share a date.
> 3. **The date-edit route.** The existing PATCH requires a valid category
>    (`transactions/[txId]/route.ts:27-30`). The widened body must not let a date-only edit clear
>    `uncategorized`, must not let a category-only edit touch the date, and must reject a date that
>    silently disagrees with the recomputed `month`. Attack the field-interaction matrix.
> 4. **Fail-open on a missing charge date.** When no `לתאריך חיוב סה"כ` date is found, dates stay
>    as-is and a warning flows to `agentNotes`. Is fail-open right here, or does an undated
>    statement need to block?

---

## 0. The incident that motivates this

Real statement `5 דודו.pdf` (the file behind job דיין 9), parsed 2026-08-04 with the **deployed**
`parse_leumi_pdf.py` on the agent box: 30 transactions, recomputed sum **578073 agorot — exact to
the statement total**. Amounts are already right. Dates are not:

```
2025-09-28 |  53386 | תאילנד למטייל המרכז | תשלום 8 מתוך 12
2025-09-29 |  14775 | 9                   | תשלום 8 מתוך 12
2025-11-15 |  13039 | חול סל              | תשלום - קרדיט 6 מתוך 13
2025-12-15 |  81403 | חול סל              | תשלום - קרדיט 5 מתוך 13
2026-03-25 |  19900 | חריש פארם סופר      | תשלום 2 מתוך 2
```

All five are installments **charged in the 15/05/26 cycle**, but the statement prints the original
deal date, so they bucket into months 2025-09, 2025-11, 2025-12, 2026-03 — four phantom months in a
May-2026 report, and May undercounts by ₪1,825.03. The statement's own charge date is printed in
the total block the parser already reads: extracted line 405 = `לתאריך חיוב סה"כ` followed by
`15/05/26`.

Owner spec (2026-08-04): (1) badge installment rows through the whole report lifecycle, showing
N-of-M; (2) date them by the statement charge date, not the deal date; (3) let the admin edit a
transaction's date; (4) ignore the קרן/ריבית fee decomposition — the monthly charge amount is the
transaction. Installment blocks appear at the start or end of statements.

## 1. What exists (read first; all cited)

- **`agent/skills/plusim-reports/scripts/parse_leumi_pdf.py`** — the parser for this format
  (labels `<label>-domestic` / `<label>-foreign`).
  - Already extracts installment text: `_read_installment` (`:440-451`) collects
    `תשלום X מתוך Y` lines into `note`. Ground truth shows two wordings: `תשלום 8 מתוך 12` and
    `תשלום - קרדיט 6 מתוך 13` (RTL extraction reorders "קרדיט"). קרן/ריבית lines do NOT leak into
    the note (collection stops at `מתוך` + digit) and do NOT corrupt amounts (`AMOUNT_RE` is
    whole-line anchored, `:27`; the recomputed sum matches to the agora).
  - Charge amount is already the monthly charge, not the deal total: `amounts[1]` when ≥2 amounts
    (`:419-422`). **Requirement 4 is already satisfied; this plan changes nothing about amounts.**
  - The section-total block carries the charge date: `_extract_total` (`:454-460`) scans past the
    `סה"כ` line for the first amount and **skips the date line sitting between them**. Multiple
    total blocks can exist (early-repayment subtotals, `:259-266`).
  - Dedup keys are assigned in Phase 4 (`:109-114`) **after** parsing, from
    `label|date|merchant|amount` + a sequence suffix for identical rows.
- **`agent/skills/plusim-reports/scripts/run_job.py`** — `month` is derived, not stored:
  `"month": t.date[:7]` (`:398`). Parser warnings flow `res.warnings` → `warnings` (`:414`) →
  payload `agentNotes` (`:519`) → admin verification panel (`ReportJobDetail.tsx` renders
  `v.agentNotes`).
- **`src/lib/reportResult.ts`** — `verifyAgentResult` treats date-outside-month as a problem
  (`:251-253`, FATAL via the problems list) and duplicate `dedupKey` likewise (`:256-262`).
  Transactions carry `note` through `parseAgentResult`; the result route stores it
  (`src/app/api/agent/jobs/[jobId]/result/route.ts:85`).
- **`src/app/admin/api/reports/[jobId]/transactions/[txId]/route.ts`** — the only per-transaction
  mutation. Body `{category, rememberMerchant}`; **rejects any call without a valid category**
  (`:27-30`); sets `{category, uncategorized: false}` (`:35-38`).
- **Renderers, all DB-driven except the workbook:** admin job page (`ReportJobDetail.tsx` — both
  tables already display `note`), admin online view (`view/page.tsx:54` selects `note`), client
  `/report` (`src/app/report/page.tsx` — month buckets from `t.month`; individual rows shown only
  in the ללא-סיווג table, `:144-152`, which does not select `note`). The workbook is built **once,
  agent-side** (`build_report_xlsx.py`; note columns exist in the ledger and uncat sheets,
  `:452-475`); no app-side xlsx builder exists — admin edits after finalize reach DB views
  immediately and the exported sheet only via re-run + re-publish. That asymmetry is today's
  behavior for category assignments and is **not changed** by this plan.
- **`parse_isracard_xlsx.py:119`** reads the statement's own note column (`תשלום N מתוך M` appears
  there when applicable) — the shared badge (§2.1) lights up for those rows with zero extra work.
  `parse_max_pdf.py` extracts no installment text today; `parse_discount_xlsx.py` is a bank
  account — installments do not apply.

## 2. Design

### 2.1 One shared detector, no new field

`note` already carries the installment text end-to-end (parser → payload → DB → every renderer →
workbook). Add one pure helper in `src/lib/reportAnalysis.ts`:

```ts
/** "תשלום 8 מתוך 12" / "תשלום - קרדיט 6 מתוך 13" → {n: 8, of: 12} | null.
 *  Bounded gap so unrelated text between תשלום and the numbers can't bridge a match. */
export function installmentInfo(note: string | null): { n: number; of: number } | null {
  const m = /תשלום(?:[^0-9]{0,20})(\d{1,3})\s*מתוך\s*(\d{1,3})/.exec(note ?? "");
  return m ? { n: Number(m[1]), of: Number(m[2]) } : null;
}
```

Renderers call it and show a small chip `‏8/12‏ 🔁` (exact styling impl-time) with the full note as
tooltip:

- `ReportJobDetail.tsx` — כל העסקאות table + the uncategorized table.
- `view/page.tsx` (online report) — the פירוט תנועות rows and the drill-down side panel.
- `src/app/report/page.tsx` (client) — add `note` to the transaction select; badge on the
  ללא-סיווג rows (the only per-transaction rows that page renders).
- Workbook: the note text is already in the ledger/uncat sheets — no builder change.

Judgment notes are **appended after** parser notes with `" · "` (`run_job.py:472-481`), so the
parser's prefix survives and the regex keeps matching (Ask 1 covers the residual risk).

### 2.2 Parser: substitute the statement charge date (parse_leumi_pdf.py only)

1. Capture the charge date where the total already comes from: extend the total-block read to also
   take the **first `DATE_RE` line after the `סה"כ` line** (it precedes the amount). With multiple
   blocks (early-repayment subtotals), keep the **latest** date — the regular cycle's charge date.
2. After both sections parse and **before Phase 4 assigns dedup keys**, for every transaction whose
   `note` matches the installment pattern (same pattern as §2.1, Python side):
   - keep the original date in the note: `note = f"{note} · עסקה מקורית: {orig_date}"`;
   - set `date = charge_date`.
   Then Phase 4 computes dedup keys from the substituted dates — two same-merchant same-amount
   installments on the same charge date stay distinct via the existing `|{seq}` suffix (`:113-114`).
3. **No charge date found** → substitute nothing, append
   `res.warnings.append(f"{path}: לא נמצא תאריך חיוב — תאריכי תשלומים נותרו כתאריך העסקה המקורי")`
   → surfaces in the admin verification panel via `agentNotes`. Fail-open because the pre-plan
   behavior (deal dates) is wrong months, not wrong money — totals are unaffected either way
   (Ask 4).

`month` follows automatically (`run_job.py:398` derives it from the date), so the
date-outside-month check (`reportResult.ts:251`) stays consistent by construction. Amounts are
untouched, so per-source totals still reconcile to the agora.

### 2.3 App: date editing on the existing PATCH route

Widen `transactions/[txId]/route.ts` — same auth gate, no new surface:

- Body becomes `{category?, rememberMerchant?, date?}`; **at least one of `category`/`date`
  required** (else 400).
- `category`, when present: exactly today's behavior (validate against merged leaf set, set
  `uncategorized: false`, optional mapping upsert). When absent: category and `uncategorized` are
  **not touched** — a date-only edit must never mark a row categorized (Ask 3).
- `date`, when present: must match `^\d{4}-\d{2}-\d{2}$` **and** round-trip through `new Date()`
  to the same ISO day (rejects `2026-02-31`). The update sets **both** `date` and
  `month = date.slice(0, 7)` in one `update` call — `date`/`month` can never diverge.
- UI (`ReportJobDetail.tsx`): in the כל העסקאות table the date cell becomes a native
  `<input type="date">` (platform rung — no picker lib) that PATCHes on change; disabled while
  `busy`. The published-re-run confirm dialog (`:172-175`) gains one clause: manual date edits are
  also recomputed on re-run — same clobber rule as unsaved category assignments.

### 2.4 Guides (same impl PR, per AGENTS.md rule 4)

`ADMIN_GUIDE.he.md`: what the badge means (N מתוך M), that installment rows are dated by the
statement charge date with the original deal date kept in the note, how to edit a date, and that a
re-run recomputes both. `CLIENT_GUIDE.he.md`: unchanged (the client page's only per-row rendering
is the uncat table; a one-line mention is impl-time discretion).

## 3. Invariants

1. **Totals are untouched.** Date substitution and date edits never change `amountAgorot`; every
   per-source total that reconciled before reconciles after (ground truth: 578073 = 578073).
2. **`month` ≡ `date[:7]`** everywhere a date is written: parser output (derived at
   `run_job.py:398`) and the PATCH route (single update sets both).
3. **Dedup keys stay unique** after substitution: keys are assigned post-substitution and carry the
   sequence suffix.
4. **A date-only edit never changes categorization state**; a category-only edit never changes the
   date. The route has no path that writes one field from the other's branch.
5. **No charge date ⇒ no substitution**, with a human-visible warning — never a guessed or invented
   date.
6. **The badge is display-only.** No logic (verification, bucketing, export) branches on
   `installmentInfo` — it reads the same `note` everything already stores.

## 4. Tests (named; the impl PR carries all of them)

Parser (`test_parse_leumi_pdf.py`, synthetic line fixtures — the real PDF is PII and stays out of
git):

- `installment_row_gets_charge_date_and_keeps_deal_date_in_note`
- `kredit_wording_is_detected` (`תשלום - קרדיט 6 מתוך 13`)
- `non_installment_rows_keep_their_deal_date`
- `no_charge_date_block_leaves_dates_and_adds_warning`
- `multiple_total_blocks_use_the_latest_charge_date`
- `same_merchant_same_amount_installments_stay_distinct_after_substitution` (dedup)
- `substitution_changes_no_amount_and_no_total` (sum before == sum after)

Helper (`reportAnalysis` unit tests):

- `installmentInfo_parses_both_wordings`
- `installmentInfo_rejects_notes_without_numbers` (e.g. `תשלום חודשי`, plain `הוראת קבע`)
- `installmentInfo_ignores_unbounded_gaps` (installment digits >20 chars after תשלום don't match)

Route (`transactions PATCH` tests, mocked db — same style as `deleteJob.test.ts`):

- `date_only_edit_updates_date_and_month_and_nothing_else`
- `date_only_edit_does_not_clear_uncategorized`
- `category_only_edit_still_works_unchanged` (regression)
- `date_and_category_together_apply_both`
- `invalid_date_shapes_400` (`2026-2-3`, `2026-02-31`, `31/05/2026`, empty)
- `body_with_neither_field_400s`

## 5. Deliberately NOT building

- **A dedicated `installment` column / agent-contract field.** Costs a Prisma migration, a
  `parseAgentResult` change, and a result-route write for what one regex over an existing field
  provides. Revisit only if the badge needs to drive *logic* (it must not — invariant 6).
- **MAX-format (`parse_max_pdf.py`) installment extraction.** No fixture with installments in
  hand; that parser extracts no תשלום text today. The shared badge lights up automatically the day
  its notes carry the pattern. Follow-up when a real MAX statement with installments exists.
- **An app-side workbook rebuilder** so date edits reach the exported sheet without a re-run.
  Date edits inherit the exact staleness rule category assignments already have; building a second
  xlsx builder to fix both is its own plan.
- **Editing merchant/amount.** Amounts are reconciled to the agora against the statement — an
  editable amount breaks the reconciliation invariant. Not asked for, not building.
- **Statement-period validation of edited dates** (e.g. "date must fall within the statement
  month"). The admin is the trusted operator here; the fatal checks still guard the agent path.

## 6. Sequencing

1. This plan PR → Codex review rounds → approval.
2. One implementation PR: parser change + skill-file sync to the agent box (manual copy, same
   pipeline as #44/#46 — git and the running agent stay byte-identical), `installmentInfo` +
   renderers, PATCH widening + UI, guides, full test list above. Verified end-to-end by re-running
   דיין 9 (owner clicks; agent re-parses the same statement) and checking the five rows land in
   2026-05 with badges.
