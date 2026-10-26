# -*- coding: utf-8 -*-
"""Plusim report-job orchestrator (see ../SKILL.md for the agent-facing flow).

Phases:
  prepare  — fetch manifest + statement files, parse everything, run the
             deterministic categorizer (dictionary → rules → MAX-category map),
             write state + needs_judgment.json (merchants only a human/model
             judgment can place). Exit code 0; prints a summary.
  judge-status — how much of the judgment shortlist is judged so far.
  finalize — merge judgments.json and every judgments-NNN.json, mark
             leftovers uncategorized,
             verify to-the-agora, build the xlsx, POST the result callback
             (or write result.json with --dry-run). Prints the outcome.
  cleanup  — delete downloaded statements + intermediates (PII hygiene).

Deterministic parsing/dedup/build/verify lives in code; the ONLY model step is
filling judgments-NNN.json for each shortlist batch. Never guess there — prefer
{"uncategorized": true} with a reason (reference/categorization-rules.md).
"""
from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import re
import shutil
import signal
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
from bank_rows import AmbiguousBankMergeError, merge_bank_exports  # noqa: E402
from build_report_xlsx import INCOME_SECTION, build_workbook  # noqa: E402
from parse_bank_pdf import detect_bank_pdf, parse_bank_pdf  # noqa: E402
from parse_discount_xlsx import parse_discount_xlsx  # noqa: E402
from parse_isracard_xlsx import parse_isracard_xlsx  # noqa: E402
from parse_leumi_pdf import detect_leumi_pdf, parse_leumi_pdf  # noqa: E402
from parse_max_pdf import detect_max_pdf, parse_max_pdf  # noqa: E402
from pypdf import PdfReader  # noqa: E402
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
    # Bank current-account debits (docs/plans/bank-statements.md A2) — rows no
    # card statement carries. Expense direction only: RULES never place a credit.
    ("לאומי למשכנתאו", 'שכ"ד/משכנתא'),
    ("פרעון הלוואה", "הלוואות"),
    ("פריסה לתשלומים", "הלוואות"),
    ("ע.מפעולות", "עמלות+ריביות"),
    ("עמל.ערוץ", "עמלות+ריביות"),
    ("ריבית חובה", "עמלות+ריביות"),
    ("שיק", "צ'קים ללא מעקב"),
    ("העב' לאחר", "העברות בנקאיות"),
]

# Bank CREDIT rows run these and ONLY these (never RULES: a reimbursement from
# "שירותי בריאות" must not be auto-filed as the expense leaf — it is the model's
# call whether a credit is income or a refund). A hit makes the row income.
INCOME_RULES: list[tuple[str, str]] = [
    ("קצבת ילדים", "קצבת ילדים"),
    ("ביטוח לאומי", "הכנסות נוספות"),
    ("בטוח לאומי", "הכנסות נוספות"),  # spelling without yod, as printed by Hapoalim
    ('זיכוי מאוצה"ח', "הכנסות נוספות"),
    ("מס-הכנסה החז", "הכנסות נוספות"),
]

# Shortlist / judgments.json key for a credit row: "<merchant>␟credit". U+241F is
# never produced by normalize_merchant, so an expense key and a credit key for
# the same counterparty can never collide (plan Rev 3).
CREDIT_KEY_SEP = "\u241f"

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

# The exact shape of the one directory name the model is ever asked to produce
# (SKILL.md: /tmp/plusim-job-<jobId>). fullmatch, not search — the incident this
# guards against was a directory named ",timeout:300}" glued onto a valid job
# id by a shell/JSON quoting slip; that value passed the "is it under /tmp?"
# check above (it was), so it needs its own rejection.
_JOB_DIRNAME_RE = re.compile(r"^plusim-job-[A-Za-z0-9]+$")


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
    if not _JOB_DIRNAME_RE.fullmatch(os.path.basename(wd)):
        raise UnsafeWorkdirError(
            f"--workdir must be exactly {SCRATCH_ROOT}/plusim-job-<jobId>, with "
            f"nothing else appended to the name — a stray shell/JSON fragment "
            f"glued onto a valid job id (e.g. '...,timeout:180}}') has silently "
            f"left a customer statement behind before. Got: {raw!r}"
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


class ScannedPdfError(Exception):
    """A PDF with no text layer (a scan or a photo). The parsers read text only;
    OCR is a later plan, and this is the one place it would hook in."""

    def __init__(self, name: str):
        super().__init__(
            f"{name}: קובץ PDF סרוק (אין בו שכבת טקסט). הפרסר אינו מבצע OCR — "
            "ייצאו מחדש מאתר הבנק/החברה"
        )


class ParseFileError(Exception):
    """One statement file could not be read. The message always starts with the
    file's name, so the job's error says which file to replace
    (docs/plans/scale-large-statements.md A5)."""

    def __init__(self, name: str, reason: str):
        super().__init__(f"{name}: {reason}")
        self.name = name
        self.reason = reason


class _ParseTimeout(BaseException):
    """Raised by the SIGALRM handler. A BaseException, so a parser's own broad
    `except Exception` cannot swallow the timeout."""


# Errors that already name their file — passed through as they are.
_NAMED_FILE_ERRORS = (ParseFileError, UnknownStatementError, ScannedPdfError)

DEFAULT_PARSE_TIMEOUT_S = 120.0
MAX_PDF_PAGES = 600
# A page with fewer characters than this carries no usable text layer.
SCANNED_PAGE_CHARS = 20


def parse_timeout_s() -> float:
    try:
        v = float(os.environ.get("PLUSIM_PARSE_TIMEOUT_S", ""))
    except ValueError:
        return DEFAULT_PARSE_TIMEOUT_S
    return v if v > 0 else DEFAULT_PARSE_TIMEOUT_S


def parse_with_limits(name: str, fn, kind: str = "file"):
    """Run one file's parse under a wall-clock limit; any failure names the file.

    `prepare` aborts on the first failing file — a partial report is worse than
    an error that says which statement to re-export.
    """
    timeout = parse_timeout_s()

    def on_alarm(_signum, _frame):
        raise _ParseTimeout()

    previous = signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, timeout)
    try:
        return fn()
    except _ParseTimeout:
        raise ParseFileError(name, f"parse timed out after {timeout:g}s") from None
    except _NAMED_FILE_ERRORS:
        raise
    except Exception as e:
        raise ParseFileError(name, f"unreadable {kind} ({type(e).__name__})") from e
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def check_pdf_pages(path: str, name: str) -> None:
    pages = len(PdfReader(path).pages)
    if pages > MAX_PDF_PAGES:
        raise ParseFileError(name, f"more than {MAX_PDF_PAGES} pages")


def is_scanned_pdf(path: str) -> bool:
    """True when no page carries a text layer. A file that cannot be read at
    all is not proven scanned — it falls through to the generic refusal."""
    try:
        pages = PdfReader(path).pages
        return len(pages) > 0 and all(
            len((p.extract_text() or "").strip()) < SCANNED_PAGE_CHARS for p in pages
        )
    except Exception:
        return False


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
    # Bank FIRST: both real bank exports contain "ישראכרט" settlement rows and
    # dd/mm/yyyy dates, so a card detector run first could claim them (plan
    # Rev 4 P1). The card detectors are tightened too, so order is belt and braces.
    if detect_bank_pdf(path):
        return parse_bank_pdf(path, label)
    if detect_leumi_pdf(path):
        return parse_leumi_pdf(path, label)
    if detect_max_pdf(path):
        return parse_max_pdf(path, label)
    # Checked only once no detector matched, so a real statement never pays for it.
    if is_scanned_pdf(path):
        raise ScannedPdfError(name)
    raise UnknownStatementError(
        f"{name}: unrecognized PDF — not a MAX or Leumi/Isracard card statement and "
        "not a Bank Hapoalim / Bank Leumi current-account (עובר ושב) export. "
        "Supported bank exports: Hapoalim and Leumi as PDF, Discount as xlsx."
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


def income_leaves(taxonomy: list[dict]) -> set[str]:
    return {leaf for sec in taxonomy if sec["section"] == INCOME_SECTION for leaf in sec["leaves"]}


def judgment_key(merchant: str, kind: str) -> str:
    """The shortlist / judgments.json key: "<merchant>" for an expense row,
    "<merchant>␟credit" for a credit row (plan A2)."""
    m = normalize_merchant(merchant)
    return m + CREDIT_KEY_SEP + "credit" if kind == "credit" else m


def normalize_judgment_key(raw: str) -> str:
    head, sep, tail = raw.partition(CREDIT_KEY_SEP)
    return normalize_merchant(head) + (sep + tail.strip() if sep else "")


def categorize(
    txns: list[dict], dictionary: dict[str, str], leaves: set[str], income: set[str] | None = None
) -> list[dict]:
    """Deterministic pass. Returns the still-unresolved shortlist, one entry per
    (merchant, kind) key.

    Kind-aware (plan A2): expense rows (every card row, bank debits) run
    dictionary → RULES → MAX map but never take an income leaf; credit rows
    (bank credits) run INCOME_RULES only — a hit makes them income, anything
    else is the model's call (income leaf, or an expense leaf with "refund").
    """
    income = income if income is not None else set()
    unresolved: dict[str, dict] = {}
    for t in txns:
        if t.get("category") or t.get("uncategorized"):
            continue
        merchant = normalize_merchant(t["merchant"])
        kind = t.get("kind") or "expense"
        if kind == "credit":
            for pattern, leaf in INCOME_RULES:
                if pattern in merchant and leaf in income:
                    t["category"] = leaf
                    t["kind"] = "income"
                    break
            if t.get("category"):
                continue
        else:
            hit = dictionary.get(merchant)
            if hit and hit in leaves and hit not in income:
                t["category"] = hit
                continue
            for pattern, leaf in RULES:
                if (pattern in merchant or pattern.upper() in merchant.upper()) and leaf not in income:
                    t["category"] = leaf
                    break
            if t.get("category"):
                continue
            mapped = MAX_CATEGORY_MAP.get(t.get("max_category", ""))
            if mapped:
                t["category"] = mapped
                continue
        key = judgment_key(merchant, kind)
        entry = unresolved.setdefault(
            key,
            {
                "key": key,
                "merchant": merchant,
                "kind": kind,
                "samples": [],
                "maxCategory": t.get("max_category", ""),
                "count": 0,
                "totalAgorot": 0,
            },
        )
        entry["count"] += 1
        entry["totalAgorot"] += abs(t["amountAgorot"])
        if len(entry["samples"]) < 5:
            entry["samples"].append(
                {"date": t["date"], "amountAgorot": t["amountAgorot"], "note": t.get("note", "")}
            )
    return list(unresolved.values())


# The app resolves at most this many merchants per dictionary request, each at
# most MAX_MERCHANT_LEN characters (POST /api/agent/jobs/:jobId/dictionary).
DICTIONARY_CHUNK = 500
MAX_MERCHANT_LEN = 200


def resolve_dictionary(manifest: dict, txns: list[dict]) -> dict[str, str]:
    """merchant → approved category, for this job's expense merchants.

    A manifest with `dictionaryResolveUrl` is asked about exactly the merchants
    present, in chunks — no cap on the dictionary's size. An older app sends
    only the inline `merchantDictionary` (its 2,000 most recent entries); that
    path is unchanged (plan A3).
    """
    url = manifest.get("dictionaryResolveUrl")
    if not url:
        return {
            normalize_merchant(d["merchantPattern"]): d["category"]
            for d in manifest.get("merchantDictionary", [])
        }
    # Credits never take a dictionary category (one direction per merchant).
    merchants = sorted(
        {
            t["merchant"]
            for t in txns
            if (t.get("kind") or "expense") != "credit" and 0 < len(t["merchant"]) <= MAX_MERCHANT_LEN
        }
    )
    hits: dict[str, str] = {}
    for i in range(0, len(merchants), DICTIONARY_CHUNK):
        res = http_json(url, {"merchants": merchants[i : i + DICTIONARY_CHUNK]})
        for merchant, category in (res.get("hits") or {}).items():
            if isinstance(merchant, str) and isinstance(category, str):
                hits[normalize_merchant(merchant)] = category
    return hits


# Judgment batches: the shortlist is split so one model read never has to hold
# hundreds of merchants (plan A2). Biggest money first, so an unfinished run
# leaves only the small amounts unjudged.
JUDGMENT_BATCH_SIZE = 40
BATCH_DIR = "judgment_batches"
_JUDGMENTS_FILE_RE = re.compile(r"^judgments-(\d{3})\.json$")


def batch_name(n: int) -> str:
    return f"batch-{n:03d}.json"


def judgments_name(n: int) -> str:
    return f"judgments-{n:03d}.json"


def write_judgment_batches(wd: str, shortlist: list[dict], report_rules: str) -> int:
    # A re-run of prepare in the same workdir starts the judgment over: old
    # batches and old judgments would no longer match the new shortlist.
    shutil.rmtree(os.path.join(wd, BATCH_DIR), ignore_errors=True)
    for old in glob.glob(os.path.join(wd, "judgments*.json")):
        os.remove(old)
    os.makedirs(os.path.join(wd, BATCH_DIR))

    ordered = sorted(shortlist, key=lambda e: (-e["totalAgorot"], e["key"]))
    batches = [ordered[i : i + JUDGMENT_BATCH_SIZE] for i in range(0, len(ordered), JUDGMENT_BATCH_SIZE)]
    for n, merchants in enumerate(batches, 1):
        with open(os.path.join(wd, BATCH_DIR, batch_name(n)), "w", encoding="utf-8") as f:
            json.dump(
                {"batch": n, "of": len(batches), "reportRules": report_rules, "merchants": merchants},
                f,
                ensure_ascii=False,
                indent=1,
            )
    with open(os.path.join(wd, "needs_judgment.json"), "w", encoding="utf-8") as f:
        json.dump(
            {"reportRules": report_rules, "batches": len(batches), "entries": len(ordered), "batchDir": BATCH_DIR},
            f,
            ensure_ascii=False,
            indent=1,
        )
    return len(batches)


def load_judgments(wd: str) -> tuple[dict[str, dict], list[str]]:
    """judgments.json, then judgments-NNN.json in batch order. A key decided in
    two files keeps the first decision and is reported."""
    paths = []
    if os.path.exists(os.path.join(wd, "judgments.json")):
        paths.append("judgments.json")
    paths += sorted(n for n in os.listdir(wd) if _JUDGMENTS_FILE_RE.match(n))
    merged: dict[str, dict] = {}
    origin: dict[str, str] = {}
    warnings: list[str] = []
    for name in paths:
        with open(os.path.join(wd, name), encoding="utf-8") as f:
            for raw, decision in json.load(f).items():
                key = normalize_judgment_key(raw)
                if key in merged:
                    warnings.append(f"judgment for {key} appears in {origin[key]} and {name} — the first was kept")
                    continue
                merged[key] = decision
                origin[key] = name
    return merged, warnings


def _summarize(keys: list[str], limit: int = 5) -> str:
    shown = ", ".join(keys[:limit])
    return shown + (f" (+{len(keys) - limit})" if len(keys) > limit else "")


def cmd_judge_status(args) -> None:
    wd = safe_workdir(args.workdir)
    with open(os.path.join(wd, "needs_judgment.json"), encoding="utf-8") as f:
        index = json.load(f)
    shortlist: set[str] = set()
    judged_batches = 0
    next_batch = None
    for n in range(1, index["batches"] + 1):
        with open(os.path.join(wd, BATCH_DIR, batch_name(n)), encoding="utf-8") as f:
            shortlist |= {e["key"] for e in json.load(f)["merchants"]}
        if os.path.exists(os.path.join(wd, judgments_name(n))):
            judged_batches += 1
        elif next_batch is None:
            next_batch = os.path.join(wd, BATCH_DIR, batch_name(n))
    judgments, _ = load_judgments(wd)
    judged = len(shortlist & judgments.keys())
    print(
        json.dumps(
            {
                "phase": "judge-status",
                "batches": index["batches"],
                "judgedBatches": judged_batches,
                "entriesJudged": judged,
                "remaining": len(shortlist) - judged,
                "next": next_batch,
            },
            ensure_ascii=False,
        )
    )


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
    settlements: list[dict] = []
    source_totals: dict[str, int | None] = {}
    charge_cycles: dict[str, list[dict]] = {}
    bank_labels: set[str] = set()
    warnings: list[str] = []
    max_seq = 0
    parsed: list[tuple[str, object]] = []
    for file in manifest["files"]:
        name = file["name"]
        dest = safe_dest(files_dir, name)
        try:
            http_download(file.get("url") or file["path"], dest)
        except Exception as e:
            raise ParseFileError(name, f"download failed ({type(e).__name__})") from e
        if file["mime"].endswith("pdf"):
            max_seq += 1
            label = file.get("sourceLabel") or f"max-{max_seq}"

            def parse_pdf(dest=dest, label=label, name=name):
                check_pdf_pages(dest, name)
                return parse_pdf_auto(dest, label, name)

            r = parse_with_limits(name, parse_pdf, "PDF")
        else:
            r = parse_with_limits(name, lambda dest=dest: parse_xlsx_auto(dest), "xlsx")
        # A recognized layout that still yields nothing is not fatal (a genuinely
        # empty billing period exists), but it must never pass silently — this is
        # the warning that would have named the file behind "transactions empty".
        if not r.transactions:
            warnings.append(f"{file['name']}: parsed 0 transactions — check the file covers a billed period")
        parsed.append((file["name"], r))

    # Overlapping exports of ONE bank account are collapsed here, before anything
    # is categorized or deduplicated by key: each day's rows come from exactly one
    # export, and an ambiguous day refuses the whole run naming the files
    # (docs/plans/scale-large-statements.md A1). Card sources are untouched.
    overlap_notes, merge_warnings, overlap_removed = merge_bank_exports(parsed)
    warnings.extend(overlap_notes)
    warnings.extend(merge_warnings)
    merged_bank_labels = {
        lbl for _, r in parsed for lbl in getattr(r, "bank_labels", ())
    }
    seen_labels: set[str] = set()

    for _name, r in parsed:
        for t in r.transactions:
            kind = getattr(t, "kind", "expense")
            if kind == "settlement":
                # A bank debit paying a card statement: every shekel of it is
                # itemized on the card statement, so it never enters the
                # transaction stream. Kept for the reconciliation card (plan A2).
                settlements.append(
                    {
                        "date": t.date,
                        "month": t.date[:7],
                        "payee": normalize_merchant(t.merchant),
                        "amountAgorot": t.amount_agorot,
                        "sourceLabel": t.source_label,
                        "dedupKey": t.dedup_key,
                    }
                )
                continue
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
                    # "expense" (default, every card row) | "credit" (a bank
                    # credit the model still has to place) — becomes "income"
                    # or stays "expense" (refund) once categorized.
                    "kind": kind,
                    # Only PDF card parsers set this; xlsx parsers have no such
                    # attribute, hence getattr with a False default.
                    "undatedInstallment": getattr(t, "undated_installment", False),
                }
            )
        for label, total in r.source_totals.items():
            # A bank label shared by several exports was merged above (and its
            # overlap noted); only a CARD label seen twice is still a surprise.
            if label in seen_labels and label not in merged_bank_labels:
                warnings.append(f"duplicate source label {label} across files")
            seen_labels.add(label)
            source_totals[label] = total
        for label, cycles in getattr(r, "charge_cycles", {}).items():
            if cycles:
                charge_cycles[label] = cycles
        bank_labels |= set(getattr(r, "bank_labels", ()))
        warnings.extend(r.warnings)

    leaves = {leaf for sec in manifest["taxonomy"] for leaf in sec["leaves"]}
    dictionary = resolve_dictionary(manifest, all_txns)
    shortlist = categorize(all_txns, dictionary, leaves, income_leaves(manifest["taxonomy"]))

    # Admin-authored extra categorization rules (edited in the Plusim app's
    # /admin/settings, carried in the manifest). The model applies these ON TOP
    # of reference/categorization-rules.md during the judgment step; an empty
    # string ⇒ the static playbook only (behavior unchanged from before).
    report_rules = manifest.get("reportRules") or ""

    state = {
        "txns": all_txns,
        "settlements": settlements,
        "sourceTotals": source_totals,
        "chargeCycles": charge_cycles,
        "bankLabels": sorted(bank_labels),
        "warnings": warnings,
    }
    with open(os.path.join(wd, "state.json"), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    batches = write_judgment_batches(wd, shortlist, report_rules)

    print(
        json.dumps(
            {
                "phase": "prepare",
                "files": len(manifest["files"]),
                "transactions": len(all_txns),
                "settlements": len(settlements),
                "bankOverlapRemoved": overlap_removed,
                "autoCategorized": sum(1 for t in all_txns if t["category"]),
                "needsJudgment": len(shortlist),
                "judgmentBatches": batches,
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

    judgments, judgment_warnings = load_judgments(wd)
    # The shortlist is exactly the rows the deterministic pass left open.
    shortlist = {
        judgment_key(t["merchant"], t.get("kind") or "expense")
        for t in state["txns"]
        if not t["category"] and not t["uncategorized"]
    }
    unknown = sorted(judgments.keys() - shortlist)
    if unknown:
        judgment_warnings.append(f"{len(unknown)} judgments name merchants not in the shortlist — ignored: {_summarize(unknown)}")
    unjudged = len(shortlist - judgments.keys())
    if unjudged:
        judgment_warnings.append(f"{unjudged} בתי עסק לא נבדקו — נשארו ללא סיווג")

    leaves = {leaf for sec in manifest["taxonomy"] for leaf in sec["leaves"]}
    income = income_leaves(manifest["taxonomy"])
    proposed: list[dict] = []

    def add_note(t: dict, text: str) -> None:
        t["note"] = (t.get("note") or "") + (" · " if t.get("note") else "") + text

    for t in state["txns"]:
        if t["category"] or t["uncategorized"]:
            continue
        kind = t.get("kind") or "expense"
        j = judgments.get(judgment_key(t["merchant"], kind))
        decided = bool(j) and j.get("category") in leaves and not j.get("uncategorized")
        if decided and kind == "credit":
            # A credit decision is either an income leaf (⇒ income) or an
            # expense leaf flagged "refund": true (⇒ a negative in that leaf,
            # like a card refund). Any other shape is rejected, not guessed.
            if j["category"] in income:
                t["kind"] = "income"
            elif j.get("refund") is True:
                t["kind"] = "expense"
            else:
                decided = False
                j = {"note": f"זיכוי סווג ל-{j['category']} ללא דגל refund — נדרשת הכרעה"}
        elif decided and j["category"] in income:
            # An expense row (card or bank debit) can never be income.
            decided = False
            j = {"note": f"חיוב סווג לענף הכנסות {j['category']} — לא ייתכן"}
        if decided:
            t["category"] = j["category"]
            if j.get("note"):
                add_note(t, j["note"])
            # The dictionary is one direction per merchant (unique pattern), so
            # only expense decisions may be proposed into it (plan A2).
            if j.get("propose") and kind != "credit":
                entry = {"merchant": normalize_merchant(t["merchant"]), "category": j["category"], "evidence": j.get("note", "")}
                if entry not in proposed:
                    proposed.append(entry)
        else:
            t["uncategorized"] = True
            add_note(t, (j or {}).get("note") or "לא זוהה סיווג ודאי")

    settlements = state.get("settlements", [])
    bank_labels = set(state.get("bankLabels", []))
    ok, problems, summary = verify(
        state["txns"], state["sourceTotals"], manifest["taxonomy"], settlements=settlements, bank_labels=bank_labels
    )

    # An installment left on its deal date may sit in the wrong MONTH, so say so
    # — but do NOT flip `ok`: a missing charge date must never block the report
    # (owner 2026-08-04). It rides agentNotes to the admin, and the app raises
    # the same thing as a non-blocking note naming the rows to correct.
    undated = [t for t in state["txns"] if t.get("undatedInstallment")]
    if undated:
        problems.append(
            f"{len(undated)} תשלומים ללא תאריך חיוב — נותרו בתאריך העסקה המקורי; "
            f"ניתן לתקן בעמוד העבודה"
        )

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
                # "income" / "credit" explicit, "expense" omitted — an app that
                # predates the field sees the exact payload it always did.
                **({"kind": t["kind"]} if t.get("kind") in ("income", "credit") else {}),
                # Transient integrity flag — the app turns it into a FATAL
                # verification problem so an installment stuck on its deal date
                # (wrong month) can never be published. Omitted when false so
                # the payload shape is unchanged for ordinary rows.
                **({"undatedInstallment": True} if t.get("undatedInstallment") else {}),
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
                # One per charge block of a card source; Σ == the total (B2).
                **(
                    {"chargeCycles": state["chargeCycles"][label]}
                    if state.get("chargeCycles", {}).get(label)
                    else {}
                ),
                # A bank current-account source — the only kind income may
                # come from. Explicit, never inferred from a missing total.
                **({"bank": True} if label in bank_labels else {}),
            }
            for label, total in state["sourceTotals"].items()
        ],
        "settlements": settlements,
        "xlsxBase64": xlsx_b64,
        "xlsxFilename": f"plusim-report-{manifest['job']['id']}.xlsx",
        "proposedMappings": proposed,
        "agentNotes": "; ".join(state["warnings"] + judgment_warnings + problems) or None,
    }

    if args.dry_run:
        out = os.path.join(wd, "result.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        print(json.dumps({"phase": "finalize", "dryRun": True, "status": payload["status"], "problems": problems, "judgmentWarnings": judgment_warnings, **{k: summary[k] for k in ("txCount", "uncategorizedCount")}}, ensure_ascii=False))
        return

    res = http_json(manifest["callback"]["resultUrl"], payload)
    print(
        json.dumps(
            {
                "phase": "finalize",
                "status": payload["status"],
                "problems": problems,
                "judgmentWarnings": judgment_warnings,
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

    js = sub.add_parser("judge-status")
    js.add_argument("--workdir", required=True)

    cl = sub.add_parser("cleanup")
    cl.add_argument("--workdir", required=True)

    args = p.parse_args()
    if args.cmd == "prepare":
        if not args.manifest_url and not args.manifest_file:
            p.error("prepare needs --manifest-url or --manifest-file")
        try:
            cmd_prepare(args)
        except (*_NAMED_FILE_ERRORS, AmbiguousBankMergeError) as e:
            # A statement problem, not a script crash: one line that names the
            # file, and a retry cannot fix it (SKILL.md failure handling).
            print(json.dumps({"phase": "prepare", "error": str(e)}, ensure_ascii=False))
            sys.exit(2)
    elif args.cmd == "finalize":
        cmd_finalize(args)
    elif args.cmd == "judge-status":
        cmd_judge_status(args)
    else:
        cmd_cleanup(args)


if __name__ == "__main__":
    main()
