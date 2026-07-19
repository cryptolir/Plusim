# -*- coding: utf-8 -*-
"""Build the month-sheet workbook (reference/layout-spec.md).

Sheets: Main (taxonomy list) · one RTL sheet per month in the example layout
(section headers with subtotal formulas, leaf rows with amounts spread across
columns + a SUM formula, grand-total row) · un_categorized · פירוט תנועות
(full audit ledger). Amounts arrive as agorot ints and are written as shekels
with the ₪ number format; totals are live formulas so the sheet stays editable.
"""
from __future__ import annotations

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

CURR = "₪ #,##0.00"
HDR_FILL = PatternFill("solid", fgColor="4472C4")
GRAND_FILL = PatternFill("solid", fgColor="FFF2CC")
TITLE_FONT = Font(bold=True, size=14, color="1F3864")
WHITE_BOLD = Font(bold=True, color="FFFFFF")
BOLD = Font(bold=True)

HEB_MONTHS = [
    "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
    "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
]


def month_title(month: str) -> str:
    y, m = month.split("-")
    return f"{HEB_MONTHS[int(m) - 1]} {y}"


def _shekels(agorot: int) -> float:
    return agorot / 100.0


def build_workbook(taxonomy: list[dict], txns: list[dict], out_path: str) -> None:
    """taxonomy: [{"section": str, "leaves": [str]}]; txns: normalized dicts
    with month/date/merchant/amountAgorot/category/uncategorized/sourceLabel/note."""
    wb = openpyxl.Workbook()

    ws = wb.active
    ws.title = "Main"
    ws.sheet_view.rightToLeft = True
    ws["A1"] = "Main - רשימת קטגוריות"
    ws["A1"].font = TITLE_FONT
    r = 3
    for sec in taxonomy:
        c = ws.cell(r, 1, sec["section"])
        c.font = WHITE_BOLD
        c.fill = HDR_FILL
        r += 1
        for leaf in sec["leaves"]:
            ws.cell(r, 1, leaf)
            r += 1
    ws.column_dimensions["A"].width = 30

    months = sorted({t["month"] for t in txns})
    for month in months:
        _month_sheet(wb, taxonomy, [t for t in txns if t["month"] == month], month)

    _uncat_sheet(wb, [t for t in txns if t["uncategorized"]])
    _ledger_sheet(wb, txns)
    wb.save(out_path)


def _month_sheet(wb, taxonomy, txns, month: str) -> None:
    ws = wb.create_sheet(month_title(month))
    ws.sheet_view.rightToLeft = True
    ws.cell(1, 1, "חודש " + month_title(month)).font = TITLE_FONT

    amounts: dict[str, list[int]] = {}
    for t in txns:
        if not t["uncategorized"] and t.get("category"):
            amounts.setdefault(t["category"], []).append(t["amountAgorot"])

    maxk = max([len(v) for v in amounts.values()] + [9])
    tcol = maxk + 2
    tl = get_column_letter(tcol)

    row = 3
    header_rows: list[int] = []
    cur_leaf_rows: list[int] = []
    pending_header: int | None = None

    def close_section():
        if pending_header is not None:
            cell = ws.cell(pending_header, tcol)
            cell.value = ("=" + "+".join(f"{tl}{r}" for r in cur_leaf_rows)) if cur_leaf_rows else 0
            cell.font = WHITE_BOLD
            cell.fill = HDR_FILL
            cell.number_format = CURR

    for sec in taxonomy:
        close_section()
        cur_leaf_rows = []
        pending_header = row
        h = ws.cell(row, 1, sec["section"])
        h.font = WHITE_BOLD
        h.fill = HDR_FILL
        header_rows.append(row)
        row += 1
        for leaf in sec["leaves"]:
            ws.cell(row, 1, leaf)
            for i, agorot in enumerate(amounts.get(leaf, [])):
                c = ws.cell(row, 2 + i, _shekels(agorot))
                c.number_format = CURR
            tc = ws.cell(row, tcol, f"=SUM(B{row}:{get_column_letter(tcol - 1)}{row})")
            tc.number_format = CURR
            tc.font = BOLD
            cur_leaf_rows.append(row)
            row += 1
    close_section()

    grand = row + 1
    ws.cell(grand, 1, 'סה"כ החודש').font = BOLD
    gc = ws.cell(grand, tcol, "=" + "+".join(f"{tl}{r}" for r in header_rows))
    gc.number_format = CURR
    gc.font = Font(bold=True, size=12)
    gc.fill = GRAND_FILL

    ws.column_dimensions["A"].width = 26
    for ci in range(2, tcol + 1):
        ws.column_dimensions[get_column_letter(ci)].width = 12


def _uncat_sheet(wb, txns) -> None:
    ws = wb.create_sheet("un_categorized")
    ws.sheet_view.rightToLeft = True
    ws["A1"] = "עסקאות ללא סיווג"
    ws["A1"].font = TITLE_FONT
    for j, h in enumerate(["חודש", "תאריך", "שם בית עסק", "סכום", "מקור", "הערה"], 1):
        c = ws.cell(3, j, h)
        c.font = WHITE_BOLD
        c.fill = HDR_FILL
    r = 4
    for t in txns:
        ws.cell(r, 1, month_title(t["month"]))
        ws.cell(r, 2, t["date"])
        ws.cell(r, 3, t["merchant"])
        a = ws.cell(r, 4, _shekels(t["amountAgorot"]))
        a.number_format = CURR
        ws.cell(r, 5, t["sourceLabel"])
        ws.cell(r, 6, t.get("note") or "")
        r += 1
    for j, w in enumerate([12, 11, 28, 12, 20, 30], 1):
        ws.column_dimensions[get_column_letter(j)].width = w


def _ledger_sheet(wb, txns) -> None:
    ws = wb.create_sheet("פירוט תנועות")
    ws.sheet_view.rightToLeft = True
    ws["A1"] = "פירוט כל התנועות והסיווג"
    ws["A1"].font = TITLE_FONT
    for j, h in enumerate(["חודש", "תאריך", "שם בית עסק", "סכום", "קטגוריה", "מקור", "הערה"], 1):
        c = ws.cell(3, j, h)
        c.font = WHITE_BOLD
        c.fill = HDR_FILL
    r = 4
    for t in sorted(txns, key=lambda x: (x["month"], x["date"])):
        ws.cell(r, 1, month_title(t["month"]))
        ws.cell(r, 2, t["date"])
        ws.cell(r, 3, t["merchant"])
        a = ws.cell(r, 4, _shekels(t["amountAgorot"]))
        a.number_format = CURR
        ws.cell(r, 5, "ללא סיווג" if t["uncategorized"] else t.get("category") or "")
        ws.cell(r, 6, t["sourceLabel"])
        ws.cell(r, 7, t.get("note") or "")
        r += 1
    for j, w in enumerate([12, 11, 28, 12, 22, 20, 30], 1):
        ws.column_dimensions[get_column_letter(j)].width = w
