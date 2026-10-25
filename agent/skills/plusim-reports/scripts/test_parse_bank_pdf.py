# -*- coding: utf-8 -*-
"""Named tests for parse_bank_pdf.py / bank_rows.py and the PDF dispatch order
(docs/plans/bank-statements.md, Verification section).

Synthetic statement text that mirrors the real exports' SHAPE (glued rows,
markers, U+200B, glued reference+amount) — no PII; PdfReader is monkeypatched.

    python3 -m unittest test_parse_bank_pdf
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "vendor"))
sys.path.insert(0, _HERE)

import bank_rows as BR  # noqa: E402
import parse_bank_pdf as B  # noqa: E402
import parse_leumi_pdf as L  # noqa: E402
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


def _with_pages(module, pages):
    return mock.patch.object(module, "PdfReader", lambda _path: _FakeReader(pages))


HAPOALIM_HEADER = (
    " 1 0001_4444401515  :- מתוך 0001\n"
    "06/10/2026 *2407 / 03-6532407bankhapoalim.co.il\n"
    "8454161812\n"
    "שם חשבוןבנקסניףחשבון \n"
    "תנועות בחשבון\n"
    "תקופה\n"
    "06/10/2026-06/04/2026\n"
    'יתרה בש"חזכותחובהפעולהתאריך\n'
)
# Newest first; every older balance = newer balance + newer amount (pipeline sign).
HAPOALIM_ROWS = (
    "04/10/2026ע.מפעולות-ישיר38.50₪1,000.00##2\n"
    '02/10/2026ישראכרט בע"מ20.90₪1,038.50##2\n'
    "01/10/2026מדיסון פארמה ב500.00₪1,059.40##1\n"
    "30/09/2026העברה למיכאל100.00₪559.40##2\n"
    "29/09/2026שירותי בריאות50.00₪659.40##1\n"
    "28/09/2026קצבת ילדים200.00₪609.40##1\n"
)
HAPOALIM_PAGE = HAPOALIM_HEADER + HAPOALIM_ROWS + " 7\n"

Z = "​"
LEUMI_HEADER = (
    " תנועות בחשבון| בנק לאומי\n"
    f"{Z}930-42497/62{Z} {Z}{Z} : מס' חשבון\n"
    "6/10/2026 :תאריך שמירה/הדפסה\n"
    "תנועות בחשבון\n"
    "היתרה\n"
    f"{Z}-14,304.47\n"
    'תאריךתאריך ערךתיאוראסמכתאבחובהבזכותהיתרה בש"ח \n'
)
# reference and amount GLUED, balance after; U+200B before negative balances.
LEUMI_ROWS = [
    f"02/10/202602/10/2026המרת קנ במטח956246.32{Z}-14,304.47 ",  # debit 46.32, ref 9562
    f"02/10/202602/10/2026מקס איט פיננ-י3468515,395.14{Z}-14,258.15 ",  # settlement 15,395.14
    "02/10/202602/10/2026מקס איט פיננ-י346856,756.551,136.99 ",  # settlement 6,756.55
    "01/10/202601/10/202612 עמל.ערוץ יש1219.807,893.54 ",  # debit 19.80, ref 12
    "01/10/202601/10/2026פרפקטו מוביי-י7467719,587.377,913.34 ",  # credit 19,587.37, ref 74677
    f"01/09/202601/09/2026פרפקטו מוביי-י7467718,858.68{Z}-11,674.03 ",  # oldest: sibling ref
]
LEUMI_PAGE = LEUMI_HEADER + "\n".join(LEUMI_ROWS) + "\n"

MAX_PAGE = "עסקאות במועד החיוב\nשם בית העסקקטגוריהכרטיססוג עסקהסכום\n07.07.26חנות א\nמזון8119רגילה₪100.00\n"
LEUMI_CARD_PAGE = (
    "אשראי לאומי\nפרוט פעולותיך לתאריך: 15/05/26\n"
    "בארץ - שחויבו עסקות\n14/04/26\n\nאינט\nסופר\nשונות\n199.00\n199.00\n"
    'לתאריך חיוב סה"כ\n15/05/26\n199.00\n'
)
DINERS_PAGE = "דיינרס קלאב ישראל\nפירוט חיובים\n07/07/26חנות א₪100.00\n₪100.00 :02/08/26\n"


def parse(pages, label=""):
    with _with_pages(B, pages):
        return B.parse_bank_pdf("ignored.pdf", label)


class TestDetection(unittest.TestCase):
    def test_detect_bank_pdf_hapoalim(self):
        with _with_pages(B, [HAPOALIM_PAGE]):
            self.assertTrue(B.detect_bank_pdf("x.pdf"))

    def test_detect_bank_pdf_leumi(self):
        with _with_pages(B, [LEUMI_PAGE]):
            self.assertTrue(B.detect_bank_pdf("x.pdf"))

    def test_bank_detection_rejects_card_statements(self):
        for page in (MAX_PAGE, LEUMI_CARD_PAGE, DINERS_PAGE, "hello"):
            with _with_pages(B, [page]):
                self.assertFalse(B.detect_bank_pdf("x.pdf"), page[:30])

    def test_bank_detection_needs_a_row_not_just_markers(self):
        with _with_pages(B, [HAPOALIM_HEADER]):
            self.assertFalse(B.detect_bank_pdf("x.pdf"))

    def test_card_detectors_reject_bank_statements(self):
        """Both real bank exports contain ישראכרט rows, slash dates and ₪ on
        date-led lines — the markers the card detectors used to accept."""
        for page in (HAPOALIM_PAGE, LEUMI_PAGE):
            with _with_pages(L, [page]):
                self.assertFalse(L.detect_leumi_pdf("x.pdf"), "leumi card accepted a bank export")
            with _with_pages(M, [page]):
                self.assertFalse(M.detect_max_pdf("x.pdf"), "max accepted a bank export")

    def test_card_detectors_still_accept_card_statements(self):
        with _with_pages(L, [LEUMI_CARD_PAGE]):
            self.assertTrue(L.detect_leumi_pdf("x.pdf"))
        with _with_pages(L, ["דף מידע\n", LEUMI_CARD_PAGE]):
            self.assertTrue(L.detect_leumi_pdf("x.pdf"), "headers after a cover page")
        with _with_pages(M, [MAX_PAGE]):
            self.assertTrue(M.detect_max_pdf("x.pdf"))
        with _with_pages(M, [DINERS_PAGE]):
            self.assertTrue(M.detect_max_pdf("x.pdf"))

    def test_pdf_dispatch_tries_bank_first(self):
        with mock.patch.object(R, "detect_bank_pdf", lambda _p: True), mock.patch.object(
            R, "detect_leumi_pdf", lambda _p: True
        ), mock.patch.object(R, "detect_max_pdf", lambda _p: True), mock.patch.object(
            R, "parse_bank_pdf", lambda _p, label: "bank"
        ), mock.patch.object(R, "parse_leumi_pdf", lambda _p, label: "leumi"), mock.patch.object(
            R, "parse_max_pdf", lambda _p, label: "max"
        ):
            self.assertEqual(R.parse_pdf_auto("x.pdf", "src", "x.pdf"), "bank")

    def test_refusal_names_the_bank_pdf_support(self):
        with mock.patch.object(R, "detect_bank_pdf", lambda _p: False), mock.patch.object(
            R, "detect_leumi_pdf", lambda _p: False
        ), mock.patch.object(R, "detect_max_pdf", lambda _p: False):
            with self.assertRaises(R.UnknownStatementError) as ctx:
                R.parse_pdf_auto("x.pdf", "src", "קובץ.pdf")
        msg = str(ctx.exception)
        self.assertIn("קובץ.pdf", msg)
        self.assertNotIn("xlsx only", msg)
        self.assertIn("Hapoalim", msg)


class TestHapoalim(unittest.TestCase):
    def setUp(self):
        self.r = parse([HAPOALIM_PAGE])
        self.by = {t.merchant: t for t in self.r.transactions}

    def test_hapoalim_sign_from_marker(self):
        self.assertEqual(self.by["ע.מפעולות-ישיר"].amount_agorot, 3850)  # ##2 debit
        self.assertEqual(self.by["מדיסון פארמה ב"].amount_agorot, -50000)  # ##1 credit
        self.assertEqual(self.by["מדיסון פארמה ב"].direction, "credit")
        self.assertEqual(self.by["קצבת ילדים"].kind, "credit")

    def test_hapoalim_header_and_period_lines_are_ignored(self):
        self.assertEqual(len(self.r.transactions), 6)
        self.assertEqual(self.r.warnings, [])  # intact chain, nothing else parsed
        self.assertEqual(self.r.source_totals, {"hapoalim-1812": None})
        self.assertEqual(self.by["קצבת ילדים"].date, "2026-09-28")

    def test_hapoalim_dedup_key_shape(self):
        self.assertEqual(
            self.by["ע.מפעולות-ישיר"].dedup_key, "hapoalim-1812|2026-10-04|ע.מפעולות-ישיר|3850|1"
        )

    def test_balance_chain_break_is_a_warning_not_a_drop(self):
        broken = HAPOALIM_PAGE.replace("₪1,038.50##2", "₪1,038.51##2")
        r = parse([broken])
        self.assertEqual(len(r.transactions), 6)
        self.assertTrue(any("balance-chain break" in w for w in r.warnings), r.warnings)

    def test_settlement_rows_leave_transactions(self):
        """Issuer DEBIT ⇒ kind settlement; an issuer CREDIT stays a transaction."""
        self.assertEqual(self.by['ישראכרט בע"מ'].kind, "settlement")
        page = HAPOALIM_HEADER + '02/10/2026ישראכרט בע"מ20.90₪1,038.50##1\n'
        r = parse([page])
        self.assertEqual(r.transactions[0].kind, "credit")
        self.assertEqual(r.transactions[0].amount_agorot, -2090)

    def test_transfer_to_michael_is_not_a_settlement(self):
        self.assertEqual(self.by["העברה למיכאל"].kind, "expense")


class TestLeumi(unittest.TestCase):
    def setUp(self):
        self.r = parse([LEUMI_PAGE])
        self.rows = self.r.transactions

    def _one(self, merchant, date):
        return next(t for t in self.rows if t.merchant == merchant and t.date == date)

    def test_leumi_amount_from_balance_delta_beats_glued_text(self):
        # Glued "1219.80": a regex split would read ref 121 / amount 9.80.
        t = self._one("12 עמל.ערוץ יש", "2026-10-01")
        self.assertEqual(t.amount_agorot, 1980)
        self.assertEqual(t.note, "אסמכתא 12")
        self.assertEqual(self.r.warnings, [])

    def test_leumi_debit_is_positive(self):
        self.assertEqual(self._one("המרת קנ במטח", "2026-10-02").amount_agorot, 4632)
        self.assertEqual(self._one("מקס איט פיננ-י", "2026-10-02").direction, "debit")

    def test_leumi_credit_is_negative(self):
        t = self._one("פרפקטו מוביי-י", "2026-10-01")
        self.assertEqual(t.amount_agorot, -1958737)
        self.assertEqual(t.kind, "credit")

    def test_leumi_settlements_are_classified(self):
        kinds = [t.kind for t in self.rows if t.merchant == "מקס איט פיננ-י"]
        self.assertEqual(kinds, ["settlement", "settlement"])

    def test_leumi_recurring_reference_does_not_collide(self):
        """The reference is a counterparty id shared by many rows — it must not
        be the dedup key (two salary rows carry 74677)."""
        keys = [t.dedup_key for t in self.rows]
        self.assertEqual(len(keys), len(set(keys)))
        same_day = [t for t in self.rows if t.merchant == "מקס איט פיננ-י"]
        self.assertNotEqual(same_day[0].dedup_key, same_day[1].dedup_key)
        self.assertTrue(all(k.startswith("leumi-9762|") for k in keys))

    def test_leumi_oldest_row_amount_from_sibling_reference(self):
        t = self._one("פרפקטו מוביי-י", "2026-09-01")
        self.assertEqual(t.amount_agorot, -1885868)  # sign from the sibling (a credit)
        self.assertEqual(t.note, "אסמכתא 74677")

    def test_leumi_oldest_row_without_sibling_is_dropped_with_warning(self):
        page = LEUMI_HEADER + "\n".join(LEUMI_ROWS[:-1]) + "\n" + (
            f"01/09/202601/09/2026חברה חדשה1234512.00{Z}-11,674.03 \n"
        )
        r = parse([page])
        self.assertEqual(len(r.transactions), 5)
        self.assertTrue(
            any("חברה חדשה 2026-09-01: oldest row" in w and "excluded" in w for w in r.warnings),
            r.warnings,
        )

    def test_leumi_glued_text_mismatch_is_a_warning(self):
        page = LEUMI_PAGE.replace("956246.32", "956299.99")
        r = parse([page])
        self.assertEqual(r.transactions[0].amount_agorot, 4632)  # chain still wins
        self.assertTrue(any("does not end the printed text" in w for w in r.warnings), r.warnings)

    def test_leumi_date_is_the_first_date(self):
        page = LEUMI_HEADER + f"02/10/202603/10/2026המרת קנ במטח956246.32{Z}-14,304.47 \n" + LEUMI_ROWS[1]
        r = parse([page])
        self.assertEqual(r.transactions[0].date, "2026-10-02")


class TestSettlementPayees(unittest.TestCase):
    def test_settlement_payee_matches_whole_token_only(self):
        for desc in ('ישראכרט בע"מ', "ישראכרט-כ.ויזה", "כרטיסי אשראי ל", "מקס איט פיננ-י", "לאומי ויזה", 'ישראכרט בע"מ-י'):
            self.assertTrue(BR.is_settlement_payee(desc), desc)
        for desc in ("העברה למיכאל", "כאל", "ישראכרטים", "כרטיסי", "מקס", "לאומי למשכנתאו"):
            self.assertFalse(BR.is_settlement_payee(desc), desc)

    def test_transfer_to_michael_is_not_a_settlement(self):
        self.assertEqual(BR.classify_bank_row("העברה למיכאל", 10000), ("debit", "expense"))
        self.assertEqual(BR.classify_bank_row("העברה למיכאל", -10000), ("credit", "credit"))

    def test_only_observed_payees_are_listed(self):
        self.assertNotIn("כאל", BR.SETTLEMENT_PAYEES)


if __name__ == "__main__":
    unittest.main()
