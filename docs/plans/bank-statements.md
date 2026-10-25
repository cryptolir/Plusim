# Plusim — Bank current-account statements: income, credit-card settlements, and the reconciliation card

> **Status:** Draft — **Rev 2**, Codex round-1 findings folded in; awaiting re-review. Nothing
> implemented yet.
>
> **Process** (self-contained): plan PR → adversarial Codex review → each round becomes a new
> Rev on this branch with resolution notes → every caught hole becomes a named test the
> implementation PR must carry → once approved, implement exactly the plan.
>
> **Review log:**
> - Rev 1 — authored from two real bank PDFs (Bank Hapoalim 6-month export, Bank Leumi
>   current-account export, text layer, no OCR) and a file-anchored read of the pipeline.
>   Ponytail pass ran before handoff (see "Ponytail cuts").
> - Rev 2 — Codex review round 1 (PR #52): **P1** the Leumi balance delta is in *bank* sign
>   (credit positive) and must be negated into the pipeline convention — A1 now says so, with
>   separate debit/credit sign tests (the abs-value suffix cross-check cannot catch an
>   inversion). **P1** `categorize()` applied expense RULES to income rows, so a `ביטוח לאומי`
>   *payout* hit the expense leaf `ביטוח לאומי` before the model ever saw it — A2 now makes
>   dictionary/RULES eligibility kind-aware (income rows consult `INCOME_RULES` and income
>   leaves only; expense rows never land in `הכנסות`). **P1** the settlement PATCH could pass
>   ownership on one job and update a settlement of another — B4 now binds the update predicate
>   to `{id, jobId}` with a cross-job 404 test. **P2** `suggestMatches` had no billing month to
>   enforce Decision 5's same-month rule — B2/B5 add `billingMonth` on each card source total,
>   carried into `perSource`; no billing month ⇒ no suggestion (manual pick), with an
>   equal-amounts-different-months test.

## Context

1. **Bank current-account statements are supported as Bank Discount xlsx only.**
   `agent/skills/plusim-reports/scripts/parse_discount_xlsx.py` parses the עובר ושב sheet; every
   other bank PDF is refused by `parse_pdf_auto` (`run_job.py`, `UnknownStatementError`: *"Bank
   current-account statements are supported as xlsx only"*). The two statements the owner needs
   are PDFs:
   - **Bank Hapoalim** (`bankhapoalim.co.il` in every page header). Rows are one glued line:
     `dd/mm/yyyy<description><amount>₪<running balance>##N` where `##1` = credit (זכות) and
     `##2` = debit (חובה) — the sign is explicit. Newest first; page headers repeat
     `יתרה בש"חזכותחובהפעולהתאריך`; a lone `7` closes each page.
   - **Bank Leumi** (`תנועות בחשבון| בנק לאומי`, `מס' חשבון`). Rows:
     `dd/mm/yyyy dd/mm/yyyy<description><reference><amount><running balance>` with reference and
     amount **glued** (`המרת קנ במטח956246.32​-14,304.47` = ref 9562, amount 46.32, balance
     −14,304.47), zero-width spaces before negative balances, no debit/credit marker. The sign and
     the exact amount of every row except the oldest follow from the balance chain:
     `balance_newer − balance_older` = signed amount. The oldest row has no older balance.
2. **Bank rows are three different things**, and today's pipeline has a name for only one:
   - **Credit-card settlements** — the bank debit that pays a card statement
     (`ישראכרט בע"מ`, `ישראכרט-כ.ויזה`, `כרטיסי אשראי ל…`, `מקס איט פיננ-י`, `לאומי מאסטרקרד`,
     `לאומי ויזה`, `מסיטיבנק ס.-י`). 55 of the Hapoalim rows and 42 of the Leumi rows. Every
     one of them is already itemized on the card statement the same job carries — counting them
     as expenses double-counts the whole card.
   - **Income** — credits: salary (`מדיסון פארמה ב`, `פרפקטו מוביי-י`), `קצבת ילדים`,
     `זיכוי מאוצה"ח`, `ביטוח לאומי` payouts, incoming transfers (`העברה/הפקדה`, `העברה-נייד`,
     `העברת כסף bit`). The workbook already has a manual-fill **income block** per month sheet
     (`build_report_xlsx.py:211-235`, labels `משכורת 1` / `הכנסות נוספות` / `משכורת 2`) and an
     income comparison + `מצבנו` block on `ניתוח תוצאות` — all empty, waiting for data
     (`docs/REPORTS_PIPELINE.md`: *"Income is manual-fill (no bank-statement source)"*).
   - **Bank-side expenses** — mortgage (`לאומי למשכנתאו`), loans (`פרעון הלוואה`,
     `פריסה לתשלומים`), `ביטוח לאומי` payments, `שירותי בריאות`, fees (`ע.מפעולות-ישיר`,
     `עמל.ערוץ יש`, `ריבית חובה`), cheques (`שיק`), outgoing transfers (`העב' לאחר-נייד`,
     `הפועלים-ביט`). These are ordinary expenses that no card statement carries, and they
     categorize exactly like card rows (dictionary → RULES → judgment).
3. **Sign convention today:** card credits are negative, and `parse_discount_xlsx.py` flips bank
   rows to the same convention — *"income/credit rows become NEGATIVE … so they stay visible
   without inflating expense totals"*. But nothing downstream knows an income row from a
   refund: a salary categorized today would land in an expense leaf as a negative number and
   shrink that leaf's total.
4. **The taxonomy has no income section.** `src/config/reportTaxonomy.ts` has 10 expense
   sections; `verifyAgentResult` (`src/lib/reportResult.ts:230`) rejects any leaf outside the
   merged set, and `mergeTaxonomy` only lets admin leaves join an existing base section.
5. **The result contract carries transactions, totals, xlsx, mappings** (`AgentResult`,
   `reportResult.ts:17-52`; stored by `src/app/api/agent/jobs/[jobId]/result/route.ts` into
   `ReportTransaction` + `ReportArtifact`, full replace per run). There is no place for a row
   that must be *kept but not counted* — a settlement.
6. **Bank sources carry no printed total.** `parse_discount_xlsx.py` reports
   `source_totals[label] = None` and verifies completeness via the running-balance chain
   (`bal_new + amt_new == bal_old`, agora-exact), surfacing breaks as warnings. `verifyAgentResult`
   treats `statementTotalAgorot === null` as nothing-to-reconcile.
7. **The client page `/report`** (`src/app/report/page.tsx`) renders month tables from
   `ReportTransaction` rows bucketed by leaf, plus `ללא סיווג`; `src/lib/reportAnalysis.ts`
   builds the online analysis. Neither has an income or a reconciliation concept. There is no
   client-side write API at all today — the only client routes are the page and the xlsx
   download.
8. **Rule 4 (AGENTS.md):** a change to `/report` or the report workflow updates
   `docs/guides/CLIENT_GUIDE.he.md` / `ADMIN_GUIDE.he.md` in the same PR.

**Goal:** a job that mixes card statements and bank statements produces one report where bank
expenses are categorized like card expenses, bank **income** is categorized into an income
section and flows into the workbook's income block and `מצבנו`, credit-card **settlements** are
kept out of every expense total but preserved for reconciliation, and the client can match each
settlement against the card statement it paid on a new `/report` card.

### Decisions (proposed defaults — reviewers, attack these)

1. **Income is a base taxonomy section `הכנסות`** with exactly the workbook's three leaves —
   `משכורת 1`, `משכורת 2`, `הכנסות נוספות` — plus `קצבת ילדים`. Admins extend it like any
   section (ReportCategory, add-only). Which salary is "1" vs "2" is a judgment call on the payer
   name, same as any merchant; `reportRules` can pin it (`"מדיסון פארמה = משכורת 1"`).
2. **Sign convention is unchanged: credits stay negative.** Income rows are stored as negative
   agorot like every other credit. Consumers recognize income by **section**, not by sign: the
   workbook, `reportAnalysis`, and `/report` route rows whose leaf is in `הכנסות` to the income
   block / income rows and **exclude them from every expense total**. A refund in an expense leaf
   keeps behaving exactly as today.
3. **Settlements are a separate result list, not transactions.** The parser classifies a bank
   debit whose description matches the card-issuer list as a settlement; `run_job` moves it to
   `settlements[]` in the callback payload; the app stores it in a new `ReportSettlement` table.
   They never enter `transactions`, so no expense total, no verification sum, no month table can
   count them. (Alternative rejected: a `kind` flag on `ReportTransaction` — every consumer that
   sums transactions would need to learn to skip it, and one forgotten `filter` double-counts a
   whole card.)
4. **A bank credit that pays off a card is also a settlement** only when it is a debit; credits
   from an issuer (a card refund landing in the account) stay as transactions for judgment —
   they are rare and the model should see them.
5. **Matching is the client's explicit choice, with an auto-suggestion.** The `/report` card lists
   settlements per bank source and offers the job's card sources (the `perSource` labels with a
   statement total). It pre-selects a card source when `|settlement − statement total| ≤ ₪5`
   and the month matches the card's billing month; the client confirms or picks another. The
   choice is stored on the settlement row. Nothing is auto-matched silently.
6. **Bank PDFs verify by balance chain, like Discount.** No printed total ⇒
   `statementTotalAgorot: null`; a chain break is a parser warning (`agentNotes`) and the row set
   is still delivered. The Leumi oldest row — the one with no older balance — takes its amount
   from the glued text by the longest `[\d,]+\.\d{2}` suffix whose integer part is < 1000 unless a
   comma is present; it is flagged in warnings as *unverifiable* so a reviewer sees it.

## Hard boundary

Per AGENTS.md rule 0, only Plusim files change. Skill files reach the onlyclaw workspace via the
`AGENT_SETUP.md` §7 re-install after merge. Whatever "PDF scanning" was added to the agent
workspace in another session is **not in this repo** (no OCR dependency, module, or doc exists on
`main`); rule 1 says that divergence is a bug to commit, not to build on — it is out of scope here
and both statements in this plan are text-layer PDFs that need none of it.

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| `parse_discount_xlsx.py` — sign flip, voucher dedup, running-balance chain check, `source_totals[label] = None` | the exact completeness model for both PDF banks; the chain check moves into a shared helper |
| `parse_isracard_xlsx.Txn` / `ParseResult` dataclasses | the bank parser's return shape — plus one new field |
| `parse_pdf_auto` + `detect_*` pattern, `UnknownStatementError` (`run_job.py`) | `detect_bank_pdf` slots in before the refusal; the refusal text loses its "xlsx only" clause |
| `categorize()` dictionary → `RULES` → judgment | bank expenses and income use the same pass; only `RULES` grows |
| `build_report_xlsx.py` income block + geometry map (`income_rows`, `income_total_row`) | income rows fill cells that already exist; no layout change |
| `reportAnalysis.buildAnalysis` + `DISTRIBUTION_EXCLUDED_LEAVES` | same shape for an `income` block; distribution already knows how to exclude leaves |
| `verifyAgentResult` null-total path | bank sources reconcile as they do for Discount today |
| `/api/reports/[jobId]/download` (Clerk + ownership + `status=published`) | the auth recipe for the one new client write route |
| `test_detect_statement.py`, `test_parse_max_pdf.py` fixtures (fake `PdfReader`) | synthetic-text tests for the bank parser and routing |

## Plan

### Phase A — agent skill (`agent/skills/plusim-reports/`)

- **A1. `scripts/parse_bank_pdf.py`** — one module, two layouts, one `parse_bank_pdf(path, label)`
  and one `detect_bank_pdf(path)`:
  - Detection: text contains `תנועות בחשבון` **and** (`bankhapoalim.co.il` **or**
    `בנק לאומי`) **and** at least one row matching that bank's row regex. Keyed on the same markers
    the parser branches on (the `detect_max_pdf` rule), so detection never admits a file the
    parser then yields nothing from.
  - Hapoalim row: `^(\d{2}/\d{2}/\d{4})(.+?)([\d,]+\.\d{2})₪(-?[\d,]+\.\d{2})##([12])$`.
    `##1` ⇒ credit ⇒ **negative** agorot; `##2` ⇒ debit ⇒ positive. Balance = group 4.
  - Leumi row: `^(\d{2}/\d{2}/\d{4})(\d{2}/\d{2}/\d{4})(.+?)(\d+?)([\d,]+\.\d{2})​?(-?[\d,]+\.\d{2})\s*$`
    after stripping `​`. Because reference and amount are glued, the amount is **not** taken
    from the regex for any row that has an older neighbour: `delta = balance_this −
    balance_older` (newer rows come first) is in **bank sign** — a credit raises the balance,
    so `delta > 0` is a credit. The pipeline convention is the opposite (expense positive,
    credit negative), so `amount_agorot = −delta`: a debit ₪1,000 → ₪900 gives `delta = −100`,
    stored as `+10000` agorot; a salary credit gives a negative amount. The glued text must then
    end with `abs(amount)` formatted — a mismatch is a warning naming the row (this cross-check
    is sign-blind by construction, which is why the sign has its own tests). The oldest row uses
    the text suffix (Decision 6) for its magnitude, takes its sign from whether the glued text
    sits in the `בחובה` or `בזכות` position — unknowable after extraction — so it is stored with
    the Hapoalim-style rule *credit if the description matches a known income payer, else
    debit*, and is flagged `unverifiable` in warnings either way.
  - Both: date = `תאריך` (the first date; Leumi's second is the value date — never used, mirrors
    Discount), `source_label = hapoalim-<last 4 of account>` / `leumi-<last 4>`, dedup key =
    `label|date|description|amount|seq` (Leumi: `label|reference` when the reference is non-empty,
    like Discount's voucher), `source_totals[label] = None`, chain check as in Discount with the
    same warning text.
  - **Classification** (new `Txn.kind`: `"expense" | "income" | "settlement"`, default
    `"expense"` so card parsers need no change): debit whose description contains any of
    `SETTLEMENT_PAYEES` (`ישראכרט`, `כרטיסי אשראי`, `מקס איט`, `לאומי מאסטרקרד`, `לאומי ויזה`,
    `מסיטיבנק`, `דיינרס`, `אמריקן אקספרס`, `כאל`) ⇒ `settlement`; any credit ⇒ `income`; else
    `expense`. `parse_discount_xlsx.py` gets the same classifier (shared `bank_rows.py` helper:
    `classify_bank_row`, `check_balance_chain`) so all three banks behave identically.
- **A2. `run_job.py`**: `parse_pdf_auto` tries `detect_bank_pdf` after Leumi/MAX and before the
  refusal; the refusal message drops *"supported as xlsx only"*. In `cmd_prepare`, rows with
  `kind == "settlement"` are **not** appended to `all_txns`; they go to `state["settlements"]`
  (`{date, month, payee, amountAgorot, sourceLabel, dedupKey}`) and are counted in the prepare
  summary (`settlements: n`). Income rows go through `categorize()` with **kind-aware eligibility**
  (Codex round-1 P1): a `kind == "income"` row consults only dictionary entries and rules whose
  leaf is in the `הכנסות` section (a new `INCOME_RULES` table), and a `kind == "expense"` row
  never takes an `הכנסות` leaf from the dictionary — so a counterparty that both pays and is
  paid (`ביטוח לאומי`: a payout credit and a premium debit, same string) routes by direction,
  not by string. Shortlist entries carry `"kind": "income"` so the model knows it is placing a
  payer, and the judgment step is told (A5) that an income row may only receive an `הכנסות`
  leaf. New expense `RULES` (deterministic): `לאומי למשכנתאו → שכ"ד/משכנתא`, `פרעון הלוואה →
  הלוואות`, `פריסה לתשלומים → הלוואות`, `ביטוח לאומי → ביטוח לאומי`, `ע.מפעולות → עמלות+ריביות`,
  `עמל.ערוץ → עמלות+ריביות`, `ריבית חובה → עמלות+ריביות`, `שיק → צ'קים ללא מעקב`, `העב' לאחר →
  העברות בנקאיות`, `הפועלים-ביט → ביט` (`שירותי בריאות → בריאות משלים` exists). New
  `INCOME_RULES`: `קצבת ילדים → קצבת ילדים`, `ביטוח לאומי → הכנסות נוספות`, `זיכוי מאוצה"ח →
  הכנסות נוספות`, `החזר מס / מס-הכנסה החז → הכנסות נוספות`. Salary payers are judgment
  (Decision 1). The admin merchant dictionary stays one table; the kind filter is applied at
  lookup, and the admin UI's category picker for an income row offers `הכנסות` leaves only.
- **A3. `cmd_finalize`**: payload gains `settlements: state["settlements"]`. `verify()` gains one
  check: no settlement `dedupKey` collides with a transaction `dedupKey`, and no transaction's
  merchant matches `SETTLEMENT_PAYEES` while being a positive bank-source amount (a settlement
  that leaked into expenses is a problem, not a note).
- **A4. `build_report_xlsx.py`**: rows whose category is in the `הכנסות` section are **not**
  written as expense rows; per month their `abs(amount)` values are spread across the existing
  income block cells (`משכורת 1` / `משכורת 2` / `הכנסות נוספות` rows, `קצבת ילדים` under
  `הכנסות נוספות` unless the taxonomy row exists — the block's row set follows the `הכנסות`
  leaves in the manifest, so an admin-added income leaf gets a row). The existing SUM formulas
  and the `ניתוח תוצאות` income comparison then populate with no formula change. The `הכנסות`
  section is skipped in the expense skeleton, `Main`, `ניתוח תוצאות` expense rows, and
  `התפלגות ההוצאות`. A new last data sheet **`סילוקי אשראי`** lists settlements (תאריך · מקור בנק
  · משלם · סכום) with a per-source SUM — informational, never summed into any total.
- **A5. Docs in the skill**: `SKILL.md` description + step 2 (shortlist entries may be income
  payers; settlements are listed in the prepare summary and are never judged); `reference/
  categorization-rules.md` gains an *Income* rule (credits → `הכנסות` leaves; salary payer ⇒
  `משכורת 1`/`2` by `reportRules` or evidence, else `הכנסות נוספות`; never put a credit in an
  expense leaf unless it is a refund of a known expense) and a *Settlements* invariant;
  `reference/layout-spec.md` gains the income-block population rule and the `סילוקי אשראי`
  sheet.

### Phase B — contract, schema, verification (trust boundary)

- **B1. Taxonomy**: `REPORT_TAXONOMY` gains `{ section: "הכנסות", leaves: ["משכורת 1",
  "משכורת 2", "הכנסות נוספות", "קצבת ילדים"] }` as the **last** section. `INCOME_SECTION =
  "הכנסות"` exported; `isIncomeLeaf(leaf, taxonomy)` pure helper in `reportTaxonomy.ts`.
  `taxonomyInvariants.test.ts` gains: income leaves never collide with expense leaves;
  `DISTRIBUTION_EXCLUDED_LEAVES` ∩ income = ∅.
- **B2. Result contract** (`reportResult.ts`): `AgentResult.settlements?: AgentSettlement[]`
  (`{date, month, payee, amountAgorot (> 0), sourceLabel, dedupKey}`), **optional** — a skill
  predating this sends none and verifies exactly as before (the `undatedInstallment` precedent).
  `parseAgentResult` validates each field with the same `str`/`intAgorot`/regex guards, caps the
  list at 2 000, rejects `amountAgorot <= 0`. `AgentSourceTotal.billingMonth?: string`
  (`"YYYY-MM"`, optional, `MONTH_RE`-validated) — the card parsers already locate the charge
  date (MAX: the `חיוב ב dd.mm.yyyy` summary line; Leumi card: the block charge date; Isracard
  xlsx: the header date) and now report its month per source; bank sources send none. It is
  carried verbatim onto `perSource[].billingMonth` so the client can enforce Decision 5
  (Codex round-1 P2). `verifyAgentResult` adds: duplicate settlement
  `dedupKey` ⇒ fatal; a settlement `dedupKey` also present in `transactions` ⇒ fatal;
  `monthTotalsAgorot` and `uncategorizedCount` exclude nothing new (settlements are not in
  `transactions`), but a new `incomeTotalsAgorot` per month is computed from `הכנסות` rows and
  `monthTotalsAgorot` **excludes** them (it is the expense total the UI shows).
- **B3. Schema** — one migration `report_settlement`:
  ```
  model ReportSettlement {
    id            String   @id @default(cuid())
    jobId         String
    month         String
    date          String
    payee         String
    amountAgorot  Int      // positive
    sourceLabel   String   // the bank source
    dedupKey      String
    matchedSource String?  // card sourceLabel the client matched it to
    matchedAt     DateTime?
    job           ReportJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
    @@index([jobId, month])
  }
  ```
  The result route's transaction `deleteMany` + `createMany` covers `reportSettlement` too — a
  re-run replaces settlements like it replaces transactions. **Matches do not survive a re-run**
  (the rows are new); the card re-suggests. Stated as a limitation, not hidden.
- **B4. Client write route** `PATCH /api/reports/[jobId]/settlements/[id]` — body
  `{ matchedSource: string | null }`. Auth exactly as the download route: Clerk `userId`,
  `job.targetUserId === userId`, `job.status === "published"`; additionally `matchedSource` must
  be one of the job's **card** `perSource` labels (from `verification`) or null. The update is
  **one conditional `updateMany` whose predicate is `{ id: settlementId, jobId }`** — the
  authorized job, never the id alone — and `count === 0` ⇒ 404 (Codex round-1 P1: ownership of
  the job and validity of the label say nothing about which job the settlement row belongs to;
  the download route authorizes one resource, this route names two, so both must be bound).
  Thin handler; the allowed-label check is a pure function `allowedMatchTargets(verification)`
  in `reportAnalysis.ts` under test. 404 for any job the user does not own and for a
  settlement outside the job (never 403 — the download route's precedent).
- **B5. Manifest**: unchanged in shape. The taxonomy it serializes picks up `הכנסות` through
  `getMergedTaxonomy()`; `constraints.amounts` text gains *"bank credits are income, negative;
  card-settlement debits are reported in `settlements`, never as transactions"*.

### Phase C — client report page and analysis

- **C1. `reportAnalysis.ts`**: `buildAnalysis` gains `income: { leaves: LeafRow[]; byMonth;
  total; avg }` built from `הכנסות` rows (sign flipped for display), and **removes them from
  `sections`/`monthTotals`/`grandTotal`/`distribution`**. New `netByMonth = income.byMonth −
  monthTotals` and `netAvg` (the workbook's `מצבנו`). New pure
  `suggestMatches(settlements, perSource)` implementing Decision 5: a card source is suggested
  for a settlement only when it has a `billingMonth`, that month equals the settlement's
  `month`, and `|settlement − statementTotal| ≤ 500` agorot; a source without a billing month
  is never suggested (manual pick only), and two card sources with equal totals in different
  months each attract only their own month's settlement.
- **C2. `/report` page**: an **income table** per month above the expense table when the job has
  income rows (`הכנסות` header, leaf rows, `סה"כ הכנסות`), and a **`מצבנו`** row under the expense
  total: הכנסות · הוצאות · יתרה. A new card **`התאמת חיובי אשראי לחשבון הבנק`** per job that has
  settlements: one row per settlement (תאריך · בנק · משלם · סכום), a select of the job's card
  sources (label + statement total), the suggestion pre-selected, a ✓/Δ cell showing
  `settlement − card total`, and a per-card-source footer "`<label>`: statement ₪X, settled ₪Y,
  Δ". The select posts to B4; the page is a server component today, so the card is a small client
  component (`SettlementMatchCard`) receiving plain data.
- **C3. Guides** (rule 4): `CLIENT_GUIDE.he.md` — new subsection under *עמוד הדוח*: income rows,
  `מצבנו`, and the matching card with its real labels; bump the date. `ADMIN_GUIDE.he.md` — *קבצים
  נתמכים* gains bank PDFs (Hapoalim, Leumi) and what happens to settlements/income; *שלב ג׳* notes
  the new fatal checks; bump the date. `docs/REPORTS_PIPELINE.md` — flow + key properties
  (settlements, income, balance-chain completeness for PDFs); the *"Income is manual-fill"*
  sentence is replaced.

### Phase D — ops (post-merge)

- Re-install the changed skill files into the onlyclaw workspace (`AGENT_SETUP.md` §7:
  `parse_bank_pdf.py`, `bank_rows.py`, `parse_discount_xlsx.py`, `run_job.py`,
  `build_report_xlsx.py`, `verify_report.py`, `SKILL.md`, both reference docs, the tests). No
  vendor rebuild (no new dependency). Then one real job with a card statement + one of these
  bank PDFs → `completed` → the `/report` card shows settlements with suggestions → match one →
  reload persists. Then the verified-baseline re-run (card-only jobs must be byte-for-byte
  unchanged in totals).

## Non-goals

- OCR / scanned PDFs (nothing in git; both inputs have a text layer).
- Automatic, silent matching of settlements to cards (Decision 5: suggest, client confirms).
- Reconciling settlement amounts against the card statement **inside verification** — the two
  statements can legitimately disagree (billing-cycle cut, partial payments); the card shows Δ.
- Other banks (Mizrahi, Discount PDF, OneZero) — same module, later layouts.
- Carrying matches across a re-run (B3 limitation).
- Admin-side matching UI; the admin sees settlements in the verification panel count only.

## Ponytail cuts (Rev 1)

- **yagni:** a `kind` column on `ReportTransaction` — Decision 3 keeps settlements out of the
  transaction stream entirely; one table, zero `filter` traps.
- **yagni:** per-settlement notes/comments, bulk-match, un-match history — a `matchedSource`
  column is the whole feature.
- **yagni:** a "statement period / opening balance" model to verify the Leumi oldest row — flag
  it instead (Decision 6); the amount is almost always unambiguous.
- **yagni:** admin UI for settlements — the admin verification panel already shows notes; the
  reconciliation is the client's job.
- **shrink:** no new workbook formulas — income fills cells the workbook already has.
- **Kept deliberately:** the shared `bank_rows.py` helper (classifier + chain check). Three bank
  parsers must agree on what a settlement is, or one bank double-counts a card the others don't.

## Risks / contingencies

- **Settlement leak = silent double count.** A payee string outside `SETTLEMENT_PAYEES` makes a
  card payment an expense. Mitigation: A3/B2 fatal check on issuer-named positive bank rows, plus
  the `/report` footer Δ makes a missing settlement visible to the client.
- **Income mis-signed into an expense leaf** (a model judgment puts a salary under `העברות
  בנקאיות`): the row's negative amount shrinks that leaf. Mitigation: the deterministic pass is kind-aware
  (A2), shortlist entries carry `kind: "income"`, and `verify()` flags a `kind == income` row
  categorized outside `הכנסות` — or an expense row inside it — as a problem
  (`test_income_row_outside_income_section_is_flagged`).
- **Leumi glued reference/amount.** The regex split is heuristic; the balance delta is the truth
  for every row but the oldest. Mitigation: delta is authoritative, text is a cross-check with a
  named warning; the oldest row is flagged.
- **Hapoalim page artifacts** (`7`, repeated headers, the `*` branch line) match no row regex and
  are ignored; a row regex miss on a real transaction would break the chain and warn.
- **Taxonomy growth is a manifest change.** Adding `הכנסות` to the base is add-only (manifest set
  ⊆ verification set holds); old skill + new app: the skill never emits income leaves it was not
  told about. New skill + old app: the result route rejects unknown leaves ⇒ `needs_review`,
  never silent — ship app first (one PR, one deploy, then the skill re-install).
- **Client write surface is new.** B4 copies the download route's auth and adds the allowed-label
  guard; tests cover ownership 404, unpublished 404, label outside the job 400.
- **`/report` byte budget** unaffected; `monthTotalsAgorot` semantics change (expense-only) is
  what the admin panel already labels as spend.

## Verification

Skill (`python3 -m unittest`, synthetic text, no PII):

- `test_detect_bank_pdf_hapoalim` / `test_detect_bank_pdf_leumi` / `test_bank_detection_rejects_card_statements`
- `test_hapoalim_sign_from_marker` — `##1` negative, `##2` positive, balance chain intact.
- `test_leumi_amount_from_balance_delta_beats_glued_text` — ref `9562` + amount `46.32` parses as
  46.32; a deliberately wrong glued suffix produces the cross-check warning.
- `test_leumi_debit_is_positive` / `test_leumi_credit_is_negative` — a balance falling ₪1,000 →
  ₪900 stores `+10000`; a salary raising it stores a negative amount (Codex round-1 P1; the
  abs-value cross-check cannot see an inversion, so each direction is asserted on its own).
- `test_income_rules_do_not_apply_to_debits_and_expense_rules_not_to_credits` — a `ביטוח לאומי`
  payout (credit) lands in `הכנסות נוספות`, a `ביטוח לאומי` premium (debit) from the same string
  lands in the expense leaf `ביטוח לאומי`; a dictionary entry pointing an expense merchant at an
  `הכנסות` leaf is ignored for a debit (Codex round-1 P1).
- `test_card_parsers_report_billing_month` — MAX, Leumi card, Isracard each emit `billingMonth`
  for their billed source; bank parsers emit none.
- `test_leumi_oldest_row_is_flagged_unverifiable`
- `test_balance_chain_break_is_a_warning_not_a_drop`
- `test_settlement_rows_leave_transactions` — issuer debits land in `settlements`, never in
  `transactions`; an issuer **credit** stays a transaction.
- `test_income_rows_are_kind_income_and_reach_the_shortlist`
- `test_discount_xlsx_uses_the_same_classifier`
- `test_pdf_dispatch_routes_bank_before_refusing` (extends `test_detect_statement.py`)
- `test_verify_flags_settlement_dedup_collision` / `test_income_row_outside_income_section_is_flagged`
- `test_workbook_income_block_populated_from_income_rows` / `test_income_leaves_never_render_as_expense_rows` /
  `test_settlements_sheet_lists_rows_and_sums_per_source` / `test_card_only_job_workbook_unchanged`
- `test_skill_doc` keeps passing (paths).

App (`pnpm test`):

- `reportResult.test.ts`: settlements optional ⇒ identical outcome when absent; invalid settlement
  rejected; duplicate / colliding dedupKey fatal; `incomeTotalsAgorot` computed and excluded from
  `monthTotalsAgorot`.
- `taxonomyInvariants.test.ts`: income section is last, disjoint from expenses and from
  `DISTRIBUTION_EXCLUDED_LEAVES`.
- `reportAnalysis.test.ts`: income rows leave `sections`/`grandTotal`; `netByMonth`;
  `suggestMatches` picks within ₪5 **and** the same billing month only — two card sources with
  equal statement totals in different months each get only their own month's settlement, and a
  source without `billingMonth` is never suggested (Codex round-1 P2); `allowedMatchTargets`
  returns card labels only.
- `settlementsRoute.test.ts`: 404 not-owner, 404 unpublished, 400 label not in job, **404 when the
  settlement id belongs to another job the caller does not own and also when it belongs to
  another job the caller does own** (predicate is `{id, jobId}`, Codex round-1 P1), 200 sets and
  clears `matchedSource`.
- `reportPage.test.ts`: the card renders only when settlements exist; income table only when
  income rows exist.
- `hebrewErrors.test.ts` still passes (every new client/admin message Hebrew).

Manual, dev server: upload a MAX statement + the Hapoalim PDF → run → `completed` with the
balance-chain note only → `/report` shows income, `מצבנו`, and the card with a ✓ suggestion for
the MAX settlement → match → reload → persisted. Then Phase D.
