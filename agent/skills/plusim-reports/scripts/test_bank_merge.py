# -*- coding: utf-8 -*-
"""Named tests for the per-day merge of overlapping bank exports
(docs/plans/scale-large-statements.md A1, Verification — Rev 3, Codex rounds 1-2).

All data is synthetic and generated here (no PII). Each export is a slice of ONE
master ledger, so balances are consistent exactly as a real bank export's are.

    python3 -m unittest test_bank_merge
"""
from __future__ import annotations

import collections
import datetime
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
import sys

sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "vendor"))
sys.path.insert(0, _HERE)

import bank_rows as BR  # noqa: E402
import parse_bank_pdf as B  # noqa: E402
import run_job as R  # noqa: E402
from parse_isracard_xlsx import ParseResult, Txn  # noqa: E402

ZWSP = "​"
LEUMI_REFS = {"שכר": "74677", "הוראת קבע": "34685", "חשמל": "12099", "בונוס": "55120", "ביט": "90210"}


def fmt(agorot: int) -> str:
    a = abs(agorot)
    return f"{a // 100:,}.{a % 100:02d}"


def sfmt(agorot: int) -> str:
    return ("-" if agorot < 0 else "") + fmt(agorot)


def dmy(iso: str, sep: str = "/", full: bool = True) -> str:
    y, m, d = iso.split("-")
    return f"{d}{sep}{m}{sep}{y if full else y[2:]}"


def master(spec, newest_balance=500_000):
    """spec: newest-first [(iso_date, description, pipeline_amount)] → rows with the
    running balance AFTER each row (older balance = newer balance + newer amount)."""
    rows, bal = [], newest_balance
    for date, desc, amount in spec:
        rows.append({"date": date, "desc": desc, "amount": amount, "bal": bal})
        bal = bal + amount
    return rows


def days(rows, lo, hi):
    return [r for r in rows if lo <= r["date"] <= hi]


def hapoalim_text(rows, lo, hi):
    head = ["8454161812", "תנועות בחשבון", "06/10/2026 *2407 / 03-6532407bankhapoalim.co.il"]
    if lo and hi:
        head.append(f"{dmy(hi)}-{dmy(lo)}")  # the real print puts the END first
    lines = [
        f"{dmy(r['date'])}{r['desc']}{fmt(r['amount'])}₪{sfmt(r['bal'])}##{1 if r['amount'] < 0 else 2}"
        for r in rows
    ]
    return "\n".join(head + lines) + "\n"


def leumi_text(rows, lo, hi):
    head = [" תנועות בחשבון| בנק לאומי", f"{ZWSP}930-42497/62{ZWSP} : מס' חשבון"]
    if lo and hi:
        head.append(f"בין התאריכים{dmy(lo, '.', False)}-{dmy(hi, '.', False)}")
    lines = []
    for r in rows:
        ref = LEUMI_REFS[r["desc"]]
        bal = (ZWSP if r["bal"] < 0 else "") + sfmt(r["bal"])
        lines.append(f"{dmy(r['date'])}{dmy(r['date'])}{r['desc']}{ref}{fmt(r['amount'])}{bal} ")
    return "\n".join(head + lines) + "\n"


class _Page:
    def __init__(self, t):
        self.t = t

    def extract_text(self):
        return self.t


def parse(text):
    class Rd:
        def __init__(self, _p):
            self.pages = [_Page(text)]

    with mock.patch.object(B, "PdfReader", Rd):
        return B.parse_bank_pdf("x.pdf")


def ident(t):
    return (t.date, t.merchant, t.amount_agorot, t.balance_agorot)


def ident_master(r):
    return (r["date"], r["desc"], r["amount"], r["bal"])


def merged_multiset(*results):
    return collections.Counter(ident(t) for r in results for t in r.transactions)


# A 6-day ledger, newest first, two rows a day, constant sign per description.
SPEC = []
for i, day in enumerate(["2026-05-06", "2026-05-05", "2026-05-04", "2026-05-03", "2026-05-02", "2026-05-01"]):
    SPEC += [(day, "ביט", 1000 + 10 * i), (day, "שכר", -(20000 + 100 * i))]
SPEC += [("2026-04-30", "חשמל", 7300), ("2026-04-30", "שכר", -19900)]
LEDGER = master(SPEC)


class _BothBanks:
    """Run each scenario against BOTH banks' text layouts."""

    bank = ""

    def text(self, rows, lo, hi):  # pragma: no cover - overridden
        raise NotImplementedError

    def export(self, rows, lo, hi):
        return parse(self.text(rows, lo, hi))


class TestOverlapMerge(_BothBanks, unittest.TestCase):
    def text(self, rows, lo, hi):
        return hapoalim_text(rows, lo, hi) if self.bank == "hapoalim" else leumi_text(rows, lo, hi)

    def run_both(self, fn):
        for bank in ("hapoalim", "leumi"):
            self.bank = bank
            with self.subTest(bank=bank):
                fn()

    # -- the E1 failure, rebuilt on day boundaries ---------------------------
    def test_overlapping_day_aligned_exports_are_not_double_counted(self):
        def go():
            newer = self.export(days(LEDGER, "2026-05-03", "2026-05-06"), "2026-05-03", "2026-05-06")
            older = self.export(days(LEDGER, "2026-04-30", "2026-05-04"), "2026-04-30", "2026-05-04")
            notes, warns, removed = BR.merge_bank_exports([("older.pdf", older), ("newer.pdf", newer)])
            self.assertEqual(removed, 4)  # 2 shared days × 2 rows
            want = collections.Counter(ident_master(r) for r in LEDGER)
            # the newer export (latest `to`) supplies the shared days
            self.assertEqual(merged_multiset(older, newer), want)
            keys = [t.dedup_key for r in (older, newer) for t in r.transactions]
            self.assertEqual(len(keys), len(set(keys)))
            self.assertEqual(warns, [])
            self.assertEqual(len(notes), 1)

        self.run_both(go)

    def test_overlap_note_names_both_files_and_count(self):
        def go():
            newer = self.export(days(LEDGER, "2026-05-03", "2026-05-06"), "2026-05-03", "2026-05-06")
            older = self.export(days(LEDGER, "2026-04-30", "2026-05-04"), "2026-04-30", "2026-05-04")
            notes, _w, removed = BR.merge_bank_exports([("older.pdf", older), ("newer.pdf", newer)])
            self.assertIn("older.pdf", notes[0])
            self.assertIn("newer.pdf", notes[0])
            self.assertIn(str(removed), notes[0])

        self.run_both(go)

    def test_contained_file_adds_nothing(self):
        def go():
            big = self.export(LEDGER, "2026-04-30", "2026-05-06")
            small = self.export(days(LEDGER, "2026-05-02", "2026-05-04"), "2026-05-02", "2026-05-04")
            _n, _w, removed = BR.merge_bank_exports([("big.pdf", big), ("small.pdf", small)])
            self.assertEqual(removed, 6)
            self.assertEqual(small.transactions, [])
            self.assertEqual(merged_multiset(big, small), collections.Counter(ident_master(r) for r in LEDGER))

        self.run_both(go)

    def test_same_file_twice_adds_nothing(self):
        def go():
            a = self.export(LEDGER, "2026-04-30", "2026-05-06")
            b = self.export(LEDGER, "2026-04-30", "2026-05-06")
            _n, _w, removed = BR.merge_bank_exports([("a.pdf", a), ("b.pdf", b)])
            self.assertEqual(removed, len(LEDGER))
            self.assertEqual(merged_multiset(a, b), collections.Counter(ident_master(r) for r in LEDGER))

        self.run_both(go)

    # -- Codex round 1, P1: repeating balances -------------------------------
    def test_split_export_with_repeating_balance_keeps_both_purchases(self):
        """purchase → 9,000 · refund → 10,000 · identical second purchase → 9,000,
        all on one day, inside two overlapping day-aligned exports: all three rows
        survive and their keys stay unique."""
        # newest-first on the shared day: P2, R, P1
        spec = [("2026-05-06", "ביט", 1000), ("2026-05-05", "ביט", 1000), ("2026-05-05", "שכר", -1000),
                ("2026-05-05", "ביט", 1000), ("2026-05-04", "שכר", -5000), ("2026-05-04", "ביט", 2000)]
        led = master(spec, newest_balance=9_000)
        p1, p2 = [r for r in led if r["date"] == "2026-05-05" and r["desc"] == "ביט"]
        self.assertEqual((p1["amount"], p1["bal"]), (p2["amount"], p2["bal"]))  # the repeating shape

        def go():
            newer = self.export(days(led, "2026-05-05", "2026-05-06"), "2026-05-05", "2026-05-06")
            older = self.export(days(led, "2026-05-04", "2026-05-05"), "2026-05-04", "2026-05-05")
            BR.merge_bank_exports([("older.pdf", older), ("newer.pdf", newer)])
            self.assertEqual(merged_multiset(older, newer), collections.Counter(ident_master(r) for r in led))
            keys = [t.dedup_key for r in (older, newer) for t in r.transactions]
            self.assertEqual(len(keys), len(set(keys)), "the repeated purchase needs its own key")

        self.run_both(go)

    def test_adjacent_exports_with_identical_same_day_pair_keep_both_rows(self):
        spec = [("2026-05-04", "חשמל", 500), ("2026-05-03", "ביט", 1000), ("2026-05-03", "ביט", 1000),
                ("2026-05-02", "שכר", -9000), ("2026-05-02", "שכר", -8000)]
        led = master(spec, newest_balance=40_000)

        def go():
            newer = self.export(days(led, "2026-05-03", "2026-05-04"), "2026-05-03", "2026-05-04")
            older = self.export(days(led, "2026-05-02", "2026-05-02"), "2026-05-02", "2026-05-02")
            _n, warns, removed = BR.merge_bank_exports([("older.pdf", older), ("newer.pdf", newer)])
            self.assertEqual(removed, 0)
            self.assertEqual(warns, [])
            self.assertEqual(merged_multiset(older, newer), collections.Counter(ident_master(r) for r in led))
            self.assertEqual(sum(1 for r in (older, newer) for t in r.transactions if t.merchant == "ביט"), 2)

        self.run_both(go)

    def test_row_count_split_inside_a_day_refuses_naming_files_and_day(self):
        """Codex's example as a mid-day split between two contiguous slices of ONE
        ledger (so each export's own balances are valid): the newer export ends
        its list inside 2026-05-05 after [P2, R]; the older starts it with the
        identical second purchase P1. Both claim the day with different rows →
        ambiguous → refuse, never a silent drop of P1 as "the same as P2"."""
        spec = [("2026-05-06", "שכר", -20000),
                ("2026-05-05", "ביט", 1000), ("2026-05-05", "שכר", -1000), ("2026-05-05", "ביט", 1000),
                ("2026-05-04", "ביט", 2000), ("2026-05-04", "ביט", 2100)]
        led = master(spec, newest_balance=9_000)
        p2, r, p1 = led[1], led[2], led[3]
        self.assertEqual((p1["desc"], p1["amount"], p1["bal"]), (p2["desc"], p2["amount"], p2["bal"]))

        def go():
            newer = self.export(led[:3], "2026-05-05", "2026-05-06")  # 05-06, P2, R
            older = self.export(led[3:], "2026-05-04", "2026-05-05")  # P1, 05-04 rows
            byname = {"newer.pdf": newer, "older.pdf": older}
            for order in (("newer.pdf", "older.pdf"), ("older.pdf", "newer.pdf")):
                with self.assertRaises(BR.AmbiguousBankMergeError) as ctx:
                    BR.merge_bank_exports([(n, byname[n]) for n in order])
                msg = str(ctx.exception)
                self.assertIn("newer.pdf", msg)
                self.assertIn("older.pdf", msg)
                self.assertIn("2026-05-05", msg)

        self.run_both(go)

    def test_conflicting_content_on_a_shared_day_refuses(self):
        def go():
            a = self.export(days(LEDGER, "2026-05-04", "2026-05-06"), "2026-05-04", "2026-05-06")
            altered = [dict(r) for r in days(LEDGER, "2026-05-03", "2026-05-05")]
            # same day, one row's amount differs (and the balances re-derived)
            altered = master([(r["date"], r["desc"], r["amount"] + (7 if i == 2 else 0)) for i, r in enumerate(altered)],
                             newest_balance=altered[0]["bal"])
            b = self.export(altered, "2026-05-03", "2026-05-05")
            with self.assertRaises(BR.AmbiguousBankMergeError):
                BR.merge_bank_exports([("a.pdf", a), ("b.pdf", b)])

        self.run_both(go)

    def test_two_accounts_with_same_last4_refuse_instead_of_mixing(self):
        def go():
            other = master([(r["date"], r["desc"], r["amount"] * 2) for r in LEDGER], newest_balance=123_456)
            a = self.export(days(LEDGER, "2026-05-02", "2026-05-06"), "2026-05-02", "2026-05-06")
            b = self.export(days(other, "2026-05-01", "2026-05-04"), "2026-05-01", "2026-05-04")
            with self.assertRaises(BR.AmbiguousBankMergeError):
                BR.merge_bank_exports([("mine.pdf", a), ("theirs.pdf", b)])

        self.run_both(go)

    def test_earlier_export_partial_last_day_is_a_subsequence_and_merges(self):
        """The older export was generated mid-day on its last day: it holds only the
        OLDER part of that day (a suffix of the newest-first list)."""
        def go():
            newer = self.export(days(LEDGER, "2026-05-04", "2026-05-06"), "2026-05-04", "2026-05-06")
            day4 = [r for r in LEDGER if r["date"] == "2026-05-04"]
            older_rows = days(LEDGER, "2026-04-30", "2026-05-03") + []  # complete days before…
            partial = day4[1:]  # …and only the older part of 2026-05-04
            older = self.export(partial + older_rows, "2026-04-30", "2026-05-04")
            _n, warns, removed = BR.merge_bank_exports([("older.pdf", older), ("newer.pdf", newer)])
            self.assertEqual(removed, len(partial))
            self.assertEqual(warns, [])
            self.assertEqual(merged_multiset(older, newer), collections.Counter(ident_master(r) for r in LEDGER))

        self.run_both(go)

    def test_missing_printed_period_falls_back_to_row_range_and_never_removes(self):
        def go():
            a = self.export(days(LEDGER, "2026-05-03", "2026-05-06"), None, None)
            b = self.export(days(LEDGER, "2026-04-30", "2026-05-04"), None, None)
            self.assertEqual(a.periods, {})
            _n, _w, removed = BR.merge_bank_exports([("older.pdf", b), ("newer.pdf", a)])
            # row ranges: a=[05-03,05-06], b=[04-30,05-04]; days 05-03/04 are shared and equal
            self.assertEqual(removed, 4)
            self.assertEqual(merged_multiset(a, b), collections.Counter(ident_master(r) for r in LEDGER))
            # an export whose TRUE period starts earlier than its first row is under-claimed:
            # the earlier days come only from the other export — nothing is removed for them.
            d = [t for t in b.transactions if t.date <= "2026-05-02"]
            self.assertTrue(d, "b still supplies its own early days")

        self.run_both(go)

    def test_gap_between_exports_is_a_warning_naming_the_date(self):
        def go():
            newer = self.export(days(LEDGER, "2026-05-05", "2026-05-06"), "2026-05-05", "2026-05-06")
            older = self.export(days(LEDGER, "2026-04-30", "2026-05-02"), "2026-04-30", "2026-05-02")
            _n, warns, removed = BR.merge_bank_exports([("older.pdf", older), ("newer.pdf", newer)])
            self.assertEqual(removed, 0)
            joined = " ".join(warns)
            self.assertIn("2026-05-03", joined)  # uncovered range start
            self.assertIn("2026-05-04", joined)  # uncovered range end
            self.assertTrue(any("חסרות תנועות אחרי" in w for w in warns), warns)  # chain gap

        self.run_both(go)

    def test_contiguous_adjacent_exports_have_no_gap_warning(self):
        def go():
            newer = self.export(days(LEDGER, "2026-05-03", "2026-05-06"), "2026-05-03", "2026-05-06")
            older = self.export(days(LEDGER, "2026-04-30", "2026-05-02"), "2026-04-30", "2026-05-02")
            _n, warns, _r = BR.merge_bank_exports([("older.pdf", older), ("newer.pdf", newer)])
            self.assertEqual(warns, [])

        self.run_both(go)

    def test_single_export_is_untouched(self):
        def go():
            a = self.export(LEDGER, "2026-04-30", "2026-05-06")
            n, w, removed = BR.merge_bank_exports([("a.pdf", a)])
            self.assertEqual((n, w, removed), ([], [], 0))
            self.assertEqual(len(a.transactions), len(LEDGER))

        self.run_both(go)

    def test_card_results_are_ignored_by_the_merge(self):
        card = ParseResult()
        card.transactions = [Txn("2026-05-01", "x", 100, "max-1-billed", "k")]
        card.source_totals = {"max-1-billed": 100}
        n, w, removed = BR.merge_bank_exports([("a.pdf", card), ("b.pdf", card)])
        self.assertEqual((n, w, removed), ([], [], 0))
        self.assertEqual(len(card.transactions), 1)


class TestLeumiIncompleteDays(unittest.TestCase):
    """Codex round 2, P2: the export with the latest `to` may be the one that
    excluded its oldest row; the older export holds it."""

    def ledger(self):
        # unique descriptions at the seam so the newer export cannot derive its
        # oldest row from a sibling and must exclude it
        spec = [("2026-05-06", "ביט", 900), ("2026-05-06", "שכר", -20000),
                ("2026-05-05", "חשמל", 7300), ("2026-05-05", "בונוס", -3000),
                ("2026-05-04", "שכר", -19000), ("2026-05-04", "ביט", 800),
                ("2026-05-03", "שכר", -18000), ("2026-05-03", "הוראת קבע", 4000),
                ("2026-05-02", "שכר", -17000), ("2026-05-02", "ביט", 700)]
        return master(spec)

    def test_parser_reports_incomplete_days_for_excluded_rows(self):
        led = self.ledger()
        # a slice whose oldest row (בונוס) has no sibling
        rows = days(led, "2026-05-05", "2026-05-06")
        res = parse(leumi_text(rows, "2026-05-05", "2026-05-06"))
        self.assertEqual(res.incomplete_days, {"leumi-9762": {"2026-05-05"}})
        self.assertEqual(len(res.transactions), len(rows) - 1)
        self.assertTrue(any("excluded" in w for w in res.warnings))
        # a slice whose oldest row has a sibling excludes nothing
        ok = parse(leumi_text(days(led, "2026-05-02", "2026-05-06"), "2026-05-02", "2026-05-06"))
        self.assertEqual(ok.incomplete_days, {})

    def test_leumi_oldest_row_present_in_neighbour_file_is_kept(self):
        """The INCOMPLETE export has the latest `to` — the older export supplies the
        day and the excluded row is recovered (not refused)."""
        led = self.ledger()
        newer = parse(leumi_text(days(led, "2026-05-05", "2026-05-06"), "2026-05-05", "2026-05-06"))
        older = parse(leumi_text(days(led, "2026-05-02", "2026-05-05"), "2026-05-02", "2026-05-05"))
        self.assertEqual(newer.incomplete_days, {"leumi-9762": {"2026-05-05"}})
        _n, warns, removed = BR.merge_bank_exports([("older.pdf", older), ("newer.pdf", newer)])
        self.assertEqual(warns, [])
        self.assertEqual(
            merged_multiset(older, newer),
            collections.Counter(ident_master(r) for r in days(led, "2026-05-02", "2026-05-06")),
        )
        self.assertTrue(any(t.merchant == "בונוס" for t in older.transactions), "recovered from the older export")
        self.assertEqual(removed, 1)  # only newer's surviving 05-05 row (חשמל) is not counted twice

    def test_all_covering_exports_incomplete_keeps_latest_and_warns(self):
        led = self.ledger()
        # two exports that both end (oldest side) on 2026-05-05 and both exclude בונוס
        a = parse(leumi_text(days(led, "2026-05-05", "2026-05-06"), "2026-05-05", "2026-05-06"))
        b = parse(leumi_text(days(led, "2026-05-05", "2026-05-06"), "2026-05-05", "2026-05-06"))
        _n, _warns, _r = BR.merge_bank_exports([("a.pdf", a), ("b.pdf", b)])
        # no export has the row: it stays out, and the exclusion stays VISIBLE as the
        # per-file parse warning that cmd_prepare folds into agentNotes (the merge
        # cannot call the overall-oldest row a gap — it cannot know it is not the oldest)
        self.assertTrue(all(t.merchant != "בונוס" for r in (a, b) for t in r.transactions))
        for r in (a, b):
            self.assertTrue(any("oldest row" in w and "excluded" in w for w in r.warnings), r.warnings)
        self.assertEqual(len(a.transactions) + len(b.transactions), 3)  # one export supplies the day


class TestPeriodParsing(unittest.TestCase):
    def test_period_parsed_from_hapoalim_and_leumi_headers(self):
        h = parse(hapoalim_text(LEDGER, "2026-04-30", "2026-05-06"))
        self.assertEqual(h.periods, {"hapoalim-1812": ("2026-04-30", "2026-05-06")})
        lm = parse(leumi_text(LEDGER, "2026-04-30", "2026-05-06"))
        self.assertEqual(lm.periods, {"leumi-9762": ("2026-04-30", "2026-05-06")})
        # the print direction differs by export: min/max, never positional
        rev = hapoalim_text(LEDGER, "2026-04-30", "2026-05-06").replace(
            f"{dmy('2026-05-06')}-{dmy('2026-04-30')}", f"{dmy('2026-04-30')}-{dmy('2026-05-06')}"
        )
        self.assertEqual(parse(rev).periods, {"hapoalim-1812": ("2026-04-30", "2026-05-06")})

    def test_dedup_key_includes_the_running_balance_and_repeats_get_a_suffix(self):
        led = master([("2026-05-05", "ביט", 1000), ("2026-05-05", "שכר", -1000), ("2026-05-05", "ביט", 1000)], 9_000)
        res = parse(hapoalim_text(led, "2026-05-05", "2026-05-05"))
        keys = [t.dedup_key for t in res.transactions]
        self.assertEqual(keys[0], f"hapoalim-1812|2026-05-05|ביט|1000|9000")
        self.assertEqual(keys[1], f"hapoalim-1812|2026-05-05|שכר|-1000|10000")
        self.assertEqual(keys[2], f"hapoalim-1812|2026-05-05|ביט|1000|9000|2")  # the exact repeat
        self.assertEqual([t.balance_agorot for t in res.transactions], [9000, 10000, 9000])


class TestDiscount(unittest.TestCase):
    def test_discount_fallback_key_includes_balance(self):
        import openpyxl

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "עובר ושב"
        ws.append(["חשבון: 0123-456789 | שם"])
        ws.append(["תנועות אחרונות"])
        ws.append(["תאריך", "יום ערך", "תיאור התנועה", "זכות/חובה", "יתרה", "אסמכתה", "עמלה", "ערוץ"])
        d = datetime.datetime(2026, 5, 3)
        ws.append([d, d, "חשמל", -10.0, 90.0, "", "", "אינטרנט"])
        ws.append([d, d, "חשמל", -10.0, 100.0, "", "", "אינטרנט"])
        path = os.path.join(tempfile.mkdtemp(), "d.xlsx")
        wb.save(path)
        import parse_discount_xlsx as D

        res = D.parse_discount_xlsx(path)
        keys = [t.dedup_key for t in res.transactions]
        self.assertEqual(len(set(keys)), 2, keys)
        self.assertTrue(all(k.endswith(("|9000", "|10000")) for k in keys), keys)
        self.assertEqual([t.balance_agorot for t in res.transactions], [9000, 10000])
        self.assertEqual(res.bank_labels, {"discount-6789"})


def _discount_xlsx(rows):
    """rows: [(date, description, amount, balance_or_None, voucher)] → a Discount export."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "עובר ושב"
    ws.append(["חשבון: 0123-456789 | שם"])
    ws.append(["תנועות אחרונות"])
    ws.append(["תאריך", "יום ערך", "תיאור התנועה", "זכות/חובה", "יתרה", "אסמכתה", "עמלה", "ערוץ"])
    for d, desc, amount, bal, voucher in rows:
        ws.append([d, d, desc, amount, bal, voucher, "", "אינטרנט"])
    path = os.path.join(tempfile.mkdtemp(), "d.xlsx")
    wb.save(path)
    import parse_discount_xlsx as D

    return D.parse_discount_xlsx(path)


class TestDiscountVoucherIdentity(unittest.TestCase):
    """Codex PR-1 review, P1: the voucher is part of a row's cross-export identity."""

    DAY = datetime.datetime(2026, 5, 3)

    def test_same_day_withdrawals_with_different_vouchers_refuse_when_balance_is_absent(self):
        a = _discount_xlsx([(self.DAY, "משיכת מזומן", -400.0, None, "111")])
        b = _discount_xlsx([(self.DAY, "משיכת מזומן", -400.0, None, "222")])
        self.assertEqual([t.balance_agorot for t in a.transactions + b.transactions], [None, None])
        with self.assertRaises(BR.AmbiguousBankMergeError):
            BR.merge_bank_exports([("a.xlsx", a), ("b.xlsx", b)])
        # nothing was removed before the refusal
        self.assertEqual((len(a.transactions), len(b.transactions)), (1, 1))

    def test_same_voucher_is_the_same_row_and_merges(self):
        a = _discount_xlsx([(self.DAY, "משיכת מזומן", -400.0, None, "111")])
        b = _discount_xlsx([(self.DAY, "משיכת מזומן", -400.0, None, "111")])
        _n, _w, removed = BR.merge_bank_exports([("a.xlsx", a), ("b.xlsx", b)])
        self.assertEqual(removed, 1)
        self.assertEqual(len(a.transactions) + len(b.transactions), 1)

    def test_distinct_vouchers_in_both_exports_of_the_same_day_are_kept_in_order(self):
        rows = [(self.DAY, "משיכת מזומן", -400.0, None, "222"), (self.DAY, "משיכת מזומן", -400.0, None, "111")]
        a = _discount_xlsx(rows)
        b = _discount_xlsx(rows)
        _n, _w, removed = BR.merge_bank_exports([("a.xlsx", a), ("b.xlsx", b)])
        self.assertEqual(removed, 2)
        self.assertEqual(sorted(t.voucher for r in (a, b) for t in r.transactions), ["111", "222"])


class TestPrepareIntegration(unittest.TestCase):
    """cmd_prepare end to end on two overlapping Hapoalim exports."""

    def setUp(self):
        self.tmp = []

    def tearDown(self):
        for p in self.tmp:
            shutil.rmtree(p, ignore_errors=True)

    def run_prepare(self, texts, names=("older.pdf", "newer.pdf")):
        wd = tempfile.mkdtemp(prefix="plusim-job-", dir="/tmp")
        clean = os.path.join("/tmp", "plusim-job-" + "".join(c for c in os.path.basename(wd)[11:] if c.isalnum()) + "M")
        os.rename(wd, clean)
        self.tmp.append(clean)
        by_name = {}
        files = []
        for n, text in zip(names, texts):
            src = os.path.join(clean, "src-" + n)
            os.makedirs(clean, exist_ok=True)
            with open(src, "wb") as f:
                f.write(b"%PDF-fake")
            by_name[n] = text
            files.append({"name": n, "path": src, "mime": "application/pdf"})
        tax = [{"section": "בית", "leaves": ["חשמל"]}, {"section": "הכנסות", "leaves": ["משכורת 1"]}]
        man = {"job": {"id": "m"}, "taxonomy": tax, "merchantDictionary": [], "reportRules": "", "files": files,
               "callback": {"resultUrl": f"file://{clean}/posted.json"}}
        mpath = os.path.join(clean, "m.json")
        with open(mpath, "w") as f:
            json.dump(man, f)

        class Rd:
            def __init__(self, path):
                self.pages = [_Page(by_name[os.path.basename(path)])]

        out = []
        with mock.patch.object(B, "PdfReader", Rd), mock.patch.object(R, "PdfReader", Rd), mock.patch(
            "builtins.print", lambda *a, **k: out.append(a[0])
        ):
            R.cmd_prepare(mock.Mock(workdir=clean, manifest_file=mpath, manifest_url=None))
        summary = json.loads(out[-1])
        with open(os.path.join(clean, "state.json"), encoding="utf-8") as f:
            return clean, summary, json.load(f)

    def test_prepare_merges_overlapping_exports_and_finalize_is_clean(self):
        newer = hapoalim_text(days(LEDGER, "2026-05-03", "2026-05-06"), "2026-05-03", "2026-05-06")
        older = hapoalim_text(days(LEDGER, "2026-04-30", "2026-05-04"), "2026-04-30", "2026-05-04")
        wd, summary, state = self.run_prepare([older, newer])
        self.assertEqual(summary["bankOverlapRemoved"], 4)
        self.assertEqual(len(state["txns"]) + len(state["settlements"]), len(LEDGER))
        keys = [t["dedupKey"] for t in state["txns"]]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(any("לא נספרו פעמיים" in w for w in state["warnings"]))
        self.assertFalse(any("duplicate source label" in w for w in state["warnings"]))
        with mock.patch("builtins.print"):
            R.cmd_finalize(mock.Mock(workdir=wd, dry_run=True))
        with open(os.path.join(wd, "result.json"), encoding="utf-8") as f:
            result = json.load(f)
        self.assertEqual(len(result["transactions"]), len(state["txns"]))
        self.assertNotIn("duplicate dedupKey", result["agentNotes"] or "")

    def test_prepare_refuses_ambiguous_exports_naming_the_files(self):
        spec = [("2026-05-05", "ביט", 1000), ("2026-05-05", "שכר", -1000), ("2026-05-05", "ביט", 1000)]
        led = master(spec, 9_000)
        with self.assertRaises(BR.AmbiguousBankMergeError) as ctx:
            self.run_prepare(
                [hapoalim_text(led[1:], "2026-05-05", "2026-05-05"), hapoalim_text(led[:1], "2026-05-05", "2026-05-05")],
                names=("part-1.pdf", "part-2.pdf"),
            )
        self.assertIn("part-1.pdf", str(ctx.exception))
        self.assertIn("part-2.pdf", str(ctx.exception))

    def test_card_sources_still_warn_on_duplicate_label(self):
        def card(_p, _l, _n):
            r = ParseResult()
            r.transactions = [Txn("2026-05-01", "חנות", 100, "max-1-billed", "k1")]
            r.source_totals = {"max-1-billed": 100}
            return r

        with mock.patch.object(R, "parse_pdf_auto", card):
            _wd, _s, state = self.run_prepare(["a", "b"], names=("one.pdf", "two.pdf"))
        self.assertTrue(any("duplicate source label max-1-billed" in w for w in state["warnings"]), state["warnings"])


if __name__ == "__main__":
    unittest.main()
