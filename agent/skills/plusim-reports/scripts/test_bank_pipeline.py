# -*- coding: utf-8 -*-
"""Named tests for the kind-aware pipeline in run_job.py / verify_report.py and
the card parsers' charge cycles (docs/plans/bank-statements.md A2, A3, B2).

    python3 -m unittest test_bank_pipeline
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "vendor"))
sys.path.insert(0, _HERE)

import parse_leumi_pdf as L  # noqa: E402
import parse_max_pdf as M  # noqa: E402
import run_job as R  # noqa: E402
from parse_isracard_xlsx import ParseResult, Txn  # noqa: E402
from verify_report import verify  # noqa: E402

TAXONOMY = [
    {"section": "בית", "leaves": ["חשמל", "בריאות משלים", 'שכ"ד/משכנתא', "עמלות+ריביות", "הלוואות"]},
    {"section": "שונות", "leaves": ["העברות בנקאיות", "צ'קים ללא מעקב", "ביטוח לאומי"]},
    {"section": "הכנסות", "leaves": ["משכורת 1", "משכורת 2", "הכנסות נוספות", "קצבת ילדים"]},
]
LEAVES = {leaf for sec in TAXONOMY for leaf in sec["leaves"]}
INCOME = R.income_leaves(TAXONOMY)
SEP = R.CREDIT_KEY_SEP


def row(merchant, amount, kind="expense", source="hapoalim-1812", date="2026-09-10", **over):
    d = {
        "month": date[:7],
        "date": date,
        "merchant": merchant,
        "amountAgorot": amount,
        "category": None,
        "uncategorized": False,
        "sourceLabel": source,
        "note": "",
        "max_category": "",
        "dedupKey": f"{source}|{date}|{merchant}|{amount}|1",
        "kind": kind,
        "undatedInstallment": False,
    }
    d.update(over)
    return d


class TestCategorize(unittest.TestCase):
    def test_credit_rows_run_income_rules_only(self):
        rows = [row("קצבת ילדים", -20000, "credit"), row("בזק הוראת קבע", -5000, "credit")]
        short = R.categorize(rows, {}, LEAVES, INCOME)
        self.assertEqual((rows[0]["category"], rows[0]["kind"]), ("קצבת ילדים", "income"))
        # RULES would have placed "בזק" — a credit never takes an expense RULE.
        self.assertIsNone(rows[1]["category"])
        self.assertEqual([e["key"] for e in short], ["בזק הוראת קבע" + SEP + "credit"])
        self.assertEqual(short[0]["kind"], "credit")

    def test_expense_rules_never_place_a_credit(self):
        """The 12 שירותי בריאות credits are reimbursements: the model decides."""
        rows = [row("שירותי בריאות", -3000, "credit"), row("שירותי בריאות", 3000, "expense")]
        R.categorize(rows, {}, LEAVES, INCOME)
        self.assertIsNone(rows[0]["category"])
        self.assertEqual(rows[1]["category"], "בריאות משלים")

    def test_batuach_leumi_spelling_variant_is_income(self):
        rows = [row("בטוח לאומי חד", -150000, "credit"), row('"ביטוח לאומי ג', -150000, "credit")]
        R.categorize(rows, {}, LEAVES, INCOME)
        for r in rows:
            self.assertEqual((r["category"], r["kind"]), ("הכנסות נוספות", "income"), r["merchant"])

    def test_expense_rows_never_take_an_income_leaf(self):
        rows = [row("קצבת ילדים", 20000, "expense")]
        short = R.categorize(rows, {"קצבת ילדים": "קצבת ילדים"}, LEAVES, INCOME)
        self.assertIsNone(rows[0]["category"])
        self.assertEqual(short[0]["key"], "קצבת ילדים")

    def test_bank_debit_rules(self):
        rows = [
            row("לאומי למשכנתאו", 500000),
            row("פרעון הלוואה", 100000),
            row("ע.מפעולות-ישיר", 3850),
            row("12 עמל.ערוץ יש", 1980),
            row("שיק", 50000),
            row("העב' לאחר-נייד", 20000),
        ]
        R.categorize(rows, {}, LEAVES, INCOME)
        self.assertEqual(
            [r["category"] for r in rows],
            ['שכ"ד/משכנתא', "הלוואות", "עמלות+ריביות", "עמלות+ריביות", "צ'קים ללא מעקב", "העברות בנקאיות"],
        )

    def test_bidirectional_unresolved_counterparty_gets_two_judgments(self):
        rows = [row("X", 1000, "expense"), row("X", -1000, "credit")]
        short = R.categorize(rows, {}, LEAVES, INCOME)
        self.assertEqual(sorted(e["key"] for e in short), sorted(["X", "X" + SEP + "credit"]))
        self.assertEqual({e["kind"] for e in short}, {"expense", "credit"})


class _Workdir:
    def __init__(self):
        self.wd = tempfile.mkdtemp(prefix="plusim-job-", dir="/tmp")
        # safe_workdir wants /tmp/plusim-job-<alnum>; mkdtemp adds a random
        # alnum suffix, but may include "_" — normalize.
        clean = os.path.join("/tmp", "plusim-job-" + "".join(ch for ch in os.path.basename(self.wd)[11:] if ch.isalnum()) + "T")
        os.rename(self.wd, clean)
        self.wd = clean

    def write(self, name, obj):
        with open(os.path.join(self.wd, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)

    def read(self, name):
        with open(os.path.join(self.wd, name), encoding="utf-8") as f:
            return json.load(f)

    def cleanup(self):
        shutil.rmtree(self.wd, ignore_errors=True)


def finalize(txns, judgments, settlements=None, source_totals=None, cycles=None):
    w = _Workdir()
    try:
        w.write("manifest.json", {"job": {"id": "j1"}, "taxonomy": TAXONOMY, "callback": {"resultUrl": "unused"}})
        w.write(
            "state.json",
            {
                "txns": txns,
                "settlements": settlements or [],
                "sourceTotals": source_totals or {"hapoalim-1812": None},
                "chargeCycles": cycles or {},
                "warnings": [],
            },
        )
        w.write("judgments.json", judgments)
        args = mock.Mock(workdir=w.wd, dry_run=True)
        with mock.patch("builtins.print"):
            R.cmd_finalize(args)
        return w.read("result.json")
    finally:
        w.cleanup()


def by_merchant(payload):
    return {t["merchant"]: t for t in payload["transactions"]}


class TestFinalize(unittest.TestCase):
    def test_credit_judgment_requires_income_leaf_or_refund_flag(self):
        txns = [row("חברה א", -1000, "credit"), row("חברה ב", -1000, "credit"), row("חברה ג", -1000, "credit")]
        out = finalize(
            txns,
            {
                "חברה א" + SEP + "credit": {"category": "משכורת 1", "note": "salary"},
                "חברה ב" + SEP + "credit": {"category": "חשמל"},  # expense leaf, no refund flag
                "חברה ג" + SEP + "credit": {"category": "חשמל", "refund": True},
            },
        )
        t = by_merchant(out)
        self.assertEqual((t["חברה א"]["category"], t["חברה א"]["kind"]), ("משכורת 1", "income"))
        self.assertTrue(t["חברה ב"]["uncategorized"])
        self.assertIn("refund", t["חברה ב"]["note"])
        self.assertEqual(t["חברה ג"]["category"], "חשמל")

    def test_refund_credit_is_kind_expense(self):
        out = finalize(
            [row("שירותי בריאות", -3000, "credit")],
            {"שירותי בריאות" + SEP + "credit": {"category": "בריאות משלים", "refund": True}},
        )
        t = out["transactions"][0]
        self.assertEqual(t["category"], "בריאות משלים")
        self.assertNotIn("kind", t)  # expense is the omitted default
        self.assertEqual(t["amountAgorot"], -3000)
        self.assertEqual(out["status"], "ok")

    def test_credit_rows_propose_no_mappings(self):
        out = finalize(
            [row("מעסיק", -1900000, "credit"), row("חנות", 1000, "expense")],
            {
                "מעסיק" + SEP + "credit": {"category": "משכורת 1", "propose": True},
                "חנות": {"category": "חשמל", "propose": True},
            },
        )
        self.assertEqual([p["merchant"] for p in out["proposedMappings"]], ["חנות"])

    def test_expense_judgment_into_income_leaf_is_rejected(self):
        out = finalize([row("חנות", 1000, "expense")], {"חנות": {"category": "משכורת 1"}})
        t = out["transactions"][0]
        self.assertTrue(t["uncategorized"])
        self.assertNotIn("kind", t)

    def test_uncategorized_credit_is_sent_with_kind_credit(self):
        out = finalize([row("לא ידוע", -500, "credit")], {})
        t = out["transactions"][0]
        self.assertTrue(t["uncategorized"])
        self.assertEqual(t["kind"], "credit")

    def test_judgment_key_is_normalized_like_merchants(self):
        out = finalize([row("חברה  א", -1000, "credit")], {" חברה א " + SEP + "credit ": {"category": "משכורת 2"}})
        self.assertEqual(out["transactions"][0]["category"], "משכורת 2")

    def test_payload_carries_settlements_and_charge_cycles(self):
        settlements = [
            {"date": "2026-09-10", "month": "2026-09", "payee": "מקס איט פיננ-י", "amountAgorot": 1539514,
             "sourceLabel": "hapoalim-1812", "dedupKey": "hapoalim-1812|2026-09-10|מקס איט פיננ-י|1539514|1"}
        ]
        cycles = {"max-1-billed": [{"chargeDate": "2026-09-10", "amountAgorot": 1539514}]}
        out = finalize(
            [row("חנות", 1539514, "expense", source="max-1-billed", category="חשמל")],
            {},
            settlements=settlements,
            source_totals={"hapoalim-1812": None, "max-1-billed": 1539514},
            cycles=cycles,
        )
        self.assertEqual(out["settlements"], settlements)
        src = {s["label"]: s for s in out["sourceTotals"]}
        self.assertEqual(src["max-1-billed"]["chargeCycles"], cycles["max-1-billed"])
        self.assertNotIn("chargeCycles", src["hapoalim-1812"])
        self.assertEqual(out["status"], "ok")


class TestPrepareMovesSettlements(unittest.TestCase):
    def test_settlement_rows_leave_transactions(self):
        res = ParseResult()
        res.transactions = [
            Txn("2026-09-10", 'ישראכרט בע"מ', 2090, "hapoalim-1812", "k1", direction="debit", kind="settlement"),
            Txn("2026-09-10", 'ישראכרט בע"מ', -2090, "hapoalim-1812", "k2", direction="credit", kind="credit"),
            Txn("2026-09-11", "חברת חשמל", 10000, "hapoalim-1812", "k3"),
        ]
        res.source_totals = {"hapoalim-1812": None}
        w = _Workdir()
        try:
            w.write(
                "manifest.json",
                {
                    "job": {"id": "j1"},
                    "taxonomy": TAXONOMY,
                    "files": [{"name": "bank.pdf", "path": __file__, "mime": "application/pdf"}],
                    "callback": {"resultUrl": "unused"},
                },
            )
            args = mock.Mock(workdir=w.wd, manifest_file=os.path.join(w.wd, "manifest.json"), manifest_url=None)
            with mock.patch.object(R, "parse_pdf_auto", lambda *a: res), mock.patch("builtins.print"):
                R.cmd_prepare(args)
            state = w.read("state.json")
        finally:
            w.cleanup()
        self.assertEqual([t["dedupKey"] for t in state["txns"]], ["k2", "k3"])
        self.assertEqual(state["txns"][0]["kind"], "credit")
        self.assertEqual(state["txns"][1]["kind"], "expense")
        self.assertEqual(
            state["settlements"],
            [{"date": "2026-09-10", "month": "2026-09", "payee": 'ישראכרט בע"מ', "amountAgorot": 2090,
              "sourceLabel": "hapoalim-1812", "dedupKey": "k1"}],
        )


class TestVerify(unittest.TestCase):
    def test_verify_income_kind_section_mismatch_is_flagged(self):
        a = row("מעסיק", -1000, "income", category="חשמל")  # income kind, expense leaf
        b = row("מעסיק2", -1000, "expense", category="משכורת 1")  # income leaf, expense kind
        ok, problems, _ = verify([a, b], {"hapoalim-1812": None}, TAXONOMY)
        self.assertFalse(ok)
        self.assertEqual(sum("does not match leaf" in p for p in problems), 2)

    def test_verify_income_leaf_needs_negative_bank_amount(self):
        pos = row("מעסיק", 1000, "income", category="משכורת 1")
        card = row("מעסיק", -1000, "income", category="משכורת 1", source="max-1-billed")
        ok, problems, _ = verify([pos, card], {"hapoalim-1812": None, "max-1-billed": -1000}, TAXONOMY)
        self.assertFalse(ok)
        self.assertEqual(sum("non-credit or card-source" in p for p in problems), 2)
        good = row("מעסיק", -1000, "income", category="משכורת 1")
        ok, problems, _ = verify([good], {"hapoalim-1812": None}, TAXONOMY)
        self.assertTrue(ok, problems)

    def test_verify_flags_settlement_dedup_collision(self):
        t = row("חנות", 1000, category="חשמל")
        s = {"dedupKey": t["dedupKey"]}
        ok, problems, summary = verify([t], {"hapoalim-1812": None}, TAXONOMY, settlements=[s, dict(s, dedupKey="z"), dict(s, dedupKey="z")])
        self.assertFalse(ok)
        self.assertTrue(any("collides with a transaction" in p for p in problems))
        self.assertTrue(any("duplicate settlement dedupKey" in p for p in problems))
        self.assertEqual(summary["settlementCount"], 3)

    def test_verify_flags_leaked_settlement_token(self):
        leaked = row("מקס איט פיננ-י", 150000, category="הלוואות")
        ok, problems, _ = verify([leaked], {"hapoalim-1812": None}, TAXONOMY)
        self.assertFalse(ok)
        self.assertTrue(any("leaked" in p for p in problems))
        # The same payee on a CARD source (a printed total) is a merchant, not a leak.
        fee = row("מקס איט פיננ-י", 1500, source="max-1-billed", category="עמלות+ריביות")
        ok, problems, _ = verify([fee], {"max-1-billed": 1500}, TAXONOMY)
        self.assertTrue(ok, problems)
        # And a credit from the issuer is a transaction by design (Decision 4).
        refund = row("מקס איט פיננ-י", -1500, "credit")
        refund["uncategorized"] = True
        ok, problems, _ = verify([refund], {"hapoalim-1812": None}, TAXONOMY)
        self.assertTrue(ok, problems)


class _FakePage:
    def __init__(self, text):
        self._t = text

    def extract_text(self):
        return self._t


class _FakeReader:
    def __init__(self, pages):
        self.pages = [_FakePage(p) for p in pages]


MAX_STATEMENT = (
    "עסקאות במועד החיוב\n"
    "שם בית העסקקטגוריהכרטיססוג עסקהסכום\n"
    "07.07.26חנות א\n"
    "מזון וצריכה8119רגילה₪100.00 \n"
    "03.07.26חנות ב\n"
    "מזון וצריכה8119רגילה₪88.20 \n"
    "ת.עסקה\n"
    ":10.07.2026חיוב ב₪188.20 \n"
    "₪188.20 \n"
    "סה״כ עסקאות במועד החיוב\n"
)

LEUMI_CARD_TWO_BLOCKS = (
    "אשראי לאומי\nפרוט פעולותיך לתאריך: 15/05/26\n"
    'בחו"ל רכישות\n'
    "01/04/26\nר\nAMAZON\n\nLONDON\n10.00\n₪\n\n\n45.00\n"
    'סה"כ\n45.00\n'
    "בארץ - שחויבו עסקות\n"
    "28/09/25\n\nאינט\nתאילנד\nשונות\n533.86\n533.86\nתשלום 8\nמתוך\n12\n"
    'לתאריך חיוב סה"כ\n02/05/26\n533.86\n'
    "14/04/26\n\nאינט\nסופר\nשונות\n199.00\n199.00\n"
    'לתאריך חיוב סה"כ\n15/05/26\n199.00\n'
    "האשראי תנאי\n"
)


class TestChargeCycles(unittest.TestCase):
    def test_card_parsers_report_charge_cycles(self):
        with mock.patch.object(M, "PdfReader", lambda _p: _FakeReader([MAX_STATEMENT])):
            r = M.parse_max_pdf("x.pdf", "max-1")
        self.assertEqual(r.source_totals["max-1-billed"], 18820)
        self.assertEqual(r.charge_cycles, {"max-1-billed": [{"chargeDate": "2026-07-10", "amountAgorot": 18820}]})

        with mock.patch.object(L, "PdfReader", lambda _p: _FakeReader([LEUMI_CARD_TWO_BLOCKS])):
            r = L.parse_leumi_pdf("x.pdf", "card")
        self.assertEqual(r.source_totals["card-domestic"], 73286)
        self.assertEqual(
            r.charge_cycles["card-domestic"],
            [{"chargeDate": "2026-05-02", "amountAgorot": 53386}, {"chargeDate": "2026-05-15", "amountAgorot": 19900}],
        )
        self.assertNotIn("card-foreign", r.charge_cycles)  # a total but no date

        # Isracard xlsx prints no charge date: the parser never fills cycles.
        with open(os.path.join(_HERE, "parse_isracard_xlsx.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("charge_cycles[", src)
        self.assertEqual(ParseResult().charge_cycles, {})

    def test_max_without_a_charge_date_reports_no_cycle(self):
        text = MAX_STATEMENT.replace(":10.07.2026חיוב ב₪188.20 \n", "")
        with mock.patch.object(M, "PdfReader", lambda _p: _FakeReader([text])):
            r = M.parse_max_pdf("x.pdf", "max-1")
        self.assertEqual(r.source_totals["max-1-billed"], 18820)
        self.assertEqual(r.charge_cycles, {})

    def test_diners_cycle_from_total_line(self):
        page = "דיינרס קלאב ישראל\nפירוט חיובים\n07/07/26חנות א₪100.00\n03/07/26חנות ב₪88.20\n₪188.20 :02/08/26\n"
        with mock.patch.object(M, "PdfReader", lambda _p: _FakeReader([page])):
            r = M.parse_max_pdf("x.pdf", "diners")
        self.assertEqual(r.charge_cycles, {"diners-billed": [{"chargeDate": "2026-08-02", "amountAgorot": 18820}]})


if __name__ == "__main__":
    unittest.main()
