# Plusim — Bank current-account statements: income, credit-card settlements, and the reconciliation card

> **Status:** Draft — **Rev 4**, internal adversarial round folded in (owner directive 2026-10-25:
> after Codex round 3, internal review only for this PR). Nothing implemented yet.
>
> **Process** (self-contained): plan PR → adversarial review → each round becomes a new Rev on
> this branch with resolution notes → every caught hole becomes a named test the implementation
> PR must carry → once approved, implement exactly the plan.
>
> **Review log:**
> - Rev 1 — authored from two real bank PDFs (Bank Hapoalim 6-month export, Bank Leumi
>   current-account export, text layer, no OCR) and a file-anchored read of the pipeline.
>   Ponytail pass ran before handoff.
> - Rev 2 — Codex round 1 (PR #52): Leumi balance delta is bank-sign and must be negated;
>   dictionary/RULES eligibility made kind-aware; settlement PATCH predicate bound to
>   `{id, jobId}`; a billing month added for matching.
> - Rev 3 — Codex round 2: shortlist/judgments keyed by `(merchant, kind)`; one billing month per
>   source replaced by per-charge-block cycles; OCR note corrected to `openclaw-dashboard#811`.
> - Rev 4 — **internal adversarial round** (two reviewers, claims executed against the two real
>   dumps; Codex round 3 never completed and is no longer requested). Folded, with the test that
>   banks each one:
>   **P1** both bank PDFs are already *detected* by `detect_leumi_pdf` (they contain `ישראכרט` +
>   a dd/mm/yy-shaped date) and Hapoalim also by `detect_max_pdf`'s Diners branch (which would
>   parse running balances as amounts, ₪107,487.42 as a charge) — the bank detector now runs
>   **first** and both card detectors are tightened. **P1** Leumi's `אסמכתא` is a counterparty
>   id, not a voucher (102 of 133 rows share one) — the reference-based dedup key would have made
>   every Leumi job fatal; key is now `label|date|description|amount|seq`. **P1** the
>   oldest-row text heuristic was wrong on 103/133 rows and its sign rule failed on the real
>   oldest row (a salary stored as a ₪718k expense) — replaced by the sibling-reference method,
>   else drop-with-warning. **P1** bare `כאל` in `SETTLEMENT_PAYEES` matches `מיכאל` — token
>   matching, and the unobserved string is removed. **P2** "any credit ⇒ income" misfiled real
>   refunds (12 `שירותי בריאות` credits) — credits are `direction: credit`, the model decides
>   income vs refund, and the stored `kind` is the final placement. **P2** `kind` was not
>   persisted, so neither `verifyAgentResult` nor the admin edit route could hold the income
>   invariant — `kind` now rides the payload and the row (reversing part of the Rev 1 ponytail
>   cut, for income only). **P2** cycle id `label@month` collides for two blocks in one month —
>   id is `label@chargeDate`. **P2** a bank-only job silently loses every issuer debit into
>   settlements — now a visible note with the unmatched sum. **P3** settlement/cycle payload
>   validation tightened to the transaction standard; B4 is one bound predicate; real data has
>   several settlements per cycle so matching is many-to-one; cycle-date extraction work stated
>   honestly (Isracard xlsx has no header date); `INCOME_RULES` gains `בטוח לאומי`; counts in
>   Context corrected; dictionary is one-direction per merchant so income rows propose nothing.
>   **Cuts:** `matchedAt`, `incomeTotalsAgorot`, the `סילוקי אשראי` sheet.

## Context

1. **Bank current-account statements are supported as Bank Discount xlsx only.**
   `agent/skills/plusim-reports/scripts/parse_discount_xlsx.py` parses the עובר ושב sheet; every
   other bank PDF is refused by `parse_pdf_auto` (`run_job.py`, `UnknownStatementError`: *"Bank
   current-account statements are supported as xlsx only"*). The two statements the owner needs
   are PDFs, and **both are currently mis-detected as card statements** (verified against the
   dumps): `detect_leumi_pdf` (`parse_leumi_pdf.py:69-79`) needs only `ישראכרט` in the first
   2 000 chars plus a `\d{2}/\d{2}/\d{2}` match — both bank statements contain Isracard
   settlement rows and dd/mm/yyyy dates, so both return True and `parse_leumi_pdf` yields 0 rows;
   `detect_max_pdf`'s Diners branch (`parse_max_pdf.py:117-123`) also accepts the Hapoalim file
   (dd/mm/yy-shaped date + `₪` on the same line) and `parse_max_pdf` then returns 147 rows whose
   "amount" is the **running balance** with `statementTotal = None` — nothing fatal would flag it.
   - **Bank Hapoalim** (`bankhapoalim.co.il` in every page header). Rows are one glued line:
     `dd/mm/yyyy<description><amount>₪<running balance>##N` where `##1` = credit (זכות) and
     `##2` = debit (חובה) — the sign is explicit and confirmed by the balance chain on all 147
     rows. Newest first; page headers repeat `יתרה בש"חזכותחובהפעולהתאריך`; the only date-led
     non-rows are the `*2407 … bankhapoalim.co.il` header line and one period line
     `06/10/2026-06/04/2026`; a lone `7` closes each page.
   - **Bank Leumi** (`תנועות בחשבון| בנק לאומי`, `מס' חשבון`). Rows:
     `dd/mm/yyyy dd/mm/yyyy<description><reference><amount><running balance>` with reference and
     amount **glued** (`המרת קנ במטח956246.32​-14,304.47` = ref 9562, amount 46.32, balance
     −14,304.47); U+200B (88 occurrences) before negative balances and in the header; no
     debit/credit marker. The sign and exact amount of every row except the oldest follow from the
     balance chain (verified: 133/133 non-oldest rows pass the glued-suffix cross-check). The
     `אסמכתא` is a **counterparty / loan / standing-order id**, not a per-posting voucher: `34685`
     (מקס איט) appears 19×, `4969004` 12×, `74677` (the salary payer) 7× — 102 of 133 rows share
     a reference with another row.
2. **Bank rows are three different things**, and today's pipeline has a name for only one.
   Classification is by **direction** (debit/credit) plus payee, so the lists below are
   illustrative, not exhaustive:
   - **Credit-card settlements** — the bank *debit* that pays a card statement (`ישראכרט בע"מ`,
     `ישראכרט-כ.ויזה`, `כרטיסי אשראי ל…`, `מקס איט פיננ-י`, `לאומי מאסטרקרד`, `לאומי ויזה`).
     61 of the Hapoalim rows and 46 of the Leumi rows. Every one is already itemized on the card
     statement — counting them as expenses double-counts the whole card. Leumi pays MAX with
     **two** debits on the same day each month (e.g. ₪15,395.14 + ₪6,756.55); Hapoalim's
     `ישראכרט בע"מ` rows are mostly small immediate/out-of-cycle debits (~9 per month) plus one
     monthly statement debit.
   - **Income** — credits: salary (`מדיסון פארמה ב`, `פרפקטו מוביי-י`), `קצבת ילדים`,
     `זיכוי מאוצה"ח`, `"ביטוח לאומי ג` / `בטוח לאומי חד` (note the spelling without yod),
     incoming transfers (`העברה/הפקדה`, `העברה-נייד`, `העברת כסףbit`, `הפועלים-ביט` — all
     credits in these dumps). The workbook has a manual-fill **income block** per month sheet
     (`build_report_xlsx.py:211-235`, `INCOME_LABELS = ["משכורת 1", "הכנסות נוספות", "משכורת 2"]`)
     and an income comparison + `מצבנו` block on `ניתוח תוצאות` — all empty, waiting for data.
   - **Refund credits** — `שירותי בריאות` appears 12× in Hapoalim, **all credits** (health-fund
     reimbursements), plus one `מקס איט` credit and one `פריסה לתשלומים` credit in Leumi. These
     are credits that belong in an **expense** leaf as negatives — exactly how card refunds work
     today — not income.
   - **Bank-side expenses** — debits: mortgage (`לאומי למשכנתאו`), loans (`פרעון הלוואה`,
     `פריסה לתשלומים`), fees (`ע.מפעולות-ישיר`, `עמל.ערוץ יש`, `ריבית חובה`), cheques (`שיק`),
     outgoing transfers (`העב' לאחר-נייד`). Ordinary expenses no card statement carries; they
     categorize exactly like card rows (dictionary → RULES → judgment).
3. **Sign convention today:** card credits are negative, and `parse_discount_xlsx.py` flips bank
   rows to the same convention. Nothing downstream distinguishes an income credit from a refund
   credit: a salary categorized today would land in an expense leaf as a negative and shrink it.
4. **The taxonomy has no income section.** `src/config/reportTaxonomy.ts` has 10 expense
   sections; `verifyAgentResult` (`src/lib/reportResult.ts:230`) rejects any leaf outside the
   merged set; `mergeTaxonomy` only lets admin leaves join an existing base section.
5. **The result contract carries transactions, totals, xlsx, mappings** (`AgentResult`,
   `reportResult.ts:17-52`; stored by the result route into `ReportTransaction` + `ReportArtifact`,
   full replace per run inside one `$transaction`). There is no place for a row that must be
   *kept but not counted*, and no field saying which direction a row is.
6. **Bank sources carry no printed total.** `parse_discount_xlsx.py` reports
   `source_totals[label] = None` and verifies completeness via the running-balance chain; breaks
   are warnings. `verifyAgentResult` treats `statementTotalAgorot === null` as nothing to reconcile.
7. **Dedup is fatal on both sides.** `verify_report.py:26-27` and `reportResult.ts:289-293` make a
   duplicate `dedupKey` a problem; publish refuses fatal jobs (`publish/route.ts:91-101`).
8. **The admin transaction edit route** (`src/app/admin/api/reports/[jobId]/transactions/[txId]/
   route.ts:85-92`) accepts any leaf in `getValidLeafSet()` for any row and, with "remember",
   upserts `MerchantMapping` on the `@unique merchantPattern` — one direction per merchant.
9. **The client page `/report`** (`src/app/report/page.tsx`) renders month tables from
   `ReportTransaction` rows bucketed by leaf, plus `ללא סיווג`; `src/lib/reportAnalysis.ts`
   builds the online analysis for `/report` and the admin `ReportView`; `uncategorizedTotal`
   (`reportAnalysis.ts:237`) sums signed amounts. There is no client-side write API today.
10. **Card parsers and charge dates:** `parse_leumi_pdf.py` extracts a charge date per domestic
    block (`_block_charge_date`) and sums blocks into one `-domestic` total; its `-foreign` section
    has a total but no date. `parse_max_pdf.py` uses `CHARGE_SUMMARY_RE` only to **cut** the
    summary line — it does not extract the `dd.mm.yyyy` before `חיוב ב₪`. `parse_isracard_xlsx.py`
    parses no header date at all. `-outofcycle` / `-pending` sources carry `statementTotal = None`.
11. **Rule 4 (AGENTS.md):** a change to `/report` or the report workflow updates
    `docs/guides/CLIENT_GUIDE.he.md` / `ADMIN_GUIDE.he.md` in the same PR.

**Goal:** a job that mixes card statements and bank statements produces one report where bank
expenses are categorized like card expenses, bank **income** is categorized into an income
section and flows into the workbook's income block and `מצבנו`, refund credits stay refunds,
credit-card **settlements** are kept out of every expense total but preserved for reconciliation,
and the client can match settlements against the card charge cycles they paid on a new `/report`
card.

### Decisions (defaults — attacked in four review rounds)

1. **Income is a base taxonomy section `הכנסות`** with leaves `משכורת 1`, `משכורת 2`,
   `הכנסות נוספות`, `קצבת ילדים`, in that order. Admins extend it like any section (add-only).
   Which salary is "1" vs "2" is a judgment on the payer name; `reportRules` can pin it.
2. **Sign convention is unchanged: credits stay negative.** Consumers recognize income by the
   row's persisted **`kind`** (`"income"` ⇔ leaf ∈ `הכנסות`), never by sign alone: the workbook,
   `reportAnalysis`, and `/report` route `kind == income` rows to the income block / income rows
   and exclude them from every expense total. A refund credit in an expense leaf is
   `kind: "expense"` and behaves exactly as a card refund does today.
3. **Settlements are a separate result list, not transactions.** A bank *debit* whose payee is a
   card issuer is a settlement; `run_job` moves it to `settlements[]`; the app stores it in a new
   `ReportSettlement` table. They never enter `transactions`, so no expense total, verification
   sum, or month table can count them. (A `kind` flag on transactions was rejected for
   settlements — every summing consumer would need a filter; it is *adopted* for income, where
   the row must stay in the stream and the discriminator is unknowable from category alone for an
   uncategorized row.)
4. **A bank credit from an issuer is not a settlement** — it stays a transaction (a card refund
   landing in the account), direction `credit`, for judgment like any other credit.
5. **Matching is the client's explicit choice, many-to-one, with an auto-suggestion.** Targets are
   **charge cycles** (one per charge block of a card source, id `label@chargeDate`). Several
   settlements may be matched to one cycle (the data demands it — Leumi pays MAX in two debits).
   A cycle is pre-selected for a settlement when the settlement's month equals the cycle's charge
   month and either the settlement alone or the sum of same-month settlements to the same issuer
   is within ₪5 of the cycle amount; the client confirms or picks another. The card shows
   `cycle − Σ matched settlements`. Nothing is auto-matched silently.
6. **Bank PDFs verify by balance chain, like Discount.** No printed total ⇒
   `statementTotalAgorot: null`; a chain break is a warning. The Leumi **oldest row** (no older
   balance to difference against) takes its reference from a **sibling row with the same
   description** (the reference is a stable counterparty id — all 7 `פרפקטו` salary rows carry
   `74677`), the remainder of the glued text is the amount, and the sign follows the sibling
   majority; with no sibling the row is **dropped with a warning naming it** (statement-period
   start) rather than stored as a guess. Never a heuristic suffix split.

## Hard boundary

Per AGENTS.md rule 0, only Plusim files change. Skill files reach the onlyclaw workspace via the
`AGENT_SETUP.md` §7 re-install after merge. The "PDF scanning" / document-processing work the
owner mentioned is planned in **`cryptolir/openclaw-dashboard`** (PR #811) — a platform
capability of the agent runtime, outside this repo and rule 0's boundary. Nothing here depends on
it: both statements are text-layer PDFs; scanned statements stay unsupported by this skill until
that platform work lands and a later plan consumes it.

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| `parse_discount_xlsx.py` — sign flip, running-balance chain check, `source_totals[label] = None` | the completeness model for both PDF banks; chain check moves to a shared helper |
| `parse_isracard_xlsx.Txn` / `ParseResult` dataclasses | the bank parser's return shape — plus `direction`/`kind` |
| `parse_pdf_auto` + `detect_*` pattern, `UnknownStatementError` (`run_job.py`) | `detect_bank_pdf` slots in **first**; the refusal text loses its "xlsx only" clause |
| `categorize()` dictionary → `RULES` → judgment; `judgments.json` | bank rows use the same pass, keyed by `(merchant, kind)` |
| `_block_charge_date` (`parse_leumi_pdf.py`), `CHARGE_SUMMARY_RE` (`parse_max_pdf.py`) | the charge dates the cycles need (MAX needs one new capture group) |
| `build_report_xlsx.py` income block + geometry map | income rows fill cells that already exist; the block's row list follows the taxonomy |
| `reportAnalysis.buildAnalysis` + `DISTRIBUTION_EXCLUDED_LEAVES` | same shape for an `income` block |
| `verifyAgentResult` null-total path; `undatedInstallment` optional-field precedent | bank sources reconcile as Discount does; new optional fields verify identically when absent |
| `/api/reports/[jobId]/download` auth; the admin edit route's write-side `where: { job: {status…} }` | the auth recipe and the one-predicate write shape for the new client route |
| `test_detect_statement.py`, `test_parse_max_pdf.py` fixtures (fake `PdfReader`) | synthetic-text tests for the bank parser and routing; the two real dumps stay out of git |

## Plan

### Phase A — agent skill (`agent/skills/plusim-reports/`)

- **A1. `scripts/parse_bank_pdf.py`** — one module, two layouts, `parse_bank_pdf(path, label)`
  and `detect_bank_pdf(path)`:
  - Detection: text contains `תנועות בחשבון` **and** (`bankhapoalim.co.il` **or** `בנק לאומי`)
    **and** at least one line matching that bank's row regex. Keyed on the parser's own markers
    (the `detect_max_pdf` rule).
  - Hapoalim row: `^(\d{2}/\d{2}/\d{4})(.+?)([\d,]+\.\d{2})₪(-?[\d,]+\.\d{2})##([12])$`.
    `##1` ⇒ credit ⇒ **negative** agorot; `##2` ⇒ debit ⇒ positive. Balance = group 4. The
    `*…bankhapoalim.co.il` header line, the `dd/mm/yyyy-dd/mm/yyyy` period line, and the lone
    `7` match no row regex and are ignored; a real row that fails the regex breaks the chain and
    warns.
  - Leumi row (after stripping U+200B): `^(\d{2}/\d{2}/\d{4})(\d{2}/\d{2}/\d{4})(.+?)(\d+)
    ([\d,]+\.\d{2})(-?[\d,]+\.\d{2})\s*$` is used only to locate the row and the balance.
    Because reference and amount are glued, for every row with an older neighbour
    `delta = balance_this − balance_older` (newer rows first) is the truth, in **bank sign**
    (credit raises the balance), so `amount_agorot = −delta` (a debit ₪1,000 → ₪900 stores
    `+10000`; a salary stores a negative). The glued text must end with `abs(amount)` formatted —
    a mismatch is a warning naming the row (sign-blind by construction; the sign has its own
    tests). The **reference** is the glued text minus that suffix and is kept in `note` only.
  - Leumi **oldest row** (Decision 6): find rows with the same description; if any, strip their
    reference string from the glued text — the remainder is the amount — and take the sign from
    the sibling majority; otherwise drop the row and add the warning
    `"<desc> <date>: oldest row — no older balance and no sibling reference; excluded"`.
  - Both: date = `תאריך` (the first date; Leumi's second is the value date, never used),
    `source_label = hapoalim-<last 4 of account>` / `leumi-<last 4>`, dedup key =
    `label|date|description|amount|seq` for **both** banks (Leumi's reference is not a voucher —
    Context 1), `source_totals[label] = None`, chain check as in Discount with the same warning.
  - **Direction and classification** (shared `bank_rows.py`: `classify_bank_row`,
    `check_balance_chain`, also adopted by `parse_discount_xlsx.py` so all three banks agree):
    `Txn.direction: "debit" | "credit"`; a **debit** whose description matches
    `SETTLEMENT_PAYEES` ⇒ `kind = "settlement"`; a **credit** ⇒ `kind = "credit"` (undecided:
    income or refund — the model decides, A2); else `kind = "expense"`. Card parsers set nothing
    (default `expense`). `SETTLEMENT_PAYEES` is matched on **whole tokens** of the normalized
    description split on whitespace / `-` / `.` / `,` / `'` / `"` — never a substring — and lists
    only strings observed on real statements: `ישראכרט`, `כרטיסי אשראי`, `מקס איט`,
    `לאומי מאסטרקרד`, `לאומי ויזה`, `דיינרס`, `אמריקן אקספרס`. (`כאל` is **not** listed until its
    real descriptor is observed — a bare `כאל` matches `מיכאל`, which would silently remove a
    transfer to a person from every total, an under-count no verification can see.)
- **A2. `run_job.py` — dispatch and categorization.**
  - `parse_pdf_auto` tries **`detect_bank_pdf` first**, then Leumi card, then MAX, then refuses;
    the refusal message drops *"supported as xlsx only"*. Both card detectors are tightened so a
    bank statement can never pass them: `detect_leumi_pdf` additionally requires a card-statement
    marker (`פירוט החיובים` or the `בארץ`/`בחו"ל` section header); `detect_max_pdf`'s Diners
    branch rejects text containing `תנועות בחשבון` or `יתרה בש"ח`.
  - Rows with `kind == "settlement"` are **not** appended to `all_txns`; they go to
    `state["settlements"]` (`{date, month, payee, amountAgorot, sourceLabel, dedupKey}`) and are
    counted in the prepare summary (`settlements: n`).
  - **Kind-aware categorization.** Expense rows (`kind == "expense"`, incl. all card rows) run
    the existing dictionary → `RULES` pass but never take an `הכנסות` leaf. Credit rows
    (`kind == "credit"`) run `INCOME_RULES` only (`קצבת ילדים → קצבת ילדים`, `ביטוח לאומי` and
    `בטוח לאומי → הכנסות נוספות`, `זיכוי מאוצה"ח → הכנסות נוספות`, `מס-הכנסה החז → הכנסות
    נוספות`); a hit sets `kind = "income"`. The **shortlist and `judgments.json` are keyed by
    `(merchant, kind)`** — `"<merchant>"` for expense rows, `"<merchant>␟credit"` (U+241F, never
    produced by `normalize_merchant`) for credit rows — each entry carries `kind`, and the model
    writes one decision per key. A credit decision is either `{"category": "<הכנסות leaf>"}`
    (⇒ `kind = "income"`) or `{"category": "<expense leaf>", "refund": true}` (⇒ `kind =
    "expense"`, a negative in that leaf — the `שירותי בריאות` reimbursements); any other shape is
    rejected and the row left uncategorized with a reason. New expense `RULES`: `לאומי למשכנתאו →
    שכ"ד/משכנתא`, `פרעון הלוואה → הלוואות`, `פריסה לתשלומים → הלוואות`, `ע.מפעולות →
    עמלות+ריביות`, `עמל.ערוץ → עמלות+ריביות`, `ריבית חובה → עמלות+ריביות`, `שיק → צ'קים ללא
    מעקב`, `העב' לאחר → העברות בנקאיות` (`שירותי בריאות → בריאות משלים` exists and now applies to
    the debit direction only). Salary payers are judgment (Decision 1).
  - **Dictionary is one-direction per merchant** (`MerchantMapping.merchantPattern` is unique).
    Credit rows therefore never produce `proposedMappings`; income payers are pinned through
    `INCOME_RULES` or `reportRules`.
  - Uncategorized credit rows are sent with `kind: "credit"` so the app can tell them from
    uncategorized debits (B2/C1).
- **A3. `cmd_finalize`.** Judgments are applied by `(merchant, kind)`. Payload: each transaction
  carries `kind` (`"expense"` omitted, `"income"` / `"credit"` explicit); `settlements:
  state["settlements"]`; per card source `sourceTotals[].chargeCycles` (B2). `verify()` gains:
  settlement `dedupKey` never collides with a transaction `dedupKey`; no expense row from a bank
  source matches `SETTLEMENT_PAYEES` on whole tokens (a leaked settlement is a problem); a
  categorized row has `kind == "income"` ⇔ its leaf ∈ `הכנסות`; an `הכנסות` leaf holds only
  negative amounts from a bank source.
- **A4. `build_report_xlsx.py`.** `INCOME_LABELS` is replaced by the `הכנסות` leaves of the
  manifest taxonomy, in taxonomy order (an admin-added income leaf gets a row); rows with
  `kind == "income"` are **not** written as expense rows — per month their `abs(amount)` values
  are spread across the income block cells of their leaf. The existing SUM formulas, the
  month-sheet `זכות/חובה`, the `ניתוח תוצאות` income comparison and `מצבנו` (which expect
  **positive** income cells — verified) then populate with no formula change. The `הכנסות`
  section is skipped in the expense skeleton, `Main`, `ניתוח תוצאות` expense rows,
  `התפלגות ההוצאות`, and `_analysis_sheet` iterates the same income leaf list. The
  `un_categorized` sheet lists uncategorized debits and uncategorized credits in two groups with
  separate sums. **A card-only job's workbook changes layout** (the income block is now 4 rows in
  taxonomy order instead of 3) but not a single total — stated, tested as totals.
- **A5. Docs in the skill.** `SKILL.md` description + step 2 (shortlist entries carry `kind`;
  credit entries take an income leaf or an expense leaf with `"refund": true`; settlements are
  never judged). `reference/categorization-rules.md` gains the *Credits* rule (income leaves for
  salary/allowance/treasury/transfers-in; `"refund": true` into the matching expense leaf for a
  reimbursement of a known expense — `שירותי בריאות`, an issuer credit, a loan over-payment
  return; never guess between the two → uncategorized with a reason) and the *Settlements*
  invariant. `reference/layout-spec.md` gains the income-block population rule and the
  two-group `un_categorized` sheet.

### Phase B — contract, schema, verification (trust boundary)

- **B1. Taxonomy**: `REPORT_TAXONOMY` gains `{ section: "הכנסות", leaves: ["משכורת 1", "משכורת
  2", "הכנסות נוספות", "קצבת ילדים"] }` as the **last** section. `INCOME_SECTION` exported;
  pure `isIncomeLeaf(leaf, taxonomy)` and `leafAllowedForKind(kind, leaf, taxonomy)` in
  `reportTaxonomy.ts`. `taxonomyInvariants.test.ts`: income leaves disjoint from expense leaves
  and from `DISTRIBUTION_EXCLUDED_LEAVES`; its literal-signature assertion on
  `verifyAgentResult(result, validLeaves)` is updated to the new call (B2).
- **B2. Result contract** (`reportResult.ts`).
  - `AgentTxn.kind?: "income" | "credit"` — strict string match like `undatedInstallment`; absent
    ⇒ expense. A skill predating this sends none and verifies exactly as before.
  - `AgentResult.settlements?: AgentSettlement[]` (`{date, month, payee, amountAgorot, sourceLabel,
    dedupKey}`), optional, ≤ 2 000, each field guarded like a transaction's; `amountAgorot > 0`;
    `date.startsWith(month)`; `sourceLabel` must be a `sourceTotals` label whose
    `statementTotalAgorot === null` (a bank source — a card-labelled settlement is a parser bug).
  - `AgentSourceTotal.chargeCycles?: { chargeDate: "YYYY-MM-DD"; amountAgorot: number }[]`
    (optional, ≤ 24): one per charge block of a card source. Allowed only when
    `statementTotalAgorot !== null`; `Σ amountAgorot === statementTotalAgorot`; `chargeDate`
    unique within the source. Carried verbatim onto `perSource[].chargeCycles`; a **cycle id** is
    `"<label>@<chargeDate>"`.
  - `verifyAgentResult(result, validLeaves, taxonomy)` — the merged taxonomy becomes a required
    argument (the invariants test is updated). New fatal problems: settlement `dedupKey`
    duplicate or colliding with a transaction; categorized row with `kind === "income"` and leaf
    ∉ `הכנסות`, or leaf ∈ `הכנסות` without `kind === "income"`; an `הכנסות` row with
    `amountAgorot >= 0` or from a source whose `statementTotalAgorot !== null`. New **note**:
    settlements present but no card source has `chargeCycles` — *"N חיובי כרטיס אשראי בסך ₪X
    נמצאו בחשבון הבנק ללא דף חשבון אשראי תואם בעבודה — אינם נספרים כהוצאה"* (the bank-only job
    must never lose its card spend silently). `monthTotalsAgorot` excludes `kind === "income"`
    rows (it is the expense total).
- **B3. Schema** — one migration `report_settlement_income`:
  ```
  model ReportTransaction { … kind String @default("expense") … }   // "expense" | "income" | "credit"
  model ReportSettlement {
    id            String   @id @default(cuid())
    jobId         String
    month         String
    date          String
    payee         String
    amountAgorot  Int      // positive
    sourceLabel   String   // the bank source
    dedupKey      String
    matchedCycle  String?  // "<card sourceLabel>@<YYYY-MM-DD>" — the charge cycle it paid
    job           ReportJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
    @@index([jobId, month])
  }
  ```
  The result route's `deleteMany` + `createMany` inside the existing `$transaction` covers
  `reportSettlement` too — a re-run replaces settlements with transactions, atomically. **Matches
  do not survive a re-run** (the rows are new); the card re-suggests. Stated as a limitation.
- **B4. Client write route** `PATCH /api/reports/[jobId]/settlements/[id]`, body
  `{ matchedCycle: string | null }`. One read for the allow-list — `reportJob.findFirst({ where:
  { id: jobId, targetUserId: userId, status: "published" }, select: { verification: true } })`,
  404 when absent — then **one** conditional write bound on every identity at once:
  `reportSettlement.updateMany({ where: { id, jobId, job: { targetUserId: userId, status:
  "published" } }, data })`, `count === 0 ⇒ 404` (the admin edit route's write-side `where: { job:
  {…} }` shape). `matchedCycle` must be one of `allowedMatchTargets(verification)` (pure, in
  `reportAnalysis.ts`: the cycle ids over `perSource[].chargeCycles`; `[]` for a null/old-shape
  verification ⇒ fail closed) or null, else 400 (Hebrew). Never 403.
- **B5. Admin transaction edit route** enforces the income invariant on writes:
  `leafAllowedForKind` — an `הכנסות` leaf requires `amountAgorot < 0` and a bank source and sets
  `kind = "income"`; any other leaf sets `kind = "expense"` (a refund) ; violations 400 (Hebrew).
  The category picker filters by the same helper; "remember" is disabled for rows whose
  `kind !== "expense"` (one-direction dictionary).
- **B6. Manifest**: unchanged in shape. `constraints.amounts` gains *"bank credits carry
  `kind`: income (negative, הכנסות leaf) or refund (negative, expense leaf); card-settlement
  debits are reported in `settlements`, never as transactions"*.

### Phase C — client report page and analysis

- **C1. `reportAnalysis.ts`.** `buildAnalysis` gains `income: { leaves: LeafRow[]; byMonth; total;
  avg }` from `kind === "income"` rows (sign flipped for display) and **removes them from
  `sections`/`monthTotals`/`grandTotal`/`distribution`**; `netByMonth = income.byMonth −
  monthTotals`, `netAvg` (`מצבנו`). `uncategorized` is split into debits (`uncategorizedTotal`,
  positive) and credits (`uncategorizedCreditsTotal`) so a −₪19k uncategorized salary no longer
  nets against uncategorized expenses (`ReportView.tsx:418` and the `/report` list show both).
  New pure `allowedMatchTargets(verification)` and `suggestMatches(settlements, perSource)`
  implementing Decision 5: for each settlement, a cycle whose `chargeDate.slice(0,7) ===
  settlement.month` and either `|settlement − cycle| ≤ 500` or `|Σ same-month settlements with
  the same issuer token − cycle| ≤ 500`; a source without `chargeCycles` is never suggested; two
  blocks in one month are two distinct targets.
- **C2. `/report` page.** An **income table** per month above the expense table when the job has
  income rows (`הכנסות` header, leaf rows, `סה"כ הכנסות`); a **`מצבנו`** row under the expense
  total (הכנסות · הוצאות · יתרה). A new card **`התאמת חיובי אשראי לחשבון הבנק`** per job that has
  settlements: the B2 note verbatim when no cycles exist; otherwise one row per settlement (תאריך ·
  בנק · משלם · סכום), a select of the job's charge cycles (`<label> · <תאריך חיוב> · ₪amount`),
  the suggestion pre-selected, and a per-cycle footer `charged ₪X · settled ₪Σ · Δ`. The select
  posts to B4; the card is a small client component (`SettlementMatchCard`) fed plain data by the
  server page. The admin `ReportView` gets the same income table and `מצבנו` row (one component,
  both surfaces).
- **C3. Guides** (rule 4): `CLIENT_GUIDE.he.md` — new subsection under *עמוד הדוח*: income rows,
  `מצבנו`, the two uncategorized groups, the matching card with its real labels; bump the date.
  `ADMIN_GUIDE.he.md` — *קבצים נתמכים* gains bank PDFs (Hapoalim, Leumi) and what happens to
  settlements/income/refunds; *שלב ג׳* notes the new checks and the credit decision in review;
  bump the date. `docs/REPORTS_PIPELINE.md` — flow + key properties (settlements, income,
  refunds, balance-chain completeness, detection order); the *"Income is manual-fill"* sentence
  is replaced.

### Phase D — ops (post-merge)

- Ship the **app first** (taxonomy + contract accept the new fields; an old skill sends none and
  verifies as before), then re-install the changed skill files into the onlyclaw workspace
  (`AGENT_SETUP.md` §7: `parse_bank_pdf.py`, `bank_rows.py`, `parse_discount_xlsx.py`,
  `parse_leumi_pdf.py`, `parse_max_pdf.py`, `run_job.py`, `build_report_xlsx.py`,
  `verify_report.py`, `SKILL.md`, both reference docs, the tests). No vendor rebuild. Then one
  real job with a MAX statement + the Hapoalim PDF → `completed` with the balance-chain and
  no-cycle notes only → `/report` shows income, `מצבנו`, and the card → match → reload persists.
  Then the verified-baseline re-run (card-only jobs: every total unchanged).

## Non-goals

- OCR / scanned PDFs — platform work in `openclaw-dashboard#811`; both inputs have a text layer.
- Silent auto-matching (Decision 5: suggest, client confirms).
- Reconciling settlements against card statements **inside verification** — the two can
  legitimately disagree (cycle cut, partial payments, immediate debits); the card shows Δ.
- Other banks (Mizrahi, Discount PDF, OneZero) — same module, later layouts.
- Carrying matches across a re-run (B3 limitation).
- Admin-side matching UI (the admin sees the B2 note and settlement count in the verification
  panel).
- A workbook sheet for settlements — the `/report` card and the table are the reconciliation
  surface; a static list in the client's Google Sheet served no stated goal (Rev 4 cut).

## Ponytail cuts

- **yagni:** `kind` on `ReportTransaction` for *settlements* — they leave the stream entirely.
  (Rev 4 adopts `kind` for income/credit rows only, where the Rev 1 cut was wrong: an
  uncategorized credit is indistinguishable from an uncategorized refund by category or sign.)
- **yagni:** `matchedAt`, per-settlement notes, bulk-match, un-match history — `matchedCycle`
  is the whole feature.
- **yagni:** `incomeTotalsAgorot` in `verification` — nothing renders `monthTotalsAgorot` today;
  `reportAnalysis` recomputes from rows. Only the "`monthTotalsAgorot` excludes income" rule stays.
- **yagni:** a statement-period / opening-balance model for the Leumi oldest row — sibling
  reference or drop-with-warning (Decision 6).
- **yagni:** the `סילוקי אשראי` workbook sheet (see Non-goals).
- **Kept deliberately:** the shared `bank_rows.py` helper — three bank parsers must agree on what
  a settlement is; and the tightened card detectors — without them the bank detector's position
  is the only thing standing between a bank PDF and 147 balance-sized "charges".

## Risks / contingencies

- **Settlement leak (under-count) is invisible to verification.** A false-positive payee token
  removes a real expense from every total with no counter-check possible. Mitigation: whole-token
  matching, observed strings only, `test_transfer_to_michael_is_not_a_settlement`; the `/report`
  card lists every settlement so a wrong one is at least visible.
- **Settlement leak (over-count).** A payee string outside the list stays an expense. Mitigation:
  A3/B2 token check on bank debits; the card's Δ.
- **Bank-only job.** All issuer debits become settlements with nothing to match. Mitigation: the
  B2 note with the unmatched sum, rendered on the card and in the admin panel.
- **Income invariant.** Held at three points — skill `verify()`, `verifyAgentResult` (fatal), the
  admin edit route (400) — all from the persisted `kind`, never from sign alone.
- **Leumi glued reference/amount.** Delta is authoritative for 133/133 non-oldest rows on the real
  file; the oldest row is sibling-derived or dropped with a warning, never guessed.
- **Cycle dates need parser work** (Context 10): MAX gains a capture of the `dd.mm.yyyy` before
  `חיוב ב₪`; Leumi card emits one cycle per domestic block from `_block_charge_date` and **adds
  the `-foreign` total to the last block's cycle amount** (the bank pays both in one debit); Isracard
  xlsx has no header date ⇒ no cycles ⇒ manual pick, documented in the client guide. A source
  with no cycles never blocks anything.
- **Detection order regression.** `test_card_detectors_reject_bank_statements` runs the real
  dumps' *shape* (synthetic fixtures with the same markers) through both card detectors.
- **Taxonomy growth is a manifest change** (add-only). Old skill + new app: fine. New skill + old
  app: unknown leaves ⇒ `needs_review`, never silent — ship app first (Phase D).
- **Client write surface is new.** One bound predicate, Hebrew errors, tests below.

## Verification

Skill (`python3 -m unittest`, synthetic text with the real statements' markers, no PII):

- `test_detect_bank_pdf_hapoalim` / `test_detect_bank_pdf_leumi` /
  `test_bank_detection_rejects_card_statements` / `test_card_detectors_reject_bank_statements`
  (a Hapoalim-shaped page containing `ישראכרט` and `₪` lines fails both `detect_leumi_pdf` and
  `detect_max_pdf`) / `test_pdf_dispatch_tries_bank_first`.
- `test_hapoalim_sign_from_marker`, `test_hapoalim_header_and_period_lines_are_ignored`.
- `test_leumi_amount_from_balance_delta_beats_glued_text`, `test_leumi_debit_is_positive`,
  `test_leumi_credit_is_negative`, `test_leumi_recurring_reference_does_not_collide` (seven rows
  sharing reference `74677` keep distinct dedup keys),
  `test_leumi_oldest_row_amount_from_sibling_reference`,
  `test_leumi_oldest_row_without_sibling_is_dropped_with_warning`.
- `test_balance_chain_break_is_a_warning_not_a_drop`.
- `test_settlement_rows_leave_transactions` (issuer debits → `settlements`; an issuer **credit**
  stays a transaction with `kind == "credit"`), `test_settlement_payee_matches_whole_token_only`,
  `test_transfer_to_michael_is_not_a_settlement`.
- `test_credit_rows_run_income_rules_only`, `test_expense_rules_never_place_a_credit` (the 12
  `שירותי בריאות` credits are not auto-filed as the expense leaf), `test_batuach_leumi_spelling_
  variant_is_income`.
- `test_bidirectional_unresolved_counterparty_gets_two_judgments` (`X` and `X␟credit`),
  `test_credit_judgment_requires_income_leaf_or_refund_flag` (an expense leaf without
  `"refund": true` is rejected with a reason), `test_refund_credit_is_kind_expense`.
- `test_credit_rows_propose_no_mappings`.
- `test_card_parsers_report_charge_cycles` — MAX (date captured before `חיוב ב₪`) one cycle equal
  to the total; a two-block Leumi card statement two cycles summing to `-domestic` + `-foreign`;
  Isracard xlsx none; bank parsers none.
- `test_verify_income_kind_section_mismatch_is_flagged`, `test_verify_flags_settlement_dedup_
  collision`, `test_verify_flags_leaked_settlement_token`.
- `test_workbook_income_block_follows_taxonomy_leaves`, `test_income_rows_never_render_as_expense_
  rows`, `test_uncategorized_sheet_splits_debits_and_credits`, `test_card_only_job_totals_
  unchanged`.
- `test_skill_doc` keeps passing.

App (`pnpm test`):

- `reportResult.test.ts`: `kind` absent ⇒ identical outcome; income kind/section mismatch fatal
  both ways; `הכנסות` row with non-negative amount or card source fatal; settlements optional;
  settlement date outside month / card-labelled source / duplicate / colliding dedupKey fatal;
  `chargeCycles` on a null-total source, not summing to the total, or with a repeated
  `chargeDate` fatal; settlements with no cycles ⇒ the note, not a problem;
  `monthTotalsAgorot` excludes income.
- `taxonomyInvariants.test.ts`: income section last, disjoint from expenses and
  `DISTRIBUTION_EXCLUDED_LEAVES`; the signature assertion updated to the three-argument call.
- `reportAnalysis.test.ts`: income rows leave `sections`/`grandTotal`; `netByMonth`;
  uncategorized debits and credits summed separately; `suggestMatches` — same month and ≤ ₪5
  on one settlement **or** on the same-issuer same-month sum (two MAX debits → one cycle); two
  blocks in one month are two targets; equal cycles in different months each take their own
  month; no cycles ⇒ no suggestion; `allowedMatchTargets` returns cycle ids, `[]` on null.
- `settlementsRoute.test.ts`: 404 not-owner, 404 unpublished, 404 settlement of another job (owned
  or not), 400 cycle id not in the job, 200 sets and clears `matchedCycle`, and the write is a
  single `updateMany` with the full predicate.
- `editTransaction.test.ts`: `הכנסות` leaf on a positive or card-source row ⇒ 400; expense leaf on
  a `kind == "credit"` row ⇒ 200 with `kind = "expense"`; remember disabled for non-expense rows.
- `reportPage.test.ts`: card only when settlements exist; income table only when income rows
  exist; the no-cycles note.
- `hebrewErrors.test.ts` still passes.

Manual, dev server: upload a MAX statement + the Hapoalim PDF → run → `completed` with the
balance-chain note only → `/report` shows income, `מצבנו`, both uncategorized groups, and the
card with a ✓ suggestion for the MAX settlement → match → reload → persisted. Upload the Hapoalim
PDF alone → the no-cycles note names the settled sum. Then Phase D.
