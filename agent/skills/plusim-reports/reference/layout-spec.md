# Workbook layout contract

Implemented by `../scripts/build_report_xlsx.py`; mirrors the household budget
workbook's example month sheets and its sub-report sheets
(`docs/plans/report-workbook-subreports.md`). Do not change without updating
both. Named tests: `../scripts/test_build_report_xlsx.py`.

## Sheets, in order

1. **Main** — the taxonomy list: each section name followed by its leaves, one
   per row (reference sheet, no numbers).
2. **One sheet per month**, named `<Hebrew month> <year>` (e.g. `יוני 2026`),
   right-to-left:
   - `A1`: `חודש <Hebrew month> <year>` (title font).
   - From row 3: for each taxonomy section — a header row (white-on-blue) whose
     total column holds `=<leaf total cells summed>`; then one row per leaf:
     leaf name in col A, each transaction amount (in shekels, format
     `₪ #,##0.00`) spread across columns B…, and a live `=SUM(B<r>:<last><r>)`
     total in the final column (min 9 amount slots, widens as needed).
   - Grand-total row two rows after the last section: `סה"כ החודש` +
     `=<section header cells summed>` (bold, highlighted).
   - **Income block** (manual-fill, appended after the grand total): `הכנסות :`
     header; rows `משכורת 1` / `הכנסות נוספות` / `משכורת 2` with blank amount
     cells and a live `=SUM` total in the total column; a `סה"כ` row summing the
     three; then `הכנסות` / `הוצאות` (= −grand total) / `זכות /חובה` rows in
     column B. The advisor types income by hand — the formulas populate
     everything downstream.
   - All totals are live formulas so the sheet stays hand-editable.
3. **ניתוח תוצאות** — cross-month analysis, built purely from per-month
   geometry maps (the total column is dynamic — never hardcode addresses):
   header row of month-sheet names + `ממוצע <N> חודשים`; one row per taxonomy
   section and leaf in order (section rows bold + yellow), each month cell
   `='<month sheet>'!<total col><row>`, average **row-qualified**
   `=AVERAGE(B<r>:<last month col><r>)`; a `סה"כ` row of negated grand totals;
   an income-comparison block (`כמה כסף הבאנו הביתה`) over the month income
   rows in the **same** month-column order; a closing `מצבנו` block
   (`הכנסות` / `הוצאות` = the average column of the two total rows, `יתרה` =
   their sum).
4. **התפלגות ההוצאות** — one row per taxonomy section from row 2: name by
   reference to the analysis sheet, value = that section's average cell
   (addressed via the analysis geometry map — the average column moves with
   month count). `שונות` subtracts the business/tax leaf averages
   (`עסק`, `מעמ`, `מס הכנסה`, `ביטוח לאומי`) when present. A native pie chart
   over the two columns, data labels = category name + percent, no legend,
   anchored at `G6`.
5. **טופס עזר למיפוי** — the advisor's static intake form, byte-for-byte from
   the `MAPPING_FORM_CELLS` constant (transcribed in the plan's appendix):
   insurer lists, standing-orders section, cash/telecom/child-allowance/fees
   questions with default `לא`, bank + non-bank loan tables, credit-card
   checklist. No formulas.
6. **חישוב יעדים** — blank fill-in savings calculator: target amount (`D1`,
   `₪` format) and target age (`F1`); six child rows (3-8) with
   `F=IF(D="","",$F$1-D)` · `H=IF(D="","",F*12)` ·
   `J=IF(D="","",IF(H>0,$D$1/H,""))` — every formula anchored on the row's own
   age input so unused rows stay blank and add nothing — and a `סה"כ` row
   `=SUM(J3:J8)`.
7. **un_categorized** — columns: חודש · תאריך · שם בית עסק · סכום · מקור ·
   הערה. Every transaction the pipeline could not confidently place, with its
   reason. Net-zero reversed groups appear here in full.
8. **פירוט תנועות** — the complete audit ledger: חודש · תאריך · שם בית עסק ·
   סכום · קטגוריה (or `ללא סיווג`) · מקור · הערה, sorted by month then date.

If a job has no transactions with a month (never the case for a valid result),
sheets 3-4 are skipped; sheets 5-6 are always present.

## Conventions

- Sheet views are `rightToLeft`; amounts are shekels (agorot / 100) with the
  `₪ #,##0.00` number format; credits stay negative.
- Only leaves with activity get amounts; empty leaves still render with a
  zero-sum formula (keeps the fixed row skeleton familiar to the user).
- Every cross-sheet reference is generated from the geometry maps returned by
  `_month_sheet()` / `_analysis_sheet()` — sheet names are always quoted
  (`'יוני 2026'!K3`), and no address is ever written from a constant.
- Analysis/distribution numbers cover **categorized** spend only (month sheets
  skip uncategorized rows); `un_categorized` and the ledger carry the rest.
