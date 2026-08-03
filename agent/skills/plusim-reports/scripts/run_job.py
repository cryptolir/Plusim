# -*- coding: utf-8 -*-
"""Plusim report-job orchestrator (see ../SKILL.md for the agent-facing flow).

Phases:
  prepare  — fetch manifest + statement files, parse everything, run the
             deterministic categorizer (dictionary → rules → MAX-category map),
             write state + needs_judgment.json (merchants only a human/model
             judgment can place). Exit code 0; prints a summary.
  finalize — merge judgments.json (if any), mark leftovers uncategorized,
             verify to-the-agora, build the xlsx, POST the result callback
             (or write result.json with --dry-run). Prints the outcome.
  cleanup  — delete downloaded statements + intermediates (PII hygiene).

Deterministic parsing/dedup/build/verify lives in code; the ONLY model step is
filling judgments.json for the shortlist. Never guess there — prefer
{"uncategorized": true} with a reason (reference/categorization-rules.md).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import sys
import unicodedata
import urllib.request

# Third-party deps (openpyxl, pypdf) are vendored into <skill>/vendor/ because
# the exec sandbox wipes ~/.local between calls, so `pip install --user` does
# not survive. Rebuild if vendor/ is ever missing:
#   python3 -m pip install --target <skill>/vendor openpyxl pypdf
# Must be on sys.path BEFORE the sibling imports below (they import openpyxl/
# pypdf at module level).
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "vendor"))
sys.path.insert(0, _HERE)
from build_report_xlsx import build_workbook  # noqa: E402
from parse_discount_xlsx import parse_discount_xlsx  # noqa: E402
from parse_isracard_xlsx import parse_isracard_xlsx  # noqa: E402
from parse_leumi_pdf import detect_leumi_pdf, parse_leumi_pdf  # noqa: E402
from parse_max_pdf import detect_max_pdf, parse_max_pdf  # noqa: E402
from verify_report import verify  # noqa: E402

TOKEN_ENV = "PLUSIM_RUNTIME_TOKEN"

# ---------------------------------------------------------------------------
# Deterministic routing rules — the playbook proven on real statements.
# (pattern is a substring match on the normalized merchant; first hit wins,
# so more specific patterns come first.)
# ---------------------------------------------------------------------------
RULES: list[tuple[str, str]] = [
    ("נטפליקס", "נטפליקס"),
    ("NETFLIX", "נטפליקס"),
    ("APPLE.COM", 'רכישות באתרי חו"ל'),
    ("ETSY", 'רכישות באתרי חו"ל'),
    ("ALIEXPRESS", 'רכישות באתרי חו"ל'),
    ("AMAZON", 'רכישות באתרי חו"ל'),
    ("העברה בBIT", "ביט"),
    ("העברה ב BIT", "ביט"),
    ("BIT", "ביט"),
    ("דמי כרטיס", "עמלות+ריביות"),
    ("בנק לאומי-דמי", "עמלות+ריביות"),
    ("ועד מקומי", "ועד בית"),
    ("ועד בית", "ועד בית"),
    ("תחנת דלק", "דלק"),
    ("דלק גולד", "דלק"),
    ("סונול", "דלק"),
    ("פז אפליקצי", "דלק"),
    ("דור אלון", "דלק"),
    ("יוחננוף", "מזון ומכולת"),
    ("אושר עד", "מזון ומכולת"),
    ("מחסני השוק", "מזון ומכולת"),
    ("שופרסל", "מזון ומכולת"),
    ("רמי לוי", "מזון ומכולת"),
    ("ויקטורי", "מזון ומכולת"),
    ("טיב טעם", "מזון ומכולת"),
    ("נאייקס", "מזון ומכולת"),  # vending machines
    ("סופר-פארם", "הוצאות ריפוי"),
    ("סופר פארם", "הוצאות ריפוי"),
    ("MY DOCTOR", "הוצאות ריפוי"),
    ("בית מרקחת", "הוצאות ריפוי"),
    ("פרופ'", "הוצאות ריפוי"),
    ('ד"ר ', "הוצאות ריפוי"),
    ("מכבי", "הוצאות ריפוי"),
    ("שרותי בריאות", "בריאות משלים"),
    ("שירותי בריאות", "בריאות משלים"),
    ("מנורה מבטח", "פרטי"),
    ("ליברה ביטוח חובה", "רכב(חובה+מקיף)"),
    ("ליברה עסקאות ביטוח", "רכב(חובה+מקיף)"),
    ("ביטוח חובה", "רכב(חובה+מקיף)"),
    ("בזק הוראת קבע", "טלפון קווי\\ בזק"),
    ("בזק בינלאומי", "אינטרנט\\בזק בינלאומי"),
    ("אקספון", "טלפון קווי\\ בזק"),
    ("018", "טלפון קווי\\ בזק"),
    ("הוט מובייל", "סלולרי\\הוט מובייל"),
    ("פלאפון", "סלולרי\\הוט מובייל"),
    ("סלקום", "סלולרי\\הוט מובייל"),
    ("מ. התחבורה", "אחזקת רכב ותיקונים"),
    ("מנהרות הכרמל", "אחזקת רכב ותיקונים"),
    ("כביש 6", "אחזקת רכב ותיקונים"),
    ("דרך ארץ", "אחזקת רכב ותיקונים"),
    ("חניון", "אחזקת רכב ותיקונים"),
    ("אוטוטו", "אחזקת רכב ותיקונים"),
    ("גרייט שייפ", "חוגי מבוגרים"),
    ("כושר", "חוגי מבוגרים"),
    ("מוסדות קבר", "מוסדות קבר"),
    ("מסעדת", "מסעדה/סרטים/הצגות"),
    ("מסעדה", "מסעדה/סרטים/הצגות"),
    ("קפה", "מסעדה/סרטים/הצגות"),
    ("בייקרי", "מסעדה/סרטים/הצגות"),
    ("מזנון", "מסעדה/סרטים/הצגות"),
    ("יס פלאנט", "מסעדה/סרטים/הצגות"),
    ("סינמה", "מסעדה/סרטים/הצגות"),
    ("WOLT", "מסעדה/סרטים/הצגות"),
    ("בורגר", "מסעדה/סרטים/הצגות"),
    ("פיצה", "מסעדה/סרטים/הצגות"),
    ("סושי", "מסעדה/סרטים/הצגות"),
    ("CELLO", "אפליקציות"),
    ("בראנד אספקה טכנית", "אחזקה ותיקונים"),
    ("מפעל הפיס", "פיס"),
]

# When no dictionary/rule hit, MAX's own printed category may be trusted for
# these unambiguous leaves only (the rest need judgment).
MAX_CATEGORY_MAP = {
    "קוסמטיקה וטיפוח": "קוסמטיקה",
    "אופנה": "ביגוד והנעלה",
    "מסעדות, קפה וברים": "מסעדה/סרטים/הצגות",
    "רפואה ובתי מרקחת": "הוצאות ריפוי",
    "מזון ומשקאות": "מזון ומכולת",
}


# Scratch directory containment.
#
# `--workdir` is supplied by the MODEL, and it has gotten this wrong: a mangled
# argument once created a directory literally named ",timeout:300}" INSIDE the
# skill folder, and a customer's statement PDF was downloaded into it. The agent
# workspace is PERSISTENT, so that file outlived the job — and the mandatory
# cleanup step never saw it, because cleanup only removes the path it is given.
#
# Scratch therefore has to live under /tmp: ephemeral, outside the workspace,
# and exactly what SKILL.md already documents (/tmp/plusim-job-<jobId>).
# Refusing anything else also protects `cleanup`, which rmtree's this path — a
# bad value there deletes whatever it names.
#
# Pinned to a LITERAL /tmp, deliberately not tempfile.gettempdir(): that honours
# $TMPDIR, so prefixing one invocation with TMPDIR=<workspace> would make the
# persistent workspace itself the "safe" root and defeat this guard entirely.
# It is also per-process, so `prepare` could accept a path that `cleanup` later
# refuses — stranding exactly the PII this exists to remove (Codex #42 P1).
SCRATCH_ROOT = os.path.realpath("/tmp")


class UnsafeWorkdirError(Exception):
    """--workdir outside the scratch root. Raised before anything is written."""


def safe_workdir(raw: str) -> str:
    # Relative paths resolve against CWD, so the SAME argument is safe or unsafe
    # depending on where the agent happened to be invoked. Require absolute and
    # the answer stops depending on that.
    if not os.path.isabs(raw):
        raise UnsafeWorkdirError(
            f"--workdir must be an absolute path under {SCRATCH_ROOT} "
            f"(e.g. {SCRATCH_ROOT}/plusim-job-<jobId>); a relative path resolves "
            f"against the current directory. Got: {raw!r}"
        )
    wd = os.path.realpath(raw)
    if wd == SCRATCH_ROOT or not wd.startswith(SCRATCH_ROOT + os.sep):
        raise UnsafeWorkdirError(
            f"--workdir must be a directory under {SCRATCH_ROOT} "
            f"(e.g. {SCRATCH_ROOT}/plusim-job-<jobId>), never inside the agent "
            f"workspace — statements are customer financial data and the "
            f"workspace is persistent. Got: {raw!r}"
        )
    return wd


def safe_dest(files_dir: str, name: str) -> str:
    """Path to download one statement to, contained inside files_dir.

    `name` is manifest-supplied — it is StatementFile.filename, which the app
    stores as `f.name.slice(0, 200)` with NO path sanitising
    (src/lib/reportStatementUpload.ts). A crafted multipart upload named
    "../../../root/.ssh/authorized_keys" would otherwise make os.path.join
    write outside the scratch dir, as root, on the agent host.

    basename() is the containment; the realpath check is the belt.
    """
    base = os.path.basename(name).strip()
    if base in ("", ".", ".."):
        base = "statement"
    dest = os.path.join(files_dir, base)
    if os.path.dirname(os.path.realpath(dest)) != os.path.realpath(files_dir):
        raise UnsafeWorkdirError(
            f"refusing to write a statement outside the scratch dir: {name!r}"
        )
    return dest


def _create_new(dest: str):
    """Open dest for writing without ever following a symlink planted there.

    O_NOFOLLOW refuses a symlink at the final component; O_EXCL refuses an
    existing file. Any leftover (a retried `prepare`, or a planted link) is
    unlinked first — lexists, so a dangling symlink is removed rather than
    followed. 0600 because the content is customer financial data.

    ponytail: this closes the final component only. A fully race-proof version
    would hold an O_DIRECTORY|O_NOFOLLOW fd for the scratch dir and use openat
    for every write (Codex #42 P2). Not done: it rewrites the whole download
    path for a race the model can only win by deliberately backgrounding a
    process against itself — and a model willing to do that already has
    arbitrary exec and does not need the race. Revisit if the skill ever runs
    somewhere /tmp is shared with untrusted processes.
    """
    if os.path.lexists(dest):
        os.unlink(dest)
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    return os.fdopen(fd, "wb")


class UnknownStatementError(Exception):
    """A file matches no parser. Raised instead of guessing.

    Every parser returns an empty transaction list on a layout it does not
    recognize, so a wrong-parser guess reaches the app as "transactions empty"
    with nothing pointing at the file that caused it. Naming the file here is
    the whole difference between a riddle and a fix.
    """


def parse_xlsx_auto(path: str):
    """Dispatch an xlsx statement to the right parser by content.

    A Bank Discount current-account export has its data on a sheet named
    "עובר ושב"; anything else is treated as an Isracard/Leumi card export.
    """
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True)
    try:
        names = wb.sheetnames
    finally:
        wb.close()
    if any("עובר ושב" in (n or "") for n in names):
        return parse_discount_xlsx(path)
    return parse_isracard_xlsx(path)


def parse_pdf_auto(path: str, label: str, name: str):
    """Dispatch a PDF to the parser that recognizes it, or refuse.

    Both issuers are detected explicitly — there is deliberately no fallback
    parser. MAX used to be the else-branch, so any unrecognized PDF (a bank
    current-account export, another issuer) was parsed as a MAX statement and
    silently produced zero rows.
    """
    if detect_leumi_pdf(path):
        return parse_leumi_pdf(path, label)
    if detect_max_pdf(path):
        return parse_max_pdf(path, label)
    raise UnknownStatementError(
        f"{name}: unrecognized PDF — not a MAX or Leumi/Isracard card statement. "
        "Bank current-account (עובר ושב) statements are supported as xlsx only; "
        "re-export from the bank site as Excel."
    )


def normalize_merchant(m: str) -> str:
    m = unicodedata.normalize("NFKC", m)
    m = re.sub(r"\s+", " ", m).strip()
    m = m.replace("…", "").strip()
    return m


def http_json(url: str, payload: dict | None = None) -> dict:
    token = os.environ.get(TOKEN_ENV, "")
    if url.startswith("file://"):
        path = url[len("file://") :]
        if payload is not None:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            return {"ok": True, "local": path}
        with open(path, encoding="utf-8") as f:
            return json.load(f)
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
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read().decode())


def http_download(url: str, dest: str) -> None:
    if not url.startswith("http"):
        with open(url, "rb") as src, _create_new(dest) as f:
            shutil.copyfileobj(src, f)
        return
    token = os.environ.get(TOKEN_ENV, "")
    req = urllib.request.Request(url, headers={"authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=300) as res, _create_new(dest) as f:
        shutil.copyfileobj(res, f)


def categorize(txns: list[dict], dictionary: dict[str, str], leaves: set[str]) -> list[dict]:
    """Deterministic pass. Returns the still-unresolved merchant shortlist."""
    unresolved: dict[str, dict] = {}
    for t in txns:
        if t.get("category") or t.get("uncategorized"):
            continue
        merchant = normalize_merchant(t["merchant"])
        hit = dictionary.get(merchant)
        if hit and hit in leaves:
            t["category"] = hit
            continue
        for pattern, leaf in RULES:
            if pattern in merchant or pattern.upper() in merchant.upper():
                t["category"] = leaf
                break
        if t.get("category"):
            continue
        mapped = MAX_CATEGORY_MAP.get(t.get("max_category", ""))
        if mapped:
            t["category"] = mapped
            continue
        entry = unresolved.setdefault(
            merchant, {"merchant": merchant, "samples": [], "maxCategory": t.get("max_category", "")}
        )
        if len(entry["samples"]) < 5:
            entry["samples"].append(
                {"date": t["date"], "amountAgorot": t["amountAgorot"], "note": t.get("note", "")}
            )
    return list(unresolved.values())


def cmd_prepare(args) -> None:
    wd = safe_workdir(args.workdir)
    files_dir = os.path.join(wd, "files")
    os.makedirs(files_dir, exist_ok=True)
    # safe_workdir resolved a path; this confirms what now EXISTS there is a real
    # directory, not a symlink swapped in between the check and the creation.
    if os.path.islink(wd) or os.path.islink(files_dir):
        raise UnsafeWorkdirError(f"scratch dir is a symlink, refusing to use it: {wd!r}")

    if args.manifest_file:
        with open(args.manifest_file, encoding="utf-8") as f:
            manifest = json.load(f)
    else:
        manifest = http_json(args.manifest_url)
    with open(os.path.join(wd, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)

    all_txns: list[dict] = []
    source_totals: dict[str, int | None] = {}
    warnings: list[str] = []
    max_seq = 0
    for file in manifest["files"]:
        dest = safe_dest(files_dir, file["name"])
        http_download(file.get("url") or file["path"], dest)
        if file["mime"].endswith("pdf"):
            max_seq += 1
            label = file.get("sourceLabel") or f"max-{max_seq}"
            r = parse_pdf_auto(dest, label, file["name"])
        else:
            r = parse_xlsx_auto(dest)
        # A recognized layout that still yields nothing is not fatal (a genuinely
        # empty billing period exists), but it must never pass silently — this is
        # the warning that would have named the file behind "transactions empty".
        if not r.transactions:
            warnings.append(f"{file['name']}: parsed 0 transactions — check the file covers a billed period")
        for t in r.transactions:
            all_txns.append(
                {
                    "month": t.date[:7],
                    "date": t.date,
                    "merchant": normalize_merchant(t.merchant),
                    "amountAgorot": t.amount_agorot,
                    "category": None,
                    "uncategorized": False,
                    "sourceLabel": t.source_label,
                    "note": t.note,
                    "max_category": t.max_category,
                    "dedupKey": t.dedup_key,
                }
            )
        for label, total in r.source_totals.items():
            if label in source_totals:
                warnings.append(f"duplicate source label {label} across files")
            source_totals[label] = total
        warnings.extend(r.warnings)

    leaves = {leaf for sec in manifest["taxonomy"] for leaf in sec["leaves"]}
    dictionary = {
        normalize_merchant(d["merchantPattern"]): d["category"]
        for d in manifest.get("merchantDictionary", [])
    }
    shortlist = categorize(all_txns, dictionary, leaves)

    # Admin-authored extra categorization rules (edited in the Plusim app's
    # /admin/settings, carried in the manifest). The model applies these ON TOP
    # of reference/categorization-rules.md during the judgment step; an empty
    # string ⇒ the static playbook only (behavior unchanged from before).
    report_rules = manifest.get("reportRules") or ""

    state = {"txns": all_txns, "sourceTotals": source_totals, "warnings": warnings}
    with open(os.path.join(wd, "state.json"), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    with open(os.path.join(wd, "needs_judgment.json"), "w", encoding="utf-8") as f:
        json.dump({"reportRules": report_rules, "merchants": shortlist}, f, ensure_ascii=False, indent=1)

    print(
        json.dumps(
            {
                "phase": "prepare",
                "files": len(manifest["files"]),
                "transactions": len(all_txns),
                "autoCategorized": sum(1 for t in all_txns if t["category"]),
                "needsJudgment": len(shortlist),
                "reportRules": bool(report_rules),
                "warnings": warnings,
            },
            ensure_ascii=False,
        )
    )


def cmd_finalize(args) -> None:
    wd = safe_workdir(args.workdir)
    with open(os.path.join(wd, "state.json"), encoding="utf-8") as f:
        state = json.load(f)
    with open(os.path.join(wd, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)

    judgments: dict[str, dict] = {}
    jpath = os.path.join(wd, "judgments.json")
    if os.path.exists(jpath):
        with open(jpath, encoding="utf-8") as f:
            judgments = {normalize_merchant(k): v for k, v in json.load(f).items()}

    leaves = {leaf for sec in manifest["taxonomy"] for leaf in sec["leaves"]}
    proposed: list[dict] = []
    for t in state["txns"]:
        if t["category"] or t["uncategorized"]:
            continue
        j = judgments.get(normalize_merchant(t["merchant"]))
        if j and j.get("category") in leaves and not j.get("uncategorized"):
            t["category"] = j["category"]
            if j.get("note"):
                t["note"] = (t.get("note") or "") + (" · " if t.get("note") else "") + j["note"]
            if j.get("propose"):
                entry = {"merchant": normalize_merchant(t["merchant"]), "category": j["category"], "evidence": j.get("note", "")}
                if entry not in proposed:
                    proposed.append(entry)
        else:
            t["uncategorized"] = True
            reason = (j or {}).get("note") or "לא זוהה סיווג ודאי"
            t["note"] = (t.get("note") or "") + (" · " if t.get("note") else "") + reason

    ok, problems, summary = verify(state["txns"], state["sourceTotals"], manifest["taxonomy"])

    xlsx_path = os.path.join(wd, "report.xlsx")
    build_workbook(manifest["taxonomy"], state["txns"], xlsx_path)
    with open(xlsx_path, "rb") as f:
        xlsx_b64 = base64.b64encode(f.read()).decode()

    payload = {
        "status": "ok" if ok else "needs_review",
        "transactions": [
            {
                "month": t["month"],
                "date": t["date"],
                "merchant": t["merchant"],
                "amountAgorot": t["amountAgorot"],
                "category": t["category"],
                "uncategorized": t["uncategorized"],
                "sourceLabel": t["sourceLabel"],
                "note": t.get("note") or None,
                "dedupKey": t["dedupKey"],
            }
            for t in state["txns"]
        ],
        "sourceTotals": [
            {
                "label": label,
                "statementTotalAgorot": total,
                "computedTotalAgorot": sum(
                    t["amountAgorot"] for t in state["txns"] if t["sourceLabel"] == label
                ),
            }
            for label, total in state["sourceTotals"].items()
        ],
        "xlsxBase64": xlsx_b64,
        "xlsxFilename": f"plusim-report-{manifest['job']['id']}.xlsx",
        "proposedMappings": proposed,
        "agentNotes": "; ".join(state["warnings"] + problems) or None,
    }

    if args.dry_run:
        out = os.path.join(wd, "result.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        print(json.dumps({"phase": "finalize", "dryRun": True, "status": payload["status"], "problems": problems, **{k: summary[k] for k in ("txCount", "uncategorizedCount")}}, ensure_ascii=False))
        return

    res = http_json(manifest["callback"]["resultUrl"], payload)
    print(
        json.dumps(
            {
                "phase": "finalize",
                "status": payload["status"],
                "problems": problems,
                "txCount": summary["txCount"],
                "uncategorizedCount": summary["uncategorizedCount"],
                "serverResponse": res,
            },
            ensure_ascii=False,
        )
    )


def cmd_cleanup(args) -> None:
    wd = safe_workdir(args.workdir)
    shutil.rmtree(wd, ignore_errors=True)
    print(json.dumps({"phase": "cleanup", "removed": wd}))


def main() -> None:
    p = argparse.ArgumentParser(description="Plusim report-job pipeline")
    sub = p.add_subparsers(dest="cmd", required=True)

    prep = sub.add_parser("prepare")
    prep.add_argument("--manifest-url")
    prep.add_argument("--manifest-file", help="local manifest JSON (test mode)")
    prep.add_argument("--workdir", required=True)

    fin = sub.add_parser("finalize")
    fin.add_argument("--workdir", required=True)
    fin.add_argument("--dry-run", action="store_true")

    cl = sub.add_parser("cleanup")
    cl.add_argument("--workdir", required=True)

    args = p.parse_args()
    if args.cmd == "prepare":
        if not args.manifest_url and not args.manifest_file:
            p.error("prepare needs --manifest-url or --manifest-file")
        cmd_prepare(args)
    elif args.cmd == "finalize":
        cmd_finalize(args)
    else:
        cmd_cleanup(args)


if __name__ == "__main__":
    main()
