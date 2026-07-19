# Workbook layout contract

Implemented by `../scripts/build_report_xlsx.py`; mirrors the household budget
workbook's example month sheets. Do not change without updating both.

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
   - All totals are live formulas so the sheet stays hand-editable.
3. **un_categorized** — columns: חודש · תאריך · שם בית עסק · סכום · מקור ·
   הערה. Every transaction the pipeline could not confidently place, with its
   reason. Net-zero reversed groups appear here in full.
4. **פירוט תנועות** — the complete audit ledger: חודש · תאריך · שם בית עסק ·
   סכום · קטגוריה (or `ללא סיווג`) · מקור · הערה, sorted by month then date.

## Conventions

- Sheet views are `rightToLeft`; amounts are shekels (agorot / 100) with the
  `₪ #,##0.00` number format; credits stay negative.
- Only leaves with activity get amounts; empty leaves still render with a
  zero-sum formula (keeps the fixed row skeleton familiar to the user).
