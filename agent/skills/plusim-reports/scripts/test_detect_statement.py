# -*- coding: utf-8 -*-
"""Regression tests for statement detection — the silent-misroute bug.

MAX used to be the else-branch of the PDF dispatch: any PDF that was not
detected as Leumi/Isracard was handed to parse_max_pdf, which returns zero
transactions on a layout it does not know. A bank current-account (עובר ושב)
PDF therefore produced an empty run whose only symptom, all the way up in the
admin UI, was "transactions empty" — with nothing naming the file.

Worse than the confusing message: a MAX statement uploaded together with an
unrecognized one produced a report that looked complete while silently missing
every row of the second file.

These tests pin both halves of the fix: MAX is now detected explicitly, and an
unrecognized PDF raises with its filename instead of being guessed at.

Synthetic statement text only (no PII); PdfReader is monkeypatched so no real
PDF is needed.

    python3 -m unittest test_detect_statement
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
import run_job as R  # noqa: E402


class _FakePage:
    def __init__(self, text: str):
        self._t = text

    def extract_text(self) -> str:
        return self._t


class _FakeReader:
    def __init__(self, pages: list[str]):
        self.pages = [_FakePage(p) for p in pages]


def _detect(pages: list[str]) -> bool:
    with mock.patch.object(M, "PdfReader", lambda _path: _FakeReader(pages)):
        return M.detect_max_pdf("ignored.pdf")


# Both markers parse_max_pdf itself keys on: a known section header and the
# transaction-table column header.
MAX_PAGE = "עסקאות במועד החיוב\nשם בית העסקקטגוריהכרטיססוג עסקהסכום\n07.07.26חנות א\n"

# A Bank Discount current-account PDF: real statement, no card-table markers.
OSH_PAGE = (
    "בנק דיסקונט\nעובר ושב\nתנועות אחרונות\n"
    "תאריךיום ערךתיאור התנועהזכות/חובהיתרה\n"
    "07.07.2607.07.26משכורת12,000.0015,430.20\n"
)


# A Diners one-page export: no section headers, dd/mm/yy dates, amount after
# the date on each line. parse_max_pdf has a dedicated branch for this shape,
# so detection must accept it — a detector keyed only on the MAX table markers
# would reject a file the parser handles perfectly.
DINERS_PAGE = (
    "דיינרס קלאב ישראל\nפירוט חיובים\n"
    "07/07/26חנות א₪100.00\n"
    "03/07/26חנות ב₪88.20\n"
    "₪188.20 :02/08/26\n"
)


class TestDetectMaxPdf(unittest.TestCase):
    def test_detects_a_max_statement(self):
        self.assertTrue(_detect([MAX_PAGE]))

    def test_detects_max_when_a_cover_page_comes_first(self):
        self.assertTrue(_detect(["דף מידע ללקוח\n", MAX_PAGE]))

    def test_detects_a_diners_export(self):
        """The parser has a branch for this shape, so detection must not reject it."""
        self.assertTrue(_detect([DINERS_PAGE]))

    def test_diners_detection_survives_a_real_parse(self):
        """Detection and parsing must agree: a detected file yields rows."""
        with mock.patch.object(M, "PdfReader", lambda _p: _FakeReader([DINERS_PAGE])):
            self.assertTrue(M.detect_max_pdf("ignored.pdf"))
            res = M.parse_max_pdf("ignored.pdf", "diners")
        self.assertEqual([t.amount_agorot for t in res.transactions], [10000, 8820])
        self.assertEqual(res.source_totals["diners-billed"], 18820)

    def test_rejects_a_current_account_pdf(self):
        """The file that caused the original empty run."""
        self.assertFalse(_detect([OSH_PAGE]))

    def test_rejects_an_unrelated_pdf(self):
        self.assertFalse(_detect(["hello world, not a statement at all"]))

    def test_needs_both_markers_not_just_one(self):
        # A section name alone appears in MAX's legal boilerplate; the column
        # header alone is not enough either. Neither may pass on its own.
        self.assertFalse(_detect(["עסקאות במועד החיוב בלבד, ללא טבלה"]))
        self.assertFalse(_detect(["שם בית העסק\nללא כותרת מקטע"]))

    def test_an_unreadable_pdf_is_not_max(self):
        def boom(_path):
            raise ValueError("damaged pdf")

        with mock.patch.object(M, "PdfReader", boom):
            self.assertFalse(M.detect_max_pdf("ignored.pdf"))


class TestPdfDispatch(unittest.TestCase):
    """parse_pdf_auto routes by detection and refuses what it cannot place."""

    def _route(self, *, leumi: bool, maxi: bool, name="דוח.pdf"):
        with mock.patch.object(R, "detect_leumi_pdf", lambda _p: leumi), mock.patch.object(
            R, "detect_max_pdf", lambda _p: maxi
        ), mock.patch.object(R, "parse_leumi_pdf", lambda _p, label: f"leumi:{label}"), mock.patch.object(
            R, "parse_max_pdf", lambda _p, label: f"max:{label}"
        ):
            return R.parse_pdf_auto("ignored.pdf", "src-1", name)

    def test_routes_a_leumi_statement(self):
        self.assertEqual(self._route(leumi=True, maxi=False), "leumi:src-1")

    def test_routes_a_max_statement(self):
        self.assertEqual(self._route(leumi=False, maxi=True), "max:src-1")

    def test_leumi_wins_when_both_match(self):
        """Order is fixed so a dual match can never flip between runs."""
        self.assertEqual(self._route(leumi=True, maxi=True), "leumi:src-1")

    def test_refuses_an_unrecognized_pdf_instead_of_guessing(self):
        with self.assertRaises(R.UnknownStatementError) as ctx:
            self._route(leumi=False, maxi=False, name="עוש דודו.pdf")
        msg = str(ctx.exception)
        # The filename is the point — it is what "transactions empty" never said.
        self.assertIn("עוש דודו.pdf", msg)
        # And it must point at the fix that actually works today.
        self.assertIn("עובר ושב", msg)
        self.assertIn("xlsx", msg)


if __name__ == "__main__":
    unittest.main()
