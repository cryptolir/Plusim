# -*- coding: utf-8 -*-
"""Parse a bank current-account ("תנועות בחשבון") PDF — Bank Hapoalim or Bank
Leumi — into normalized transactions (docs/plans/bank-statements.md A1).

Both exports are text-layer PDFs (no OCR here); pypdf glues each table row into
ONE line, newest row first, running balance after the row:

  Hapoalim  dd/mm/yyyy<description><amount>₪<balance>##N      ##1 credit, ##2 debit
  Leumi     dd/mm/yyyy dd/mm/yyyy<description><reference><amount><balance>
            (reference and amount GLUED; U+200B before negatives; no sign marker)

Rules implemented here:
  - sign: pipeline convention — a debit is POSITIVE agorot, a credit NEGATIVE.
    Hapoalim: from the ##N marker. Leumi: from the balance delta
    (amount = −(balance_this − balance_older)); the glued text must end with the
    formatted |amount| or a warning names the row. The reference (the glued text
    minus that suffix) is a counterparty id, not a voucher — it rides `note`.
  - Leumi oldest row (no older balance): the reference of a sibling row with the
    same description is stripped from the glued text, the remainder is the
    amount, the sign follows the sibling majority; with no sibling the row is
    DROPPED with a warning naming it. Never a heuristic split.
  - date = the first (transaction) date; Leumi's second is the value date.
  - source label `hapoalim-<last4>` / `leumi-<last4>`; dedup key
    `label|date|description|amount|seq` for both banks.
  - no printed total ⇒ source_totals[label] = None; completeness = the
    running-balance chain (bank_rows.check_balance_chain); a break is a warning.
  - direction/kind per bank_rows.classify_bank_row: an issuer DEBIT is a
    settlement (kept out of transactions by run_job), a credit is undecided
    income-or-refund, anything else an expense.
"""
from __future__ import annotations

import re

from pypdf import PdfReader

from bank_rows import check_balance_chain, classify_bank_row
from parse_isracard_xlsx import ParseResult, Txn

HAPOALIM_MARKER = "bankhapoalim.co.il"
LEUMI_MARKER = "בנק לאומי"
STATEMENT_MARKER = "תנועות בחשבון"

HAPOALIM_ROW_RE = re.compile(r"^(\d{2}/\d{2}/\d{4})(.+?)([\d,]+\.\d{2})₪(-?[\d,]+\.\d{2})##([12])$")
# Locates a Leumi row and its balance only — the amount is derived from the
# balance chain because the reference is glued to it (see module doc).
LEUMI_ROW_RE = re.compile(
    r"^(\d{2}/\d{2}/\d{4})(\d{2}/\d{2}/\d{4})(.+?)(\d+)([\d,]+\.\d{2})(-?[\d,]+\.\d{2})\s*$"
)
ZWSP = "​"


def _agorot(s: str) -> int:
    return round(float(s.replace(",", "")) * 100)


def _fmt(agorot: int) -> str:
    """|agorot| as the statements print it: 14,304.47."""
    a = abs(agorot)
    return f"{a // 100:,}.{a % 100:02d}"


def _iso(d: str) -> str:
    dd, mm, yyyy = d.split("/")
    return f"{yyyy}-{mm}-{dd}"


def _text(path: str) -> tuple[str, list[str]]:
    reader = PdfReader(path)
    lines: list[str] = []
    for page in reader.pages:
        lines.extend((page.extract_text() or "").split("\n"))
    return "\n".join(lines), lines


def _layout(text: str, lines: list[str]) -> str | None:
    if STATEMENT_MARKER not in text:
        return None
    if HAPOALIM_MARKER in text and any(HAPOALIM_ROW_RE.match(ln.strip()) for ln in lines):
        return "hapoalim"
    if LEUMI_MARKER in text and any(LEUMI_ROW_RE.match(ln.replace(ZWSP, "").strip()) for ln in lines):
        return "leumi"
    return None


def detect_bank_pdf(path: str) -> bool:
    """True when this is a Hapoalim or Leumi current-account PDF this module can
    read: the statement marker, the bank's own marker, and at least one line
    matching that bank's row regex (keyed on what the parser branches on)."""
    try:
        text, lines = _text(path)
    except Exception:
        return False
    return _layout(text, lines) is not None


def parse_bank_pdf(path: str, label: str = "") -> ParseResult:
    """`label` is ignored for the source label (the account's last four digits
    are authoritative) and accepted only for a uniform parser signature."""
    text, lines = _text(path)
    layout = _layout(text, lines)
    if layout == "hapoalim":
        return _parse_hapoalim(path, lines)
    if layout == "leumi":
        return _parse_leumi(path, lines)
    res = ParseResult()
    res.warnings.append(f"{path}: not a recognized bank current-account PDF")
    return res


# ────────────────────────────────────────────────────────────────────
# Bank Hapoalim
# ────────────────────────────────────────────────────────────────────


def _hapoalim_label(lines: list[str]) -> str:
    for ln in lines[:40]:
        s = ln.strip()
        if re.fullmatch(r"\d{6,}", s):
            return f"hapoalim-{s[-4:]}"
    return "hapoalim"


def _parse_hapoalim(path: str, lines: list[str]) -> ParseResult:
    res = ParseResult()
    label = _hapoalim_label(lines)
    chain: list[tuple[int, int, str]] = []
    rows: list[tuple[str, str, int]] = []
    for ln in lines:
        m = HAPOALIM_ROW_RE.match(ln.strip())
        if not m:
            # Page headers, the "*2407 … bankhapoalim.co.il" line, the period
            # line and the lone page number match no row and are ignored.
            continue
        date_s, desc, amount_s, balance_s, marker = m.groups()
        amount = _agorot(amount_s)
        if marker == "1":  # זכות — money in
            amount = -amount
        date = _iso(date_s)
        desc = desc.strip()
        rows.append((date, desc, amount))
        chain.append((amount, _agorot(balance_s), f"{date} {desc}"))
    _emit(res, label, rows, notes=None)
    res.warnings.extend(check_balance_chain(chain, path))
    res.source_totals[label] = None
    if not res.transactions:
        res.warnings.append(f"{path}: no transactions parsed")
    return res


# ────────────────────────────────────────────────────────────────────
# Bank Leumi
# ────────────────────────────────────────────────────────────────────


def _leumi_label(lines: list[str]) -> str:
    for ln in lines[:40]:
        s = ln.replace(ZWSP, "")
        if "מס' חשבון" in s or "מס׳ חשבון" in s:
            digits = re.sub(r"\D", "", s.split(":")[0])
            if len(digits) >= 4:
                return f"leumi-{digits[-4:]}"
    return "leumi"


def _parse_leumi(path: str, lines: list[str]) -> ParseResult:
    res = ParseResult()
    label = _leumi_label(lines)

    # (date, desc, glued_ref_amount, balance) newest → oldest
    located: list[tuple[str, str, str, int]] = []
    for ln in lines:
        m = LEUMI_ROW_RE.match(ln.replace(ZWSP, "").strip())
        if not m:
            continue
        date_s, _value_date, desc, ref_part, amt_part, balance_s = m.groups()
        located.append((_iso(date_s), desc.strip(), ref_part + amt_part, _agorot(balance_s)))

    n = len(located)
    amounts: list[int | None] = [None] * n
    refs: list[str] = [""] * n
    # Every row with an older neighbour: the balance delta is the truth (bank
    # sign — a credit raises the balance — so negate for the pipeline).
    for i in range(n - 1):
        date, desc, glued, bal = located[i]
        bal_older = located[i + 1][3]
        amount = -(bal - bal_older)
        amounts[i] = amount
        suffix = _fmt(amount)
        if glued.endswith(suffix):
            refs[i] = glued[: -len(suffix)]
        else:
            res.warnings.append(
                f"{path}: {desc} {date}: amount {suffix} from the balance chain does not "
                f"end the printed text {glued!r} — check this row"
            )

    dropped: int | None = None
    if n:
        i = n - 1
        date, desc, glued, _bal = located[i]
        sib = [k for k in range(n - 1) if located[k][1] == desc and refs[k] and glued.startswith(refs[k])]
        if sib:
            ref = refs[sib[0]]
            rest = glued[len(ref) :]
            if re.fullmatch(r"[\d,]+\.\d{2}", rest):
                mag = _agorot(rest)
                negatives = sum(1 for k in sib if (amounts[k] or 0) < 0)
                amounts[i] = -mag if negatives * 2 > len(sib) else mag
                refs[i] = ref
            else:
                sib = []
        if not sib:
            dropped = i
            res.warnings.append(
                f"{path}: {desc} {date}: oldest row — no older balance and no sibling reference; excluded"
            )

    rows: list[tuple[str, str, int]] = []
    notes: list[str] = []
    chain: list[tuple[int, int, str]] = []
    for i, (date, desc, _glued, bal) in enumerate(located):
        if i == dropped or amounts[i] is None:
            continue
        rows.append((date, desc, amounts[i]))
        notes.append(f"אסמכתא {refs[i]}" if refs[i] else "")
        chain.append((amounts[i], bal, f"{date} {desc}"))
    _emit(res, label, rows, notes)
    res.warnings.extend(check_balance_chain(chain, path))
    res.source_totals[label] = None
    if not res.transactions:
        res.warnings.append(f"{path}: no transactions parsed")
    return res


# ────────────────────────────────────────────────────────────────────
# Shared
# ────────────────────────────────────────────────────────────────────


def _emit(res: ParseResult, label: str, rows: list[tuple[str, str, int]], notes: list[str] | None) -> None:
    seq: dict[str, int] = {}
    for i, (date, desc, amount) in enumerate(rows):
        base = f"{label}|{date}|{desc}|{amount}"
        seq[base] = seq.get(base, 0) + 1
        direction, kind = classify_bank_row(desc, amount)
        res.transactions.append(
            Txn(
                date=date,
                merchant=desc,
                amount_agorot=amount,
                source_label=label,
                dedup_key=f"{base}|{seq[base]}",
                note=notes[i] if notes else "",
                direction=direction,
                kind=kind,
            )
        )


if __name__ == "__main__":
    import json
    import sys

    r = parse_bank_pdf(sys.argv[1])
    print(
        json.dumps(
            {
                "transactions": [t.__dict__ for t in r.transactions],
                "sourceTotals": r.source_totals,
                "warnings": r.warnings,
            },
            ensure_ascii=False,
            indent=1,
        )
    )
