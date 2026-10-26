# -*- coding: utf-8 -*-
"""Named tests for adjust_job.py and the builder CLI
(docs/plans/report-adjust-chat.md A1, A3, B7).

    python3 -m unittest test_adjust_job
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "vendor"))
sys.path.insert(0, _HERE)

import adjust_job as A  # noqa: E402
import run_job as R  # noqa: E402
from build_report_xlsx import build_workbook  # noqa: E402

TAXONOMY = [{"section": "בית", "leaves": ["חשמל", "מזון ומכולת"]}, {"section": "הכנסות", "leaves": ["משכורת 1"]}]
ROWS = [
    {"id": "t1", "month": "2026-05", "date": "2026-05-15", "merchant": "רמי לוי", "amountAgorot": 12000,
     "category": "מזון ומכולת", "uncategorized": False, "sourceLabel": "max-1", "note": "תשלום 2 מתוך 3",
     "kind": "expense", "dedupKey": "k1"},
    {"id": "t2", "month": "2026-06", "date": "2026-06-01", "merchant": "חברת חשמל", "amountAgorot": 30000,
     "category": None, "uncategorized": True, "sourceLabel": "max-1", "note": None, "kind": "expense", "dedupKey": "k2"},
]


def workdir() -> str:
    wd = os.path.join("/tmp", "plusim-job-adjtest" + str(os.getpid()))
    shutil.rmtree(wd, ignore_errors=True)
    return wd


def run(fn, argv):
    out = io.StringIO()
    with mock.patch("sys.stdout", out):
        try:
            A.main(argv)
            code = 0
        except SystemExit as e:
            code = e.code
    lines = [ln for ln in out.getvalue().splitlines() if ln.strip()]
    return code, json.loads(lines[-1])


class TestAdjustJob(unittest.TestCase):
    def setUp(self):
        self.wd = workdir()

    def tearDown(self):
        shutil.rmtree(self.wd, ignore_errors=True)

    def test_rows_command_writes_files_and_prints_counts_only(self):
        with mock.patch.object(A, "_request", lambda url, payload=None: (200, {
            "job": {"id": "j", "status": "published"}, "taxonomy": TAXONOMY, "transactions": ROWS})):
            code, out = run(A, ["rows", "--rows-url", "https://app/rows?t=x", "--workdir", self.wd])
        self.assertEqual(code, 0)
        self.assertEqual((out["count"], out["months"], out["uncategorized"], out["status"]), (2, ["2026-05", "2026-06"], 1, "published"))
        self.assertNotIn("רמי לוי", json.dumps(out, ensure_ascii=False))  # counts only, never the rows
        with open(os.path.join(self.wd, "rows.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), ROWS)
        with open(os.path.join(self.wd, "taxonomy.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), TAXONOMY)

    def test_apply_posts_edits_and_reports_the_server_workbook_status(self):
        os.makedirs(self.wd)
        edits = os.path.join(self.wd, "edits.json")
        with open(edits, "w", encoding="utf-8") as f:
            json.dump([{"id": "t1", "date": "2026-06-15"}], f)
        sent = []

        def fake(url, payload=None):
            sent.append((url, payload))
            return 200, {"applied": [{"id": "t1", "merchant": "רמי לוי", "field": "date", "from": "2026-05-15",
                                      "to": "2026-06-15"}], "workbook": "updated"}

        with mock.patch.object(A, "_request", fake):
            code, out = run(A, ["apply", "--edits-file", edits, "--adjust-url", "https://app/adjust?t=x",
                                "--workdir", self.wd])
        self.assertEqual(code, 0)
        self.assertEqual(sent, [("https://app/adjust?t=x", {"edits": [{"id": "t1", "date": "2026-06-15"}]})])
        self.assertEqual(out["workbook"], "updated")
        self.assertEqual(out["applied"][0]["to"], "2026-06-15")

    def test_apply_reports_the_server_reason_when_adjust_is_rejected(self):
        os.makedirs(self.wd)
        edits = os.path.join(self.wd, "edits.json")
        with open(edits, "w", encoding="utf-8") as f:
            json.dump({"edits": [{"id": "t1", "category": "משכורת 1"}]}, f)
        reason = "רמי לוי (2026-05-15, t1): קטגוריית הכנסה אפשרית רק לזיכוי (סכום שלילי)"
        with mock.patch.object(A, "_request", lambda url, payload=None: (400, {"error": reason})):
            code, out = run(A, ["apply", "--edits-file", edits, "--adjust-url", "u", "--workdir", self.wd])
        self.assertEqual(code, 1)
        self.assertEqual(out, {"phase": "apply", "status": 400, "error": reason})

    def test_workdir_must_be_under_tmp_job_dir(self):
        for bad in ("/home/node/.openclaw/workspace/x", "relative/dir", "/tmp/plusim-job-x,timeout:300}"):
            with self.assertRaises(R.UnsafeWorkdirError):
                A.main(["cleanup", "--workdir", bad])

    def test_cleanup_removes_workdir(self):
        os.makedirs(self.wd)
        with open(os.path.join(self.wd, "rows.json"), "w") as f:
            f.write("[]")
        code, out = run(A, ["cleanup", "--workdir", self.wd])
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(self.wd))


class TestBuilderCli(unittest.TestCase):
    def test_builder_cli_matches_build_workbook(self):
        import openpyxl

        tmp = tempfile.mkdtemp()
        try:
            direct = os.path.join(tmp, "direct.xlsx")
            cli = os.path.join(tmp, "cli.xlsx")
            build_workbook(TAXONOMY, ROWS, direct)
            proc = subprocess.run(
                [sys.executable, os.path.join(_HERE, "build_report_xlsx.py"), "--out", cli],
                input=json.dumps({"taxonomy": TAXONOMY, "txns": ROWS}, ensure_ascii=False),
                capture_output=True, text=True, timeout=60,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)

            def cells(path):
                wb = openpyxl.load_workbook(path)
                return {ws.title: [list(r) for r in ws.iter_rows(values_only=True)] for ws in wb.worksheets}

            self.assertEqual(cells(cli), cells(direct))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
