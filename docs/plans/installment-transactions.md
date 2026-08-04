# Plusim — Installment transactions (תשלומים / קרדיט): correct month, visible badge, editable date

> **Status:** **Rev 5 — APPROVED TO IMPLEMENT** (Codex rounds 1–4 folded; owner decision
> 2026-08-04 at the protocol-3c round bound: fold the final two docs-contract fixes and proceed to
> implementation, which carries its own adversarial review).
>
> **Review log:**
> - Rev 1 — authored from a file-anchored read plus a fresh parse of the real statement with the
>   deployed parser (§0).
> - Rev 2 — folds Codex round 1 (all four accepted):
>   **P1-a** multi-block statements: global-latest charge date re-creates the wrong-month bug for
>   rows belonging to an earlier block → substitution is now **per block** (§2.2).
>   **P1-b** fail-open on a missing charge date would let the admin publish the exact wrong-month
>   report this plan exists to prevent → now **fail-closed**: undated installment rows are flagged
>   in the payload and app-side verification turns the flag into a FATAL problem (§2.2.3); Ask 4 is
>   resolved accordingly.
>   **P1-c** edits during an active re-run are silently erased by the result callback's
>   delete+recreate → route-level 409 while the agent is running + UI disable; this also closes the
>   **pre-existing** identical race on category assignment (§2.3).
>   **P1-d** the client guide update is mandatory under AGENTS.md rule 4, not discretionary (§2.4).
> - Rev 3 — folds Codex round 2 (both accepted; both are refinements of Rev 2's own folds):
>   **P1-e** the charge-date scan was unbounded — with a missing block date it could mistake the
>   NEXT transaction's deal date for the charge date and substitute a wrong date *without* the
>   `undatedInstallment` flag, silently defeating P1-b. The scan is now bounded to the block: the
>   date must sit between the `סה"כ` label and the block's own total amount (§2.2.1).
>   **P1-f** the running-state edit guard was check-then-write (TOCTOU): a re-run CASing the job to
>   `dispatched` between the check and the write still lost the edit. The WRITE itself is now
>   conditional on the job's status — the same `updateMany` + count CAS the result route uses
>   (§2.3). (Round 2's third inline comment is round 1's P1-c re-anchored by GitHub — same body,
>   same timestamp — already folded in Rev 2 and superseded by P1-f.)
> - Rev 4 — folds Codex round 3 (one finding, accepted):
>   **P1-g** the documentation contract (`docs/guides/README.md:33`) requires a new client-visible
>   feature to add a ROADMAP **"Shipped"** entry alongside the client guide — verified against the
>   contract table, added to §2.4.
> - Rev 5 — folds Codex round 4 (two findings, accepted; both docs/contract wording, no design
>   change): **P1-h** the "עודכן לאחרונה" bump is an explicit deliverable for the admin guide too,
>   not only the client guide (§2.4). **P2-a** §2.3's concrete UI line said `disabled while busy`,
>   contradicting the section's own `running` directive — now `busy || running` (§2.3).
>   Round 4 completed without a clean verdict, so per protocol 3c the loop stopped and the owner
>   chose (b): fold these and implement. Rounds converged from design holes (1–2) to docs nits
>   (3–4); the implementation PR still gets a full adversarial review.
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
> client-facing financial report. No schema migration; the agent contract gains exactly one
> **optional, transient** integrity flag (`undatedInstallment`, Rev 2 — checked at verification,
> never stored). The badge itself still rides the existing `note` field — that carrier decision is
> the one this review should attack (Ask 1).
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
> 4. ~~**Fail-open on a missing charge date.**~~ **Resolved in Rev 2 (Codex P1-b): fail-closed.**
>    An installment row whose block has no extractable charge date is flagged in the payload and
>    app-side verification makes it FATAL — the job cannot be published until the parser (or the
>    statement) is fixed. Same philosophy as refusing an unrecognized statement (#38).

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

1. **Per-block charge dates, bounded to the block (Rev 2 — Codex P1-a; Rev 3 — Codex P1-e).** A
   `לתאריך חיוב סה"כ` block closes the run of rows above it (the domestic walker already treats
   blocks as subtotal boundaries, `:259-266`). The block's layout is `סה"כ`-label → date line →
   total-amount line, so the charge date is the `DATE_RE` line **between the label and the block's
   own total amount — and nowhere past it**. An unbounded "first date after the label" scan would,
   when the block's date is missing or truncated, walk into the NEXT transaction's deal date and
   substitute a wrong date **without** raising the `undatedInstallment` flag — silently defeating
   step 3's fail-closed guarantee. No date inside the bounded window ⇒ the block has no charge
   date ⇒ its rows take the step-3 path. Each parsed row associates with **the block that closes
   it** — never a single statement-wide date: on a statement with an early-repayment subtotal
   (charge date D1) followed by the regular cycle (D2), installment rows above the first block get
   D1 and rows between the blocks get D2. The single-block case (the fixture: one block,
   `15/05/26`) degenerates to the same behavior Rev 1 described.
2. Substitution runs per section **before Phase 4 assigns dedup keys**: for every row whose `note`
   matches the installment pattern (same pattern as §2.1, Python side):
   - keep the original date in the note: `note = f"{note} · עסקה מקורית: {orig_date}"`;
   - set `date = <its block's charge date>`.
   Then Phase 4 computes dedup keys from the substituted dates — two same-merchant same-amount
   installments on the same charge date stay distinct via the existing `|{seq}` suffix (`:113-114`).
3. **No charge date for a block that contains installment rows → fail closed (Rev 2 — Codex
   P1-b).** Substitute nothing for those rows and stamp each one `undatedInstallment: true` in the
   payload transaction (a transient contract field — accepted by `parseAgentResult`, checked by
   `verifyAgentResult`, **never stored**; no schema change). App-side verification adds a problem
   per flagged row (`תשלום ללא תאריך חיוב (<merchant>)`) — problems are FATAL, so **the publish
   route refuses the job** (`publish/route.ts:91-101`) until the parser or the statement is fixed.
   `run_job.py` also demotes its own declared status to `needs_review` (belt; the app-side check is
   the suspenders and is what actually blocks). A warning still lands in `agentNotes` so the admin
   sees *why*. Old skill versions never send the field, and `parseAgentResult` treats it as
   optional — so the app deploys first and nothing breaks in the gap (§6).

`month` follows automatically (`run_job.py:398` derives it from the date), so the
date-outside-month check (`reportResult.ts:251`) stays consistent by construction. Amounts are
untouched, so per-source totals still reconcile to the agora.

### 2.3 App: date editing on the existing PATCH route

Widen `transactions/[txId]/route.ts` — same auth gate, no new surface:

- **No edits while the agent is running — enforced by the write itself (Rev 2 — Codex P1-c;
  Rev 3 — Codex P1-f).** The result callback delete+recreates every transaction row
  (`result/route.ts:73-88`), so an edit accepted mid-run returns success and then silently
  vanishes. A check-then-write guard still loses the race when the run route CASes the job to
  `dispatched` between the check and the write — so the guard is the WRITE: one conditional
  `updateMany` whose `where` joins the parent job's status,
  `{ id: txId, jobId, job: { status: { notIn: ["dispatched", "processing"] } } }` — one SQL
  statement, the same count-CAS pattern the result route itself uses (`result/route.ts:58-71`).
  `count === 0` ⇒ re-read the row to disambiguate: missing ⇒ 404, running ⇒ 409 with a Hebrew
  message (the read is for the error text only; the write already refused atomically). The
  `rememberMerchant` upsert runs only after a successful count. This guard covers **category
  assignment too — the identical race exists today** and this closes it at the shared route (root
  cause, not the new path only). UI: the date input and the assign controls disable under the
  existing `running` flag (`computeRunGate`), matching how upload/delete already hide mid-run —
  display hygiene; the conditional write is the guarantee.
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
  **`busy || running`** (Rev 5 — Codex P2-a: `busy` clears as soon as the enqueue request returns,
  while the job stays `dispatched`/`processing`, so a `busy`-only guard leaves the input live
  against a route that will 409 every edit). The published-re-run confirm dialog (`:172-175`) gains one clause: manual date edits are
  also recomputed on re-run — same clobber rule as unsaved category assignments.

### 2.4 Guides (same impl PR, per AGENTS.md rule 4)

`ADMIN_GUIDE.he.md`: what the badge means (N מתוך M), that installment rows are dated by the
statement charge date with the original deal date kept in the note, how to edit a date, that
editing is unavailable while the agent works, and that a re-run recomputes both — **and its
"עודכן לאחרונה" date bumped (Rev 5 — Codex P1-h; AGENTS.md:58 requires the bump for every guide
touched, not just the client one).**
`CLIENT_GUIDE.he.md`: **mandatory, same PR (Rev 2 — Codex P1-d, AGENTS.md rule 4)** — the client
page's ללא-סיווג rows gain a visible badge, so the client guide documents it and bumps its
"עודכן לאחרונה" date. **`ROADMAP.md`: a "Shipped" entry for the feature (Rev 4 — Codex P1-g;
`docs/guides/README.md:33` requires it for every new client-visible feature).** Both guides + the
ROADMAP entry ship in the implementation PR.

## 3. Invariants

1. **Totals are untouched.** Date substitution and date edits never change `amountAgorot`; every
   per-source total that reconciled before reconciles after (ground truth: 578073 = 578073).
2. **`month` ≡ `date[:7]`** everywhere a date is written: parser output (derived at
   `run_job.py:398`) and the PATCH route (single update sets both).
3. **Dedup keys stay unique** after substitution: keys are assigned post-substitution and carry the
   sequence suffix.
4. **A date-only edit never changes categorization state**; a category-only edit never changes the
   date. The route has no path that writes one field from the other's branch.
5. **Each installment row takes its own block's charge date** — never a statement-global date
   (Rev 2). A block that closes rows governs exactly those rows.
6. **No charge date ⇒ no substitution AND no publication** (Rev 2): the flagged rows make
   verification FATAL. Never a guessed or invented date, never a silent wrong-month publish.
7. **No transaction edit lands while the agent is running** (Rev 2; atomic per Rev 3): the WRITE
   is conditional on the parent job's status — for date AND category alike. There is no
   check-then-write window.
8. **The badge is display-only.** No logic (verification, bucketing, export) branches on
   `installmentInfo` — it reads the same `note` everything already stores. (`undatedInstallment`
   is a separate, transient integrity flag — it never renders and is never stored.)

## 4. Tests (named; the impl PR carries all of them)

Parser (`test_parse_leumi_pdf.py`, synthetic line fixtures — the real PDF is PII and stays out of
git):

- `installment_row_gets_charge_date_and_keeps_deal_date_in_note`
- `kredit_wording_is_detected` (`תשלום - קרדיט 6 מתוך 13`)
- `non_installment_rows_keep_their_deal_date`
- `installment_rows_take_their_own_blocks_charge_date` (Rev 2 — rows on both sides of an
  early-repayment subtotal get D1 and D2 respectively, never one global date)
- `undated_installment_rows_are_flagged_not_guessed` (Rev 2 — no block date ⇒ `undatedInstallment`
  on exactly the matching rows, dates untouched)
- `missing_block_date_never_steals_the_next_rows_deal_date` (Rev 3 — a dated transaction sitting
  right after a date-less total block must NOT be read as the charge date; the block's rows get
  flagged instead)
- `same_merchant_same_amount_installments_stay_distinct_after_substitution` (dedup)
- `substitution_changes_no_amount_and_no_total` (sum before == sum after)

Contract + verification (Rev 2 — Codex P1-b; `reportResult.test.ts` + a run_job status test):

- `undated_installment_flag_is_a_fatal_problem` (verifyAgentResult: flagged row ⇒ problem ⇒
  publish route refuses)
- `payload_without_the_flag_verifies_exactly_as_today` (regression — old skill versions)
- `run_job_demotes_status_to_needs_review_when_any_installment_is_undated` (tests the resulting
  status, not just a warning)

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
- `edits_rejected_while_agent_is_running` (Rev 2 — 409 for `dispatched` AND `processing`, for a
  date-only edit AND a category-only edit; the rerun/edit race test Codex asked for)
- `edit_write_is_conditional_on_job_not_running` (Rev 3 — the check/run interleaving: the
  conditional `updateMany` returns count 0 even though a pre-read saw `completed` ⇒ 409, no
  mapping upsert, nothing written)

## 5. Deliberately NOT building

- **A dedicated, STORED `installment` column for the badge.** Costs a Prisma migration and a
  result-route write for what one regex over an existing field provides. Revisit only if the badge
  needs to drive *logic* (it must not — invariant 8). Distinct from Rev 2's `undatedInstallment`,
  which is an integrity flag: optional in the contract, consumed at verification, never persisted.
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
   renderers, PATCH widening + UI, both guides, full test list above. **Deploy order inside the
   step: the app (merge → Coolify auto-deploy) before the skill copy** — the app must accept and
   check `undatedInstallment` before any skill version can send it; the reverse gap is harmless
   (old skill never sends it) but the discipline keeps the fail-closed check live from the first
   flagged payload. Verified end-to-end by re-running דיין 9 (owner clicks; agent re-parses the
   same statement) and checking the five rows land in 2026-05 with badges.
