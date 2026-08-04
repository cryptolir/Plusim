# -*- coding: utf-8 -*-
"""Installment (תשלומים / קרדיט) re-dating — the wrong-month bug.

A Leumi statement prints the ORIGINAL DEAL date on installment rows, not the
date they are charged. Measured on a real statement (job דיין 9, 2026-08-04):
five installment rows carried dates from 2025-09 … 2026-03 in a statement
charged 15/05/26, scattering ₪1,825.03 across four months that do not exist in
the report and undercounting May by the same amount. Amounts were already
exact to the agora — only the dates were wrong.

These tests drive the two block-level helpers directly (_block_charge_date,
_apply_charge_date) rather than a synthetic PDF: the real statement is customer
financial data and stays out of git.

    python3 -m unittest test_installments
"""
from __future__ import annotations

import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "vendor"))
sys.path.insert(0, _HERE)

from parse_leumi_pdf import (  # noqa: E402
    INSTALLMENT_RE,
    Txn,
    _apply_charge_date,
    _block_charge_date,
    _parse_domestic_section,
    _statement_date,
)

CHARGE = "2026-05-15"


def txn(date: str, note: str = "", merchant: str = "בית עסק", amount: int = 1000) -> Txn:
    return Txn(
        date=date,
        merchant=merchant,
        amount_agorot=amount,
        source_label="max-1-domestic",
        dedup_key="",
        note=note,
    )


class TestInstallmentDetection(unittest.TestCase):
    def test_both_wordings_are_detected(self):
        """Ground truth from the real statement — RTL extraction reorders the
        credit wording, so 'קרדיט' lands between תשלום and the numbers."""
        for note in ["תשלום 8 מתוך 12", "תשלום - קרדיט 6 מתוך 13", "תשלום 2 מתוך 2"]:
            self.assertIsNotNone(INSTALLMENT_RE.search(note), note)

    def test_non_installment_notes_are_not_matched(self):
        for note in ["", "עסקת חו\"ל", "ביטול עסקה", "תשלום חודשי", "הוראת קבע", "12 מתוך 8 פריטים"]:
            self.assertIsNone(INSTALLMENT_RE.search(note), note)


class TestApplyChargeDate(unittest.TestCase):
    def test_installment_row_gets_charge_date_and_keeps_deal_date_in_note(self):
        rows = [txn("2025-09-28", "תשלום 8 מתוך 12")]
        _apply_charge_date(rows, CHARGE)
        self.assertEqual(rows[0].date, CHARGE)
        self.assertIn("עסקה מקורית: 2025-09-28", rows[0].note)
        self.assertIn("תשלום 8 מתוך 12", rows[0].note)  # badge text survives
        self.assertFalse(rows[0].undated_installment)

    def test_kredit_wording_is_redated_too(self):
        rows = [txn("2025-11-15", "תשלום - קרדיט 6 מתוך 13")]
        _apply_charge_date(rows, CHARGE)
        self.assertEqual(rows[0].date, CHARGE)

    def test_non_installment_rows_keep_their_deal_date(self):
        """A regular row's printed date IS its charge for this cycle."""
        rows = [txn("2026-04-14", ""), txn("2026-04-15", "ביטול עסקה")]
        _apply_charge_date(rows, CHARGE)
        self.assertEqual([r.date for r in rows], ["2026-04-14", "2026-04-15"])
        self.assertNotIn("עסקה מקורית", rows[0].note)

    def test_undated_installment_rows_are_flagged_not_guessed(self):
        """No charge date anywhere ⇒ keep the deal date and flag it. The flag is
        a non-blocking note app-side; the admin corrects the date in place."""
        rows = [txn("2025-09-28", "תשלום 8 מתוך 12"), txn("2026-04-14", "")]
        _apply_charge_date(rows, None, None)
        self.assertTrue(rows[0].undated_installment)
        self.assertEqual(rows[0].date, "2025-09-28")  # untouched
        self.assertFalse(rows[1].undated_installment)  # not an installment

    def test_substitution_changes_no_amount(self):
        rows = [txn("2025-09-28", "תשלום 8 מתוך 12", amount=53386), txn("2026-04-14", "", amount=7200)]
        before = sum(r.amount_agorot for r in rows)
        _apply_charge_date(rows, CHARGE)
        self.assertEqual(sum(r.amount_agorot for r in rows), before)

    def test_row_already_on_the_charge_date_is_not_annotated(self):
        """Re-dating to the same date would add a pointless 'עסקה מקורית' note."""
        rows = [txn(CHARGE, "תשלום 3 מתוך 6")]
        _apply_charge_date(rows, CHARGE)
        self.assertEqual(rows[0].note, "תשלום 3 מתוך 6")


class TestStatementDateFallback(unittest.TestCase):
    """Owner rule (2026-08-04): a missing charge date must never block the
    report. Chain is block date → statement header date → the deal date it has,
    and the admin can override any of them with the date editor."""

    def test_statement_date_is_used_when_the_block_has_none(self):
        rows = [txn("2025-09-28", "תשלום 8 מתוך 12")]
        _apply_charge_date(rows, None, CHARGE)
        self.assertEqual(rows[0].date, CHARGE)
        self.assertFalse(rows[0].undated_installment)  # not blocked, not flagged

    def test_a_fallback_date_says_so_in_the_note(self):
        """The admin must be able to tell an inferred date from a printed one."""
        rows = [txn("2025-09-28", "תשלום 8 מתוך 12")]
        _apply_charge_date(rows, None, CHARGE)
        self.assertIn("תאריך לפי כותרת הדוח", rows[0].note)
        self.assertIn("עסקה מקורית: 2025-09-28", rows[0].note)

    def test_the_blocks_own_date_wins_over_the_statement_date(self):
        rows = [txn("2025-09-28", "תשלום 8 מתוך 12")]
        _apply_charge_date(rows, "2026-04-15", CHARGE)
        self.assertEqual(rows[0].date, "2026-04-15")
        self.assertNotIn("כותרת הדוח", rows[0].note)

    def test_only_a_statement_with_no_date_at_all_leaves_the_deal_date(self):
        rows = [txn("2025-09-28", "תשלום 8 מתוך 12")]
        _apply_charge_date(rows, None, None)
        self.assertEqual(rows[0].date, "2025-09-28")
        self.assertTrue(rows[0].undated_installment)


class TestFallbackRespectsBlockBoundaries(unittest.TestCase):
    """The header date may only stand in when it cannot be contradicted.

    A statement with an early-repayment subtotal (charged D1) plus the regular
    cycle (charged D2) has one header date describing ONE of them. Using it for
    the other files those rows under the wrong month with no flag — this
    feature's own bug, re-created by its own fallback (Codex, PR #48).
    """

    def _section(self, lines: list[str]):
        return _parse_domestic_section(lines, 0, len(lines), "max-1-domestic", "2026-05-15")

    def _row_lines(self, date: str, merchant: str, amount: str, note_n: str) -> list[str]:
        # date → blank → card-type → merchant → category → tx amt → charge amt
        # → installment note (the shape _read_domestic_row walks).
        return [date, "", "אינט", merchant, "שונות", amount, amount, f"תשלום {note_n}", "מתוך", "12"]

    def test_multi_block_statement_gets_no_header_fallback(self):
        lines = (
            self._row_lines("28/09/25", "תאילנד", "533.86", "8")
            + ['לתאריך חיוב סה"כ', "533.86"]  # block 1: NO date, only a total
            + self._row_lines("29/09/25", "סופר", "199.00", "2")
            + ['לתאריך חיוב סה"כ', "15/05/26", "199.00"]  # block 2: dated
        )
        txns, _ = self._section(lines)
        by_merchant = {t.merchant: t for t in txns}
        first = by_merchant["תאילנד"]
        # Block 1 lost its date and must NOT borrow block 2's cycle.
        self.assertEqual(first.date, "2025-09-28", "borrowed a date across blocks")
        self.assertTrue(first.undated_installment, "wrong month shipped unflagged")
        self.assertNotIn("כותרת הדוח", first.note)
        # Block 2 has its own date and still re-dates normally.
        self.assertEqual(by_merchant["סופר"].date, "2026-05-15")
        self.assertFalse(by_merchant["סופר"].undated_installment)

    def test_single_block_statement_still_gets_the_header_fallback(self):
        """The common case — one cycle, so the header cannot be contradicted."""
        lines = self._row_lines("28/09/25", "תאילנד", "533.86", "8") + [
            'לתאריך חיוב סה"כ',
            "533.86",  # no date in the block
        ]
        txns, _ = self._section(lines)
        self.assertEqual(txns[0].date, "2026-05-15")
        self.assertFalse(txns[0].undated_installment)
        self.assertIn("כותרת הדוח", txns[0].note)


class TestStatementDate(unittest.TestCase):
    def test_reads_the_header_date(self):
        """Real layout, observed at lines 16-17 of an Isracard export."""
        lines = ["לתאריך: פעולותיך פרוט", "15/05/26", "הינו שבחרת החיוב מועד"]
        self.assertEqual(_statement_date(lines), "2026-05-15")

    def test_does_not_pick_up_a_block_footer_instead_of_the_header(self):
        """'לתאריך חיוב סה"כ' also contains לתאריך — a bare substring match
        would return the LAST block's date as the statement date."""
        lines = ['לתאריך חיוב סה"כ', "15/05/26"]
        self.assertIsNone(_statement_date(lines))

    def test_none_when_the_statement_has_no_header_date(self):
        self.assertIsNone(_statement_date(["לכבוד", "דיין דוד", "סמ הריקמה"]))


class TestBlockChargeDate(unittest.TestCase):
    def test_reads_the_date_between_the_label_and_the_total(self):
        lines = ['לתאריך חיוב סה"כ', "15/05/26", "5,780.73"]
        self.assertEqual(_block_charge_date(lines, 0, len(lines)), "2026-05-15")

    def test_missing_block_date_never_steals_the_next_rows_deal_date(self):
        """The scan stops at the block's own total. Without that bound it would
        walk into the next transaction's date line and return a DEAL date as
        the charge date — silently re-dating rows to something wrong, with no
        undated flag raised (plan Rev 3, Codex P1-e)."""
        lines = ['לתאריך חיוב סה"כ', "5,780.73", "28/09/25", "תאילנד למטייל המרכז"]
        self.assertIsNone(_block_charge_date(lines, 0, len(lines)))

    def test_no_date_and_no_total_in_window_is_none(self):
        lines = ['לתאריך חיוב סה"כ', "", "אוחנה ל:אליהו"]
        self.assertIsNone(_block_charge_date(lines, 0, len(lines)))


class TestPerBlockAssignment(unittest.TestCase):
    """Rows on either side of an early-repayment subtotal belong to different
    charge cycles; a single statement-wide date would re-create the very
    wrong-month error this fixes (plan Rev 2, Codex P1-a)."""

    def test_installment_rows_take_their_own_blocks_charge_date(self):
        block1 = [txn("2025-09-28", "תשלום 8 מתוך 12")]
        block2 = [txn("2025-11-15", "תשלום - קרדיט 6 מתוך 13")]
        _apply_charge_date(block1, "2026-04-15")
        _apply_charge_date(block2, "2026-05-15")
        self.assertEqual(block1[0].date, "2026-04-15")
        self.assertEqual(block2[0].date, "2026-05-15")

    def test_one_undated_block_does_not_affect_the_other(self):
        block1 = [txn("2025-09-28", "תשלום 8 מתוך 12")]
        block2 = [txn("2025-11-15", "תשלום 6 מתוך 13")]
        _apply_charge_date(block1, None, None)
        _apply_charge_date(block2, CHARGE)
        self.assertTrue(block1[0].undated_installment)
        self.assertFalse(block2[0].undated_installment)
        self.assertEqual(block2[0].date, CHARGE)


if __name__ == "__main__":
    unittest.main()
