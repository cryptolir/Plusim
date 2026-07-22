# Plusim — Report workbook sub-reports (ניתוח תוצאות · התפלגות ההוצאות · טופס עזר למיפוי · חישוב יעדים)

> **Status:** Draft — **Rev 1**, awaiting adversarial review (plan-review protocol,
> `openclaw-dashboard/docs/PLAN_REVIEW_PROTOCOL.md`). Nothing implemented yet.
>
> **Review log:**
> - Rev 1 — authored from the demo workbook `מיפוי כהן חופית ומני 2026 (1).xlsx` and a
>   file-anchored read of the pipeline; ponytail pass ran before handoff (see
>   "Ponytail cuts" below). A pre-handoff adversarial pass against the template's raw
>   XML caught and fixed four drafting errors: pie labels are category-name+percent with
>   no legend (not percent-only); the template *omits* the goals division on blank rows
>   (it does not render `#DIV/0!`); the template's income-comparison block has a swapped
>   month order vs. its expense block; income totals sit one column left of the expense
>   total column. The last two are now flagged as explicit normalizations (A2, B1).

## Context

What exists today, read from the code (not memory):

1. **The generated workbook has 4 sheet kinds only.** `agent/skills/plusim-reports/scripts/build_report_xlsx.py`
   builds: `Main` (taxonomy list, :43-57), one RTL sheet per month named
   `<Hebrew month> <year>` (`month_title`, :29-31, :68-125), `un_categorized` (:128-148)
   and `פירוט תנועות` (:151-172). `reference/layout-spec.md` declares this a two-sided
   contract — "Do not change without updating both" (:3-4).
2. **The demo template the advisor actually uses has 4 more sub-reports.** The uploaded
   workbook `מיפוי כהן חופית ומני 2026 (1).xlsx` contains, after its month sheets
   (`11`,`12`,`1`,`2`,`3`,`4`), in order: `ניתוח תוצאות` (cross-month analysis),
   `התפלגות ההוצאות` (expense distribution + pie chart), `טופס עזר למיפוי` (static
   advisor intake form), `חישוב יעדים` (children savings-goal calculator). All RTL,
   amounts formatted `"₪" #,##0.00`.
3. **The template's month sheets also carry an income block** (rows 64-71: `הכנסות :`,
   `משכורת 1` / `הכנסות נוספות` / `משכורת 2` each `=SUM(B:I)` into col J; `J68=SUM(J65:J67)`;
   then `הכנסות`=J68 / `הוצאות`=-K63 / `זכות /חובה `=SUM of both). The generated month
   sheet has no income section at all (`build_report_xlsx.py:68-125` writes expenses only).
4. **The template's `ניתוח תוצאות` is pure cross-sheet formulas.** Header row of month
   labels + `ממוצע 4 חודשים`; one row per taxonomy **section and leaf** in order, each
   month cell `='<month sheet>'!K<row>` (section rows bold + yellow fill), average col
   `=AVERAGE(B:E)`; a `סה"כ` row `=-'<m>'!K63`; an income comparison block
   (`כמה כסף הבאנו הביתה`, rows referencing the month sheets' `J65..J67` totals) and a
   closing `מצבנו` block (`הכנסות`=avg income, `הוצאות`=avg expenses, `יתרה`=sum).
   Note: in the template this income block's month **columns are in a different order**
   than the expense block above it (`B72='1'!J65` while `B9='12'!K3`) and its header
   dates (row 71) are shifted one month back from row 8 — hand-editing artifacts, not
   design. We normalize both blocks to one consistent month order (B1).
5. **`התפלגות ההוצאות` is a 10-row table + native pie chart.** Row per section:
   `A='ניתוח תוצאות '!A<sect>`, `B='ניתוח תוצאות '!F<sect>` (the average), with
   deliberate deviations: `חסכונות` = `F34-F35` (excludes קופת גמל), `שונות` =
   `F60-F62-F63-F64-F65` (excludes עסק/מעמ/מס הכנסה/ביטוח לאומי), and this household's
   sheet self-zeroes תקשורת and תחבורה (`F40-F40`, `F44-F44`). A pie chart
   (`xl/charts/chart1.xml`) plots `A2:A11`/`B2:B11` with **category-name + percentage**
   data labels (`showCatName=1`, `showPercent=1`) and **no legend**.
6. **`חישוב יעדים` is a small formula calculator.** `C1`=`סכום היעד`/`D1`=amount,
   `E1`=`גיל היעד`/`F1`=age; per-child rows: שם · גיל · `תקופה בשנים`=`$F$1-D<r>` ·
   `חודשי חיסכון`=`F<r>*12` · `סה"כ חיסכון חודשי`=`$D$1/H<r>`. On its one blank row the
   template simply *omits* the division cell; our sheet pre-places formulas in all six
   fill-in rows, so each division must be guarded against blank/zero inputs.
7. **Month-sheet cell geometry is dynamic, not fixed.** The total column is
   `tcol = max(largest per-leaf txn count, 9) + 2` (`build_report_xlsx.py:78-79`) — column
   K only when no leaf exceeds 9 transactions, and it differs per month sheet. Rows
   depend on the manifest taxonomy. Cross-sheet references must therefore be **generated
   from per-sheet geometry**, never hardcoded `K3`-style addresses.
8. **Verification never looks at sheets.** Agent-side `verify_report.py:16-60` checks the
   transaction JSON (dedup, taxonomy leaves, month bounds, per-source totals to the
   agora); app-side `src/lib/reportResult.ts:154-218` re-verifies the same JSON and
   `decodeXlsx` (:221-228) only checks PK magic + ≤15MB decoded (base64 ≤20M chars,
   :109). New sheets cannot trip verification — which also means **only our own tests
   catch a broken formula sheet**.
9. **There is no income data source.** The only parsers are card statements
   (`parse_isracard_xlsx.py`, `parse_max_pdf.py`; dispatch at `run_job.py:225-229`).
   In the template the advisor types income by hand.
10. **Month sheets contain categorized spend only** (`build_report_xlsx.py:73-76` skips
    uncategorized rows), so analysis totals derived from month-sheet cells exclude
    uncategorized transactions — same exclusion the app applies in `monthTotalsAgorot`
    (`reportResult.ts:202-207`).
11. **A job is already multi-month.** `months = sorted({t["month"]})`
    (`build_report_xlsx.py:59-61`); the verified baseline in `docs/REPORTS_PIPELINE.md`
    covers one job spanning 4 months. The analysis sheet works over whatever months the
    job's statements contain. There is **no cross-job history** on the agent API.
12. **Skill files deploy manually.** The repo `agent/skills/plusim-reports/` is source of
    truth, but onlyclaw runs a workspace copy; changes require the one-time re-install
    procedure in `AGENT_SETUP.md` (§7) after merge. `openpyxl` is vendored in the
    workspace (`SKILL.md:23-30`) and includes `openpyxl.chart` — no new dependency.

**Goal:** the workbook the agent returns should contain every sub-report the advisor's
demo template has — the four analysis/helper sheets plus the month-sheet income block —
generated deterministically by `build_report_xlsx.py`, with live formulas so the advisor
can keep hand-editing (fill income, tweak the pie inputs) exactly as they do today in
the manual template. No pipeline, manifest, schema, or app-side change.

### Decisions (proposed defaults — reviewers, attack these)

1. **Everything is builder-side; no new agent skill.** The four sheets are deterministic
   output of the existing `plusim-reports` skill's build step. This preserves SKILL.md's
   core principle: the model's only judgment task stays categorization (step 3).
2. **Income stays manual-fill.** Month sheets gain the income block as an empty skeleton
   with live formulas (like the template before the advisor types into it). No
   bank-statement parsing, no manifest field. `ניתוח תוצאות`'s income rows reference
   those cells, so they populate the moment the advisor fills them in.
3. **Distribution defaults:** one row per taxonomy section; `שונות` excludes the
   business/tax leaves (`עסק`, `מעמ`, `מס הכנסה`, `ביטוח לאומי`) via a subtraction
   formula, mirroring the template's clear intent (household-consumption pie). The
   template's other tweaks (קופת גמל out of חסכונות, self-zeroed תקשורת/תחבורה) look
   household-specific; we do **not** replicate them — the rows stay live formulas the
   advisor can adjust per household, exactly as she does now.
4. **`חישוב יעדים` ships as a blank fill-in calculator** (6 child rows + totals row,
   formulas guarded for blank rows). Children's names/ages have no legitimate channel
   today (`report_rules` is a **global** setting — putting one family's kids there would
   leak into every household's manifest) and a schema migration for it is not justified
   yet. If pre-fill is wanted later it's a separate plan (new `ReportJob` column +
   manifest field).
5. **Sheet order:** `Main` → month sheets → `ניתוח תוצאות` → `התפלגות ההוצאות` →
   `טופס עזר למיפוי` → `חישוב יעדים` → `un_categorized` → `פירוט תנועות`. Template
   order preserved for the user-facing sub-reports; `Main` stays first/active and the
   two pipeline-artifact sheets stay last. Names are trimmed (no template trailing
   spaces) and cannot collide with `month_title()` output.

## Hard boundary

Per `AGENTS.md` rule 0: only files inside the Plusim repo change. The onlyclaw
workspace re-install (`AGENT_SETUP.md` §7) is an explicit ops step performed through the
documented procedure after merge — never ad-hoc edits to another project's directory.

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| `build_report_xlsx.py` style constants (`CURR`, `HDR_FILL`, `TITLE_FONT`, …), `month_title()`, `_shekels()` | identical look on all new sheets |
| `_month_sheet()`'s computed `tcol` / row walk | return it as a geometry map instead of discarding it — the single source for every cross-sheet reference |
| Manifest taxonomy (`manifest["taxonomy"]` → `build_workbook(taxonomy=…)`) | analysis + distribution rows derive from it; row counts must not assume 10 sections |
| Vendored `openpyxl` (workspace `vendor/`, `SKILL.md:23-30`) — includes `openpyxl.chart` | the pie chart; **no new dependency, no vendor rebuild** |
| `reference/layout-spec.md` | the contract doc to extend in the same commit |
| `AGENT_SETUP.md` §7 re-install procedure + `docs/REPORTS_PIPELINE.md` verified-baseline procedure | shipping + re-validation, unchanged |

## Plan

All changes in `agent/skills/plusim-reports/` unless noted.

### Phase A — geometry + income block (`scripts/build_report_xlsx.py`)

- **A1. Geometry map.** `_month_sheet()` returns
  `{"sheet": title, "tcol": int, "leaf_rows": {leaf: row}, "section_rows": {section: row},
  "grand_row": int, "income": {...}}`. `build_workbook()` collects these per month and
  passes them to the new sheet builders. No formula anywhere is written from a hardcoded
  address.
- **A2. Income block on every month sheet**, appended after the grand-total row
  (template rows 64-71): `הכנסות :` header; rows `משכורת 1` / `הכנסות נוספות` /
  `משכורת 2` — blank amount cells across `B..tcol-1`, live `=SUM(...)` total in `tcol`;
  a total row summing the three; then `הכנסות` / `הוצאות` (`=-<grand cell>`) /
  `זכות /חובה` rows. All cells `₪` format; rows recorded in the geometry map. Two
  deliberate normalizations vs. the template: (a) income totals land in the sheet's
  single total column `tcol` (the template puts them in `J`, one left of its expense
  total column `K` — a two-total-column layout we do not reproduce); (b) the template's
  one-off quirks (`J66=SUM(B66:I66)+K66+L66+M66`) become plain `SUM` over the amount
  columns.
- **A3. Regression guard:** everything currently emitted (Main, expense skeleton,
  un_categorized, ledger) stays semantically identical — same rows, same formulas, same
  formats (openpyxl output bytes will differ; the test compares cell content) — with the
  income block strictly appended.

### Phase B — the four sub-report sheets (`scripts/build_report_xlsx.py`)

- **B1. `ניתוח תוצאות`.** Header row: one column per month (label = `month_title()`),
  then `ממוצע <N> חודשים`. One row per taxonomy section and leaf, in taxonomy order
  (section rows bold + yellow fill, as in the template); each month cell
  `='<month sheet>'!<tcol letter><row>` from the geometry map (sheet names quoted —
  they contain spaces); average `=AVERAGE(<first month>:<last month>)`. `סה"כ` row
  referencing each month's grand cell negated (the template's own D69/E69 hand-edit
  inconsistency is normalized to the reference form). Income comparison block
  (`כמה כסף הבאנו הביתה`) referencing each month's income row totals + `סה"כ`; closing
  `מצבנו` block: `הכנסות`=income average, `הוצאות`=expense average, `יתרה`=their sum.
  Both blocks use the **same** month-column order (normalizing the template's swapped
  income columns and shifted header dates — see Context 4). Works for any month count
  ≥ 1 (`AVERAGE` over a single column is valid).
- **B2. `התפלגות ההוצאות`.** One row per section: name by reference
  (`='ניתוח תוצאות'!A<r>`), value = the section's average cell, except `שונות` =
  average minus the business/tax leaf averages (Decision 3), emitted only for leaves
  present in the manifest taxonomy. Native `openpyxl.chart.PieChart` over the two
  columns, data labels showing **category name + percentage**
  (`DataLabelList(showCatName=True, showPercent=True)`), **legend removed**
  (`chart.legend = None`) — matching the template's chart XML — anchored beside the
  table (template anchor ≈ `G6`). Row count follows the taxonomy — never hardcoded 10.
- **B3. `טופס עזר למיפוי`.** Static replica of the template sheet (insurer lists,
  standing-orders section, ATM/telecom/child-allowance/fees questions with default `לא`,
  bank + non-bank loan tables, credit-card checklist) from a module-level constant —
  content copied verbatim from the demo workbook, RTL, no formulas.
- **B4. `חישוב יעדים`.** Target amount/age inputs (`D1`, `F1` — `D1` in `₪` format),
  six blank child rows with the template's formula chain, each division guarded:
  `=IF(H<r>>0, $D$1/H<r>, "")` (blank rows must not render `#DIV/0!`); a `סה"כ` row
  summing the per-child monthly amounts. The template's scratch cells (`J9`, `J18`,
  side table `M11:N16`) are not replicated.
- **B5. Sheet insertion** in the Decision-5 order; all new sheets
  `sheet_view.rightToLeft = True`.

### Phase C — contract, docs, tests, ops

- **C1. `reference/layout-spec.md`:** extend "Sheets, in order" with the four new sheets
  and the month-sheet income block, with the same precision the current entries have
  (this is the contract the model and future edits follow).
- **C2. `docs/REPORTS_PIPELINE.md`:** update the workbook-contract paragraph + file map;
  note that sub-report sheets are formula-derived from month sheets and invisible to
  app-side verification by design.
- **C3. Tests** — new `scripts/test_build_report_xlsx.py`, bare `python3 -m unittest`
  runnable on the dev server (vendored deps suffice; no CI exists in this repo). Named
  cases in **Verification** below.
- **C4. Ops (post-merge):** re-install the changed skill files into the onlyclaw
  workspace per `AGENT_SETUP.md` §7 (repo `agent/skills/…` → workspace `skills/…`),
  verify with `py_compile` + git-blob SHA; then re-run the verified baseline
  (`docs/REPORTS_PIPELINE.md` — real statements, PII, operator-only) and confirm the
  regenerated workbook's totals still reconcile to the agora and LibreOffice recalc
  reports zero formula errors.

## Non-goals

- Cross-**job** history: the analysis sheet covers the months inside the current job
  only. Serving prior published months to the agent is an API change — separate plan.
- Bank-statement parsing / automatic income capture (Decision 2 keeps income manual).
- Per-job household config (children pre-fill) — needs schema + UI + manifest work;
  explicitly deferred (Decision 4).
- App-side parsing/validation of workbook sheets; `/report` web-page parity (the new
  sheets live in the xlsx download and the Google Sheets export only).
- Replicating the demo household's manual pie tweaks (self-zeroed sections, קופת גמל
  exclusion) or its scratch cells/side notes (`H68:I75` etc.).
- The template's logo image on the analysis sheet.

## Ponytail cuts (Rev 1)

- **yagni:** Prisma migration + admin-UI form + manifest field for children/goals
  pre-fill — cut; the blank calculator serves the advisor's current manual workflow.
- **yagni:** configurable pie-exclusion setting (new `SETTING_KEYS` entry) — cut; the
  exclusion list is one named constant beside `RULES` in the builder, and rows stay
  hand-editable formulas.
- **yagni:** manifest `version` bump — nothing in the manifest changes.
- **yagni:** new agent skill — the existing skill's deterministic build step is the
  right home; a second skill would duplicate the job protocol for no gain.
- **shrink:** no verify_report.py extension — it verifies transaction JSON, which is
  untouched; workbook-formula correctness is covered by the new unit tests instead of a
  second runtime verifier.
- **Kept deliberately:** the geometry map (A1). It looks like refactoring, but every
  cross-sheet formula depends on per-sheet dynamic `tcol`/rows — without it the analysis
  sheet is hardcoded-address fragility, the exact failure mode the layout contract warns
  about.

## Risks / contingencies

- **Formula fragility (the big one):** a row/column shift that isn't reflected in every
  dependent formula produces a workbook whose numbers silently disagree — and nothing
  app-side would notice (Context 8). Mitigation: all references flow from the A1
  geometry map, and the test suite recomputes expected addresses independently.
- **Google Sheets export fidelity:** publish converts the xlsx via
  `uploadXlsxAsSpreadsheet` (best-effort — failure only sets `exportNote`). Basic pie
  charts and cross-sheet formulas survive Drive conversion, but this must be eyeballed
  once on dev during E2E; if the chart drops, the table still carries the data.
- **Size caps:** four formula sheets + one native chart add tens of KB against a 15MB
  decoded cap — no realistic risk; the size test (below) pins it.
- **Blank-data edge cases:** a single-month job (`AVERAGE` over one column), an all-blank
  income block (sums to 0, `מצבנו` shows expenses only), blank child rows (guarded
  divisions) — each is a named test.
- **Skill re-install forgotten:** repo changes are a silent no-op at the runtime until
  C4 runs (precedent: the settings-plan P1 finding). C4 is an explicit checklist item
  with SHA verification.
- **Baseline requires PII fixtures:** only an operator with the real statements can
  re-run the verified baseline; CI-less unit tests cover geometry, the operator run
  covers end-to-end truth. Both are required before ship.

## Verification

Unit (`scripts/test_build_report_xlsx.py`, synthetic transactions, runs with vendored deps):

- `test_month_income_block_rows_and_formulas` — income rows appended, SUM ranges span
  the amount columns, `הוצאות` cell references the grand-total cell.
- `test_existing_sheets_unchanged_regression` — with the new code, Main / expense
  skeleton / un_categorized / ledger emit exactly today's rows, formulas, formats.
- `test_analysis_cells_reference_month_geometry` — for a job where one month's `tcol`
  ≠ K (a leaf with >9 txns), every analysis cell points at the right sheet (quoted
  name), column letter, and row.
- `test_analysis_average_and_single_month` — average range spans exactly the month
  columns; a one-month job builds a valid sheet.
- `test_analysis_income_and_status_blocks` — income comparison rows hit the month
  income totals; `מצבנו` = avg income / avg expenses / sum.
- `test_distribution_rows_follow_taxonomy` — row per section, references resolve, and a
  non-default taxonomy (e.g. 8 sections, missing `עסק`) still builds correctly.
- `test_distribution_business_exclusion_formula` — `שונות` subtracts exactly the
  present business/tax leaf averages.
- `test_distribution_pie_chart` — a PieChart exists on the sheet, series over the
  name/value columns, `dataLabels.showCatName` and `.showPercent` both true, legend
  removed.
- `test_mapping_helper_static_content` — the static form matches the template constant.
- `test_goals_division_guard` — blank child rows yield no `#DIV/0!`; filled rows
  reproduce the template's arithmetic.
- `test_sheet_order_and_rtl` — Decision-5 order; every new sheet is rightToLeft.
- `test_size_under_caps` — a 5000-transaction build stays far below the 15MB decoded /
  20M-char base64 caps (`reportResult.ts:109,226`).

Manual E2E (dev server, before merge of the implementation PR):

- `run_job.py finalize --dry-run` on sample statements → open the workbook, LibreOffice
  recalc → **zero formula errors**; spot-check that analysis numbers equal the month
  sheets they reference.
- Full dev-job round-trip → publish → open the exported Google Sheet → pie chart and
  cross-sheet values survived conversion.
- Operator re-run of the verified baseline (109 tx, totals to the agora) per
  `docs/REPORTS_PIPELINE.md`.

Regression rule: a workbook built from the same transactions as today differs **only**
by the appended income block and the four new sheets.
