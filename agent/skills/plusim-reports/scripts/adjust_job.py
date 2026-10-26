# -*- coding: utf-8 -*-
"""Plusim report-adjustment chat (see ../SKILL.md, "Report adjustment chat").

The admin asks, in the report's "שיחה עם הסוכן" tab, for date / category changes
to an existing report. This script is the agent's only way to read and change
the report's rows; the APP validates every edit and rebuilds the Excel from its
own rows (docs/plans/report-adjust-chat.md). Nothing here builds a workbook.

Commands:
  rows    — GET the job's rows into WD/rows.json + WD/taxonomy.json; prints
            counts only (query the file — never paste thousands of rows).
  apply   — POST WD's edits file to the adjust URL; prints the server's answer,
            or its refusal verbatim (exit 1).
  cleanup — delete WD (rows are personal financial data).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.error
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from run_job import TOKEN_ENV, safe_workdir  # noqa: E402


def _request(url: str, payload: dict | None = None) -> tuple[int, dict]:
    token = os.environ.get(TOKEN_ENV, "")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "authorization": f"Bearer {token}",
            **({"content-type": "application/json"} if payload is not None else {}),
        },
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=150) as res:
            return res.status, json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode() or "{}")
        except ValueError:
            body = {}
        return e.code, body


def cmd_rows(args) -> None:
    wd = safe_workdir(args.workdir)
    os.makedirs(wd, exist_ok=True)
    status, body = _request(args.rows_url)
    if status != 200:
        print(json.dumps({"phase": "rows", "status": status, "error": body.get("error", "")}, ensure_ascii=False))
        sys.exit(1)
    txns = body.get("transactions", [])
    with open(os.path.join(wd, "rows.json"), "w", encoding="utf-8") as f:
        json.dump(txns, f, ensure_ascii=False, indent=1)
    with open(os.path.join(wd, "taxonomy.json"), "w", encoding="utf-8") as f:
        json.dump(body.get("taxonomy", []), f, ensure_ascii=False, indent=1)
    print(
        json.dumps(
            {
                "phase": "rows",
                "count": len(txns),
                "months": sorted({t["month"] for t in txns}),
                "uncategorized": sum(1 for t in txns if t.get("uncategorized")),
                "status": (body.get("job") or {}).get("status"),
                "rowsFile": os.path.join(wd, "rows.json"),
                "taxonomyFile": os.path.join(wd, "taxonomy.json"),
            },
            ensure_ascii=False,
        )
    )


def cmd_apply(args) -> None:
    safe_workdir(args.workdir)
    with open(args.edits_file, encoding="utf-8") as f:
        edits = json.load(f)
    if isinstance(edits, dict) and "edits" in edits:
        edits = edits["edits"]
    status, body = _request(args.adjust_url, {"edits": edits})
    if status != 200:
        # The server's reason, verbatim: it names the row and the rule.
        print(json.dumps({"phase": "apply", "status": status, "error": body.get("error", "")}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps({"phase": "apply", **body}, ensure_ascii=False))


def cmd_cleanup(args) -> None:
    wd = safe_workdir(args.workdir)
    shutil.rmtree(wd, ignore_errors=True)
    print(json.dumps({"phase": "cleanup", "removed": wd}))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Plusim report-adjustment chat")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("rows")
    r.add_argument("--rows-url", required=True)
    r.add_argument("--workdir", required=True)
    a = sub.add_parser("apply")
    a.add_argument("--edits-file", required=True)
    a.add_argument("--adjust-url", required=True)
    a.add_argument("--workdir", required=True)
    c = sub.add_parser("cleanup")
    c.add_argument("--workdir", required=True)
    args = p.parse_args(argv)
    {"rows": cmd_rows, "apply": cmd_apply, "cleanup": cmd_cleanup}[args.cmd](args)


if __name__ == "__main__":
    main()
