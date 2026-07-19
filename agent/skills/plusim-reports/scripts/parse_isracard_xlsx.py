# -*- coding: utf-8 -*-
"""Parse an Isracard/Leumi "פירוט עסקאות" xlsx export into normalized transactions.

Layout (as exported from the Isracard site):
  - a card header row like "פלטינה מסטרקארד - 4962" near the top
  - section "עסקאות שטרם נקלטו"  (pending; cols: date, merchant, amount, currency)
  - section "עסקאות למועד חיוב"  (billed; cols: date, merchant, txn amount, txn currency,
      charge amount, charge currency, voucher id, note)
  - section "עסקאות בחיוב מחוץ למועד" (out-of-cycle; billed cols + bank-charge date)
  - a totals row 'סה"כ לחיוב החודש בכרטיס בש"ח' (col E = the statement's billed total)

Rules implemented here (see reference/categorization-rules.md):
  - charge amount (col E) is authoritative for billed rows; txn amount only for pending
  - amounts become agorot ints; credits keep their negative sign
  - pending rows duplicated in the billed section (same date|merchant|amount) are dropped
  - the statement total is attached ONLY to the billed sourceLabel; pending/out-of-cycle
    rows get their own labels with no statement total (nothing to reconcile against)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import openpyxl


@dataclass
class Txn:
    date: str  # ISO yyyy-mm-dd
    merchant: str
    amount_agorot: int
    source_label: str
    dedup_key: str
    note: str = ""
    max_category: str = ""  # unused for isracard; kept for a uniform shape


@dataclass
class ParseResult:
    transactions: list[Txn] = field(default_factory=list)
    # label -> statement total in agorot (None = no total to reconcile)
    source_totals: dict[str, int | None] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def _agorot(v) -> int:
    return round(float(v) * 100)


def _iso(d: str) -> str:
    m = re.match(r"^(\d{2})\.(\d{2})\.(\d{2})$", str(d).strip())
    if not m:
        raise ValueError(f"unparseable date: {d!r}")
    dd, mm, yy = m.groups()
    return f"20{yy}-{mm}-{dd}"


def _cell(row, i):
    v = row[i] if i < len(row) else None
    return "" if v is None else v


def parse_isracard_xlsx(path: str) -> ParseResult:
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows = [[c for c in r] for r in ws.iter_rows(values_only=True)]

    res = ParseResult()

    # Card label: first cell containing a "<name> - <4 digits>" pattern.
    card = "isracard"
    for r in rows[:12]:
        for v in r:
            if isinstance(v, str):
                m = re.search(r"-\s*(\d{4})\b", v)
                if m and any("֐" <= ch <= "ת" for ch in v):
                    card = f"isracard-{m.group(1)}"
                    break
        if card != "isracard":
            break

    billed_label = f"{card}-billed"
    pending_label = f"{card}-pending"
    ooc_label = f"{card}-outofcycle"

    section = None  # "pending" | "billed" | "ooc"
    billed_keys: set[tuple] = set()
    pending_rows: list[Txn] = []
    statement_total: int | None = None

    for row in rows:
        a, b = _cell(row, 0), _cell(row, 1)
        joined = " ".join(str(v) for v in row if isinstance(v, str))

        if "עסקאות שטרם נקלטו" in joined and "סה" not in str(b):
            section = "pending"
            continue
        if "עסקאות למועד חיוב" in joined:
            section = "billed"
            continue
        if "עסקאות בחיוב מחוץ למועד" in joined:
            section = "ooc"
            continue
        if isinstance(b, str) and 'סה"כ לחיוב החודש' in b:
            v = _cell(row, 4)
            if isinstance(v, (int, float)):
                statement_total = _agorot(v)
            continue
        if isinstance(b, str) and b.startswith('סה"כ'):
            continue  # e.g. pending-section subtotal
        if str(a).strip() == "תאריך רכישה":
            continue  # section header row

        if section is None or not re.match(r"^\d{2}\.\d{2}\.\d{2}$", str(a).strip()):
            continue

        date = _iso(a)
        merchant = str(b).strip()
        note = str(_cell(row, 7)).strip().replace("\n", " · ")

        if section == "pending":
            amt = _cell(row, 2)
            if not isinstance(amt, (int, float)):
                continue
            agorot = _agorot(amt)
            pending_rows.append(
                Txn(
                    date=date,
                    merchant=merchant,
                    amount_agorot=agorot,
                    source_label=pending_label,
                    dedup_key=f"{pending_label}|{date}|{merchant}|{agorot}",
                    note="עסקה שטרם נקלטה",
                )
            )
            continue

        charge = _cell(row, 4)
        if not isinstance(charge, (int, float)):
            res.warnings.append(f"row without numeric charge skipped: {date} {merchant}")
            continue
        agorot = _agorot(charge)
        voucher = str(_cell(row, 6)).strip()
        label = billed_label if section == "billed" else ooc_label
        key = f"{label}|{voucher}" if voucher else f"{label}|{date}|{merchant}|{agorot}"
        res.transactions.append(
            Txn(
                date=date,
                merchant=merchant,
                amount_agorot=agorot,
                source_label=label,
                dedup_key=key,
                note=note,
            )
        )
        if section == "billed":
            billed_keys.add((date, merchant, agorot))

    # Pending rows that already appear among billed rows are duplicates.
    for t in pending_rows:
        if (t.date, t.merchant, t.amount_agorot) in billed_keys:
            continue
        res.transactions.append(t)

    res.source_totals[billed_label] = statement_total
    if any(t.source_label == pending_label for t in res.transactions):
        res.source_totals[pending_label] = None
    if any(t.source_label == ooc_label for t in res.transactions):
        res.source_totals[ooc_label] = None
    if statement_total is None:
        res.warnings.append(f"{path}: no statement total row found")
    return res


if __name__ == "__main__":
    import json
    import sys

    r = parse_isracard_xlsx(sys.argv[1])
    print(
        json.dumps(
            {
                "transactions": [t.__dict__ for t in r.transactions],
                "sourceTotals": r.source_totals,
                "warnings": r.warnings,
            },
            ensure_ascii=False,
            indent=1,
        )
    )
