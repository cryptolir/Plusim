# -*- coding: utf-8 -*-
"""Regression tests for parse_max_pdf.py — the MAX "duplication" bug.

MAX prints a monthly charge-summary line ("… <dd.mm.yyyy> חיוב ב₪<total>") after
the last transaction of the card. It has no "סה״כ" label, so the section-total
cut did not catch it; because it trails the real charge, the last-token rule
read the statement total as that row's amount and the section sum came out
roughly doubled. These tests pin the fix.

Synthetic statement text only (no PII); PdfReader is monkeypatched so no real
PDF is needed.

    python3 -m unittest test_parse_max_pdf
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "vendor"))
sys.path.insert(0, _HERE)

import parse_max_pdf as M  # noqa: E402
from verify_report import verify  # noqa: E402


class _FakePage:
    def __init__(self, text: str):
        self._t = text

    def extract_text(self) -> str:
        return self._t


class _FakeReader:
    def __init__(self, pages: list[str]):
        self.pages = [_FakePage(p) for p in pages]


def parse_pages(pages: list[str], label: str = "max"):
    with mock.patch.object(M, "PdfReader", lambda _path: _FakeReader(pages)):
        return M.parse_max_pdf("ignored.pdf", label)


# A card list of three real charges (100.00 + 88.20 + 50.00 = 238.20), with the
# charge-summary line carrying a DIFFERENT number (999.99) glued after the last
# row — exactly the shape that used to be mis-read as a 999.99 transaction.
STATEMENT = [
    "עסקאות במועד החיוב\n"
    "שם בית העסקקטגוריהכרטיססוג עסקהסכום\n"
    "07.07.26חנות א\n"
    "מזון וצריכה8119רגילה₪100.00 \n"
    "03.07.26חנות ב\n"
    "מזון וצריכה8119רגילה₪88.20 \n"
    "ת.עסקה\n"
    ":10.07.2026חיוב ב₪999.99 \n"
    "02.07.26חנות ג\n"
    "מזון וצריכה8119רגילה₪50.00 \n"
    "₪238.20 \n"
    "סה״כ עסקאות במועד החיוב\n"
]


class ChargeSummaryTests(unittest.TestCase):
    def setUp(self):
        self.r = parse_pages(STATEMENT)
        self.amounts = sorted(t.amount_agorot for t in self.r.transactions)

    def test_no_phantom_charge_summary_row(self):
        # The 999.99 charge-summary total must NOT become a transaction.
        self.assertNotIn(99999, [t.amount_agorot for t in self.r.transactions])
        self.assertEqual(len(self.r.transactions), 3)

    def test_last_row_keeps_its_real_charge(self):
        # חנות ב (the row the summary glued onto) keeps 88.20, not the total.
        row = next(t for t in self.r.transactions if t.date == "2026-07-03")
        self.assertEqual(row.amount_agorot, 8820)

    def test_section_sum_not_doubled_and_reconciles(self):
        self.assertEqual(self.amounts, [5000, 8820, 10000])
        self.assertEqual(sum(self.amounts), 23820)
        # Statement section total is parsed as 238.20, and the sum matches it.
        self.assertEqual(self.r.source_totals["max-billed"], 23820)
        taxonomy = [{"section": "בית", "leaves": ["מזון ומכולת"]}]
        txns = [
            {
                "date": t.date, "month": t.date[:7], "merchant": t.merchant,
                "amountAgorot": t.amount_agorot, "category": "מזון ומכולת",
                "uncategorized": False, "sourceLabel": t.source_label,
                "note": t.note, "dedupKey": t.dedup_key,
            }
            for t in self.r.transactions
        ]
        ok, problems, _ = verify(txns, self.r.source_totals, taxonomy)
        self.assertTrue(ok, problems)

    def test_charge_summary_does_not_swallow_following_rows(self):
        # חנות ג (after the summary line) is still parsed.
        self.assertTrue(any(t.amount_agorot == 5000 for t in self.r.transactions))


class LastTokenRuleIntactTests(unittest.TestCase):
    """The fix must not disturb the existing last-token / cancellation rules."""

    def test_installment_takes_monthly_amount(self):
        pages = [
            "עסקאות במועד החיוב\n"
            "שם בית העסקקטגוריהכרטיססוג עסקהסכום\n"
            "02.07.26מוסך\n"
            "תחבורה ורכבים8119 מתוך1תשלום3₪5,700.00 \n"
            "₪1,900.00 \n"
        ]
        r = parse_pages(pages)
        self.assertEqual([t.amount_agorot for t in r.transactions], [190000])

    def test_cancellation_is_negative(self):
        pages = [
            "עסקאות במועד החיוב\n"
            "שם בית העסקקטגוריהכרטיססוג עסקהסכום\n"
            "02.07.26חנות\n"
            "מזון וצריכה8119ביטול עסקה₪30.00 \n"
        ]
        r = parse_pages(pages)
        self.assertEqual(r.transactions[0].amount_agorot, -3000)


if __name__ == "__main__":
    unittest.main()
