# -*- coding: utf-8 -*-
"""Named tests for judgment batching, the server-side dictionary and per-file
limits (docs/plans/scale-large-statements.md A2, A3, A5 — PR-2).

    python3 -m unittest test_judgment_and_limits
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "vendor"))
sys.path.insert(0, _HERE)

import run_job as R  # noqa: E402
from parse_isracard_xlsx import ParseResult, Txn  # noqa: E402
from test_bank_pipeline import INCOME, LEAVES, SEP, TAXONOMY, _Workdir, row  # noqa: E402


def nm(i: int) -> str:
    """A merchant name no built-in rule matches (digits can: "018" is a carrier)."""
    return "Qxv" + "".join("abcdefghij"[int(d)] for d in f"{i:03d}")


def card_result(merchants_amounts, label="max-1-billed"):
    r = ParseResult()
    r.transactions = [
        Txn("2026-05-01", m, a, label, f"{label}|{i}") for i, (m, a) in enumerate(merchants_amounts)
    ]
    r.source_totals = {label: sum(a for _m, a in merchants_amounts)}
    return r


class _Prepared:
    """Runs cmd_prepare on a manifest whose files are parsed by `parse`."""

    def __init__(self, parse, names=("a.pdf",), **manifest_over):
        self.w = _Workdir()
        files = []
        for n in names:
            src = os.path.join(self.w.wd, "src-" + n)
            with open(src, "wb") as f:
                f.write(b"%PDF-fake")
            files.append({"name": n, "path": src, "mime": "application/pdf"})
        manifest = {"job": {"id": "j1"}, "taxonomy": TAXONOMY, "files": files, "callback": {"resultUrl": "unused"},
                    "merchantDictionary": [], "reportRules": "", **manifest_over}
        self.w.write("manifest.json", manifest)
        self.out = []
        with mock.patch.object(R, "parse_pdf_auto", parse), mock.patch.object(
            R, "check_pdf_pages", lambda *a: None
        ), mock.patch("builtins.print", lambda *a, **k: self.out.append(a[0])):
            R.cmd_prepare(mock.Mock(workdir=self.w.wd, manifest_file=os.path.join(self.w.wd, "manifest.json"),
                                    manifest_url=None))

    @property
    def summary(self):
        return json.loads(self.out[-1])

    def batch(self, n):
        return self.w.read(os.path.join(R.BATCH_DIR, R.batch_name(n)))

    def run(self, fn, *args):
        out = []
        with mock.patch("builtins.print", lambda *a, **k: out.append(a[0])):
            fn(mock.Mock(workdir=self.w.wd, dry_run=True), *args)
        return json.loads(out[-1])


class TestJudgmentBatches(unittest.TestCase):
    def setUp(self):
        self.p = None

    def tearDown(self):
        if self.p:
            self.p.w.cleanup()

    def prepare(self, merchants_amounts):
        self.p = _Prepared(lambda *_a: card_result(merchants_amounts))
        return self.p

    def test_batches_are_at_most_40_ordered_by_total_amount(self):
        # 95 merchants, one of them twice (its total is the sum of |amounts|).
        data = [(nm(i), 100 + i) for i in range(95)] + [(nm(0), -5000)]
        p = self.prepare(data)
        index = p.w.read("needs_judgment.json")
        self.assertEqual((index["batches"], index["entries"]), (3, 95))
        entries = [e for n in (1, 2, 3) for e in p.batch(n)["merchants"]]
        self.assertEqual([len(p.batch(n)["merchants"]) for n in (1, 2, 3)], [40, 40, 15])
        totals = [e["totalAgorot"] for e in entries]
        self.assertEqual(totals, sorted(totals, reverse=True))
        self.assertEqual(entries[0]["key"], nm(0))
        self.assertEqual((entries[0]["count"], entries[0]["totalAgorot"]), (2, 5100))
        self.assertEqual(p.summary["judgmentBatches"], 3)

    def test_small_job_is_one_batch(self):
        p = self.prepare([("חנות א", 1000), ("חנות ב", 2000)])
        self.assertEqual(p.w.read("needs_judgment.json")["batches"], 1)
        b = p.batch(1)
        self.assertEqual((b["batch"], b["of"]), (1, 1))
        self.assertEqual([e["key"] for e in b["merchants"]], ["חנות ב", "חנות א"])

    def test_judge_status_counts(self):
        p = self.prepare([(nm(i), 1000 - i) for i in range(85)])
        status = p.run(lambda a: R.cmd_judge_status(a))
        self.assertEqual(
            {k: status[k] for k in ("batches", "judgedBatches", "entriesJudged", "remaining")},
            {"batches": 3, "judgedBatches": 0, "entriesJudged": 0, "remaining": 85},
        )
        self.assertTrue(status["next"].endswith("batch-001.json"))
        first = p.batch(1)["merchants"]
        p.w.write(R.judgments_name(1), {e["key"]: {"uncategorized": True, "note": "x"} for e in first})
        status = p.run(lambda a: R.cmd_judge_status(a))
        self.assertEqual((status["judgedBatches"], status["entriesJudged"], status["remaining"]), (1, 40, 45))
        self.assertTrue(status["next"].endswith("batch-002.json"))

    def test_finalize_merges_all_judgment_files(self):
        p = self.prepare([(nm(i), 1000 - i) for i in range(45)])
        b1, b2 = p.batch(1)["merchants"], p.batch(2)["merchants"]
        p.w.write(R.judgments_name(1), {e["key"]: {"category": "חשמל"} for e in b1})
        p.w.write(R.judgments_name(2), {e["key"]: {"category": "חשמל"} for e in b2})
        p.run(lambda a: R.cmd_finalize(a))
        result = p.w.read("result.json")
        self.assertTrue(all(t["category"] == "חשמל" for t in result["transactions"]))
        self.assertNotIn("לא נבדקו", result["agentNotes"] or "")

    def test_duplicate_or_unknown_judgment_key_is_a_warning(self):
        p = self.prepare([("חנות א", 1000), ("חנות ב", 2000)])
        p.w.write("judgments.json", {"חנות א": {"category": "חשמל"}})
        p.w.write(R.judgments_name(1), {"חנות א": {"uncategorized": True}, "חנות ב": {"category": "חשמל"},
                                         "חנות שלא קיימת": {"category": "חשמל"}})
        out = p.run(lambda a: R.cmd_finalize(a))
        result = p.w.read("result.json")
        t = {x["merchant"]: x for x in result["transactions"]}
        self.assertEqual(t["חנות א"]["category"], "חשמל")  # the first file's decision is kept
        notes = result["agentNotes"]
        self.assertIn("חנות א appears in judgments.json and judgments-001.json", notes)
        self.assertIn("not in the shortlist", notes)
        self.assertIn("חנות שלא קיימת", notes)
        self.assertEqual(len(out["judgmentWarnings"]), 2)

    def test_unjudged_count_is_reported_in_agent_notes(self):
        p = self.prepare([(nm(i), 1000 - i) for i in range(45)])
        p.w.write(R.judgments_name(1), {e["key"]: {"category": "חשמל"} for e in p.batch(1)["merchants"]})
        p.run(lambda a: R.cmd_finalize(a))
        result = p.w.read("result.json")
        self.assertIn("5 בתי עסק לא נבדקו — נשארו ללא סיווג", result["agentNotes"])
        self.assertEqual(sum(1 for t in result["transactions"] if t["uncategorized"]), 5)

    def test_batch_numbers_past_999_are_loaded_in_numeric_order(self):
        p = self.prepare([("חנות א", 1000), ("חנות ב", 2000)])
        p.w.write(R.judgments_name(1000), {"חנות א": {"category": "חשמל"}, "חנות ב": {"category": "חשמל"}})
        p.w.write(R.judgments_name(999), {"חנות א": {"uncategorized": True}})
        self.assertEqual(R.judgments_name(1000), "judgments-1000.json")
        judgments, warnings = R.load_judgments(p.w.wd)
        self.assertEqual(judgments["חנות ב"], {"category": "חשמל"})  # batch 1000 is read
        self.assertEqual(judgments["חנות א"], {"uncategorized": True})  # 999 before 1000
        self.assertIn("judgments-999.json and judgments-1000.json", warnings[0])

    def test_reprepare_clears_old_batches_and_judgments(self):
        p = self.prepare([(nm(i), 1000 - i) for i in range(45)])
        p.w.write(R.judgments_name(2), {nm(44): {"category": "חשמל"}})
        p.w.write("judgments.json", {nm(0): {"category": "חשמל"}})
        wd = p.w.wd
        p.w.write("manifest.json", {**p.w.read("manifest.json")})
        with mock.patch.object(R, "parse_pdf_auto", lambda *_a: card_result([("חנות", 10)])), mock.patch.object(
            R, "check_pdf_pages", lambda *a: None
        ), mock.patch("builtins.print"):
            R.cmd_prepare(mock.Mock(workdir=wd, manifest_file=os.path.join(wd, "manifest.json"), manifest_url=None))
        self.assertFalse(any(n.startswith("judgments") for n in os.listdir(wd)))
        self.assertEqual(sorted(os.listdir(os.path.join(wd, R.BATCH_DIR))), ["batch-001.json"])


class TestDictionary(unittest.TestCase):
    def test_dictionary_resolved_in_chunks_of_500(self):
        txns = [row(f"עסק {i:04d}", 100) for i in range(1201)] + [row("זיכוי", -100, "credit"), row("x" * 201, 100)]
        calls = []

        def fake_http(url, payload=None):
            calls.append((url, payload["merchants"]))
            return {"hits": {"עסק 0007": "חשמל"}}

        with mock.patch.object(R, "http_json", fake_http):
            hits = R.resolve_dictionary({"dictionaryResolveUrl": "https://app/dict?t=1", "merchantDictionary": [
                {"merchantPattern": "never used", "category": "חשמל"}]}, txns)
        self.assertEqual([len(m) for _u, m in calls], [500, 500, 201])
        sent = [m for _u, ms in calls for m in ms]
        self.assertEqual(len(sent), len(set(sent)))
        self.assertNotIn("זיכוי", sent)  # credits never take a dictionary category
        self.assertNotIn("x" * 201, sent)  # over the route's length limit
        self.assertEqual(hits, {"עסק 0007": "חשמל"})

    def test_old_manifest_uses_inline_dictionary(self):
        with mock.patch.object(R, "http_json", side_effect=AssertionError("no network for an old manifest")):
            hits = R.resolve_dictionary(
                {"merchantDictionary": [{"merchantPattern": " חנות  א ", "category": "חשמל"}]}, [row("חנות א", 100)]
            )
        self.assertEqual(hits, {"חנות א": "חשמל"})

    def test_resolved_income_leaf_is_ignored(self):
        rows = [row("מעסיק", 100000)]
        with mock.patch.object(R, "http_json", lambda *_a, **_k: {"hits": {"מעסיק": "משכורת 1"}}):
            hits = R.resolve_dictionary({"dictionaryResolveUrl": "u"}, rows)
        short = R.categorize(rows, hits, LEAVES, INCOME)
        self.assertIsNone(rows[0]["category"])
        self.assertEqual([e["key"] for e in short], ["מעסיק"])

    def test_prepare_uses_the_resolve_url(self):
        seen = []

        def fake_http(url, payload=None):
            seen.append(url)
            return {"hits": {"חנות א": "חשמל"}}

        with mock.patch.object(R, "http_json", fake_http):
            p = _Prepared(lambda *_a: card_result([("חנות א", 100), ("חנות ב", 200)]),
                          dictionaryResolveUrl="https://app/dict?t=1")
        try:
            self.assertEqual(seen, ["https://app/dict?t=1"])
            self.assertEqual(p.summary["autoCategorized"], 1)
        finally:
            p.w.cleanup()


class _FakePage:
    def __init__(self, text):
        self.text = text

    def extract_text(self):
        return self.text


def fake_reader(pages):
    class Rd:
        def __init__(self, _path):
            self.pages = pages

    return Rd


class TestParseLimits(unittest.TestCase):
    def run_prepare(self, parse, names=("a.pdf",), check_pages=True):
        w = _Workdir()
        try:
            files = []
            for n in names:
                src = os.path.join(w.wd, "src-" + n)
                with open(src, "wb") as f:
                    f.write(b"%PDF-fake")
                files.append({"name": n, "path": src, "mime": "application/pdf"})
            w.write("manifest.json", {"job": {"id": "j1"}, "taxonomy": TAXONOMY, "files": files,
                                      "callback": {"resultUrl": "unused"}})
            patches = [mock.patch.object(R, "parse_pdf_auto", parse), mock.patch("builtins.print")]
            if not check_pages:
                patches.append(mock.patch.object(R, "check_pdf_pages", lambda *a: None))
            for p in patches:
                p.start()
            try:
                R.cmd_prepare(mock.Mock(workdir=w.wd, manifest_file=os.path.join(w.wd, "manifest.json"),
                                        manifest_url=None))
            finally:
                for p in patches:
                    p.stop()
        finally:
            w.cleanup()

    def test_parse_timeout_names_the_file(self):
        def slow(*_a):
            time.sleep(5)

        with mock.patch.dict(os.environ, {"PLUSIM_PARSE_TIMEOUT_S": "0.05"}):
            started = time.monotonic()
            with self.assertRaises(R.ParseFileError) as ctx:
                self.run_prepare(slow, names=("איטי.pdf",), check_pages=False)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(str(ctx.exception), "איטי.pdf: parse timed out after 0.05s")

    def test_timeout_is_not_swallowed_by_a_broad_except(self):
        def stubborn(*_a):
            try:
                time.sleep(5)
            except Exception:
                return card_result([])

        with mock.patch.dict(os.environ, {"PLUSIM_PARSE_TIMEOUT_S": "0.05"}):
            with self.assertRaises(R.ParseFileError):
                self.run_prepare(stubborn, check_pages=False)

    def test_a_tiny_timeout_never_escapes_unnamed_and_restores_the_handler(self):
        before = signal.getsignal(signal.SIGALRM)
        with mock.patch.dict(os.environ, {"PLUSIM_PARSE_TIMEOUT_S": "0.000001"}):
            for _ in range(300):
                try:
                    R.parse_with_limits("x.pdf", lambda: sum(range(2000)), "PDF")
                except R.ParseFileError as e:
                    self.assertEqual(str(e), "x.pdf: parse timed out after 1e-06s")
                self.assertIs(signal.getsignal(signal.SIGALRM), before)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_timeout_default_and_bad_env(self):
        for raw in ("", "abc", "0", "-3"):
            with mock.patch.dict(os.environ, {"PLUSIM_PARSE_TIMEOUT_S": raw}):
                self.assertEqual(R.parse_timeout_s(), 120.0)

    def test_any_parse_exception_names_the_file(self):
        def broken(*_a):
            raise KeyError("internal detail")

        with self.assertRaises(R.ParseFileError) as ctx:
            self.run_prepare(broken, names=("שבור.pdf",), check_pages=False)
        self.assertEqual(str(ctx.exception), "שבור.pdf: unreadable PDF (KeyError)")
        self.assertNotIn("internal detail", str(ctx.exception))

    def test_page_cap_names_the_file(self):
        parsed = []
        with mock.patch.object(R, "PdfReader", fake_reader([_FakePage("x")] * 601)):
            with self.assertRaises(R.ParseFileError) as ctx:
                self.run_prepare(lambda *a: parsed.append(a), names=("ענק.pdf",))
        self.assertEqual(str(ctx.exception), "ענק.pdf: more than 600 pages")
        self.assertEqual(parsed, [])  # refused before the parse

    def test_scanned_pdf_gets_the_named_error(self):
        with mock.patch.object(R, "PdfReader", fake_reader([_FakePage(""), _FakePage("  12 ")])), mock.patch.object(
            R, "detect_bank_pdf", lambda _p: False
        ), mock.patch.object(R, "detect_leumi_pdf", lambda _p: False), mock.patch.object(
            R, "detect_max_pdf", lambda _p: False
        ):
            with self.assertRaises(R.ScannedPdfError) as ctx:
                R.parse_pdf_auto("x.pdf", "src", "סרוק.pdf")
            # A PDF with real text that no detector knows is still the generic refusal.
            with mock.patch.object(R, "PdfReader", fake_reader([_FakePage("טקסט ארוך מספיק כדי להיות שכבת טקסט")])):
                with self.assertRaises(R.UnknownStatementError):
                    R.parse_pdf_auto("x.pdf", "src", "אחר.pdf")
        msg = str(ctx.exception)
        self.assertTrue(msg.startswith("סרוק.pdf: "))
        self.assertIn("OCR", msg)

    def test_prepare_aborts_on_first_failing_file(self):
        calls = []

        def parse(_dest, _label, name):
            calls.append(name)
            if name == "b.pdf":
                raise ValueError("bad")
            return card_result([("חנות", 100)])

        with self.assertRaises(R.ParseFileError) as ctx:
            self.run_prepare(parse, names=("a.pdf", "b.pdf", "c.pdf"), check_pages=False)
        self.assertEqual(calls, ["a.pdf", "b.pdf"])
        self.assertTrue(str(ctx.exception).startswith("b.pdf: "))

    def test_download_failure_names_the_file(self):
        def boom(*_a):
            raise OSError("connection reset")

        with mock.patch.object(R, "http_download", boom):
            with self.assertRaises(R.ParseFileError) as ctx:
                self.run_prepare(lambda *a: card_result([]), names=("רחוק.pdf",), check_pages=False)
        self.assertEqual(str(ctx.exception), "רחוק.pdf: download failed (OSError)")

    def test_cli_prints_one_line_error_and_exits_2(self):
        w = _Workdir()
        try:
            src = os.path.join(w.wd, "src.pdf")
            with open(src, "wb") as f:
                f.write(b"not a pdf at all")
            w.write("manifest.json", {"job": {"id": "j1"}, "taxonomy": TAXONOMY, "callback": {"resultUrl": "u"},
                                      "files": [{"name": "פגום.pdf", "path": src, "mime": "application/pdf"}]})
            proc = subprocess.run(
                [sys.executable, os.path.join(_HERE, "run_job.py"), "prepare",
                 "--manifest-file", os.path.join(w.wd, "manifest.json"), "--workdir", w.wd],
                capture_output=True, text=True, timeout=60,
            )
        finally:
            w.cleanup()
        self.assertEqual(proc.returncode, 2, proc.stderr)
        out = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(out["phase"], "prepare")
        self.assertTrue(out["error"].startswith("פגום.pdf: unreadable PDF ("), out)


if __name__ == "__main__":
    unittest.main()
