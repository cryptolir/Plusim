# -*- coding: utf-8 -*-
"""Parse a Bank Discount "עובר ושב" (current account) xlsx export.

Layout (as exported from the Discount site):
  - account header rows, incl. "חשבון: <number> | <holder name>"
  - section "תנועות אחרונות" with header row:
      תאריך | יום ערך | תיאור התנועה | ₪ זכות/חובה | ₪ יתרה | אסמכתה | עמלה | ערוץ ביצוע
    then one row per posted transaction (dates as real datetimes, newest first;
    debits negative, credits positive; יתרה = running balance AFTER the row)
  - section "תנועות עתידיות" (planned/future charges) — EXCLUDED: they are not
    posted yet and would double-count when the actual charge lands.

Rules implemented here (see reference/categorization-rules.md):
  - sign flip to the pipeline convention: an expense (debit) becomes a
    POSITIVE agorot amount; income/credit rows become NEGATIVE (like card
    credits) so they stay visible without inflating expense totals
  - date = the transaction date column (תאריך), never the value date (יום ערך)
  - dedup key = the voucher (אסמכתה) when present — two same-day ₪400 cash
    withdrawals are distinct transactions — else date|merchant|amount
  - completeness: a current-account statement prints no grand total, so the
    running-balance chain is verified instead (each row's balance must equal
    the newer row's balance minus the newer row's amount, to the agora);
    a break means rows are missing/duplicated and is reported as a warning
"""
from __future__ import annotations

import re
from datetime import datetime

import openpyxl

from parse_isracard_xlsx import ParseResult, Txn, _agorot


def _account_label(rows) -> str:
    for r in rows[:12]:
        for v in r:
            if isinstance(v, str) and "חשבון" in v:
                m = re.search(r"(\d[\d\-]{3,})", v)
                if m:
                    digits = re.sub(r"\D", "", m.group(1))
                    if len(digits) >= 4:
                        return f"discount-{digits[-4:]}"
    return "discount"


def parse_discount_xlsx(path: str) -> ParseResult:
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows = [[c for c in r] for r in ws.iter_rows(values_only=True)]

    res = ParseResult()
    label = _account_label(rows)

    in_recent = False
    skipped_future = 0
    chain: list[tuple[int, int, str]] = []  # (amount_agorot, balance_agorot, desc) newest→oldest

    for i, row in enumerate(rows):
        joined = " ".join(str(v) for v in row if isinstance(v, str))
        if "תנועות עתידיות" in joined:
            in_recent = False
            skipped_future = sum(
                1
                for r2 in rows[i + 1 :]
                if r2 and isinstance(r2[0], datetime) and isinstance(r2[3] if len(r2) > 3 else None, (int, float))
            )
            break
        if "תנועות אחרונות" in joined:
            in_recent = True
            continue
        if not in_recent:
            continue

        a = row[0] if len(row) > 0 else None
        d = row[3] if len(row) > 3 else None
        if not isinstance(a, datetime) or not isinstance(d, (int, float)):
            continue  # header row ("תאריך"...) or blank

        date = a.date().isoformat()
        merchant = str(row[2] or "").strip()
        # File convention: debit negative / credit positive → flip to the
        # pipeline convention (expense positive, income negative).
        agorot = -_agorot(d)
        voucher = str(row[5] or "").strip()
        channel = str(row[7] or "").strip() if len(row) > 7 else ""
        balance = row[4] if len(row) > 4 else None

        key = f"{label}|{voucher}" if voucher else f"{label}|{date}|{merchant}|{agorot}"
        res.transactions.append(
            Txn(
                date=date,
                merchant=merchant,
                amount_agorot=agorot,
                source_label=label,
                dedup_key=key,
                note=channel,
            )
        )
        if isinstance(balance, (int, float)):
            chain.append((agorot, _agorot(balance), f"{date} {merchant}"))

    # Running-balance chain check (rows are newest→oldest; amounts are stored
    # sign-flipped, so balance_older = balance_newer + amount_newer, agora-exact).
    breaks = 0
    for (amt_new, bal_new, desc_new), (_, bal_old, _) in zip(chain, chain[1:]):
        if bal_new + amt_new != bal_old:
            breaks += 1
            res.warnings.append(
                f"{path}: balance-chain break after {desc_new} "
                f"(bal {bal_new} + amt {amt_new} = {bal_new + amt_new} ≠ next bal {bal_old})"
            )
    # No printed statement total exists on a current account; an intact chain
    # is the completeness guarantee, a break is surfaced via warnings above.
    res.source_totals[label] = None
    if not chain:
        res.warnings.append(f"{path}: no balance column found — completeness unverifiable")

    if skipped_future:
        res.warnings.append(f"{path}: {skipped_future} future (תנועות עתידיות) row(s) excluded — not yet posted")
    if not res.transactions:
        res.warnings.append(f"{path}: no transactions parsed")
    return res


if __name__ == "__main__":
    import json
    import sys

    r = parse_discount_xlsx(sys.argv[1])
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
