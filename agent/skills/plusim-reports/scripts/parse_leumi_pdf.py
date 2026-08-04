# -*- coding: utf-8 -*-
"""Parse a Leumi/Isracard "פירוט החיובים" PDF into normalized transactions.

This handles the Leumi card-statement format which uses slash dates (dd/mm/yy),
a two-section layout (בחו"ל / בארץ), and line-by-line text extraction.

Foreign ("בחו"ל רכישות") rows:
  date → type-letter → merchant → blank → city → original-amount → ₪ →
  blanks → charge-amount

Domestic ("בארץ - זוכו / שחויבו עסקות") rows:
  date → blank → card-type → merchant → branch-category → tx-amount →
  charge-amount  Optionally followed by "הנחה"/"תשלום" details.

Section totals appear after each section as:
  סה"כ → חיוב → לתאריך → date → amount
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from pypdf import PdfReader


DATE_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{2})$")
AMOUNT_RE = re.compile(r"^-?[\d,]+\.\d{2}$")

CARD_TYPES = {"נייד.תש", "הוצג לא", "קבע.ה", "אינט"}

# Installment rows ("תשלום 8 מתוך 12", and the RTL-reordered credit wording
# "תשלום - קרדיט 6 מתוך 13"). The statement prints the ORIGINAL DEAL date on
# these, not the date they are actually charged — so they must be re-dated to
# their block's charge date (see _block_charge_date). The gap between "תשלום"
# and the number is bounded so unrelated text cannot bridge a false match; it
# must mirror installmentInfo() in src/lib/reportAnalysis.ts, which drives the
# UI badge off the same note text.
INSTALLMENT_RE = re.compile(r"תשלום(?:[^0-9]{0,20})(\d{1,3})\s*מתוך\s*(\d{1,3})")


@dataclass
class Txn:
    date: str
    merchant: str
    amount_agorot: int
    source_label: str
    dedup_key: str
    note: str = ""
    max_category: str = ""
    # True when this row is an installment that no charge date could be found
    # for — not the block's, not the statement header's — so it still holds its
    # ORIGINAL DEAL date and may sit in the wrong month. Transient: it rides the
    # result payload so the app can surface a non-blocking note pointing the
    # admin at the date editor. Never stored, never blocks (owner 2026-08-04).
    undated_installment: bool = False


@dataclass
class ParseResult:
    transactions: list[Txn] = field(default_factory=list)
    source_totals: dict[str, int | None] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def _to_agorot(s: str) -> int:
    return round(float(s.replace(",", "")) * 100)


def detect_leumi_pdf(path: str) -> bool:
    """Check if a PDF is a Leumi/Isracard statement (vs MAX)."""
    try:
        reader = PdfReader(path)
        text = (reader.pages[0].extract_text() or "")[:2000]
        if "אשראי לאומי" in text or "ישראכרט" in text:
            if re.search(r"\d{2}/\d{2}/\d{2}", text):
                return True
        return False
    except Exception:
        return False


def parse_leumi_pdf(path: str, label: str) -> ParseResult:
    reader = PdfReader(path)
    all_lines: list[str] = []
    for page in reader.pages:
        for ln in (page.extract_text() or "").split("\n"):
            all_lines.append(ln)

    res = ParseResult()
    foreign_label = f"{label}-foreign"
    domestic_label = f"{label}-domestic"

    # ── Phase 1: Find section boundaries ──
    # We identify: foreign-start, foreign-end/total, domestic-start, domestic-end/total
    foreign_start = None
    domestic_start = None
    credit_terms_start = len(all_lines)

    for i, line in enumerate(all_lines):
        s = line.strip()
        if 'בחו"ל' in s and 'רכישות' in s:
            foreign_start = i
        if ("בארץ" in s and ("זוכו" in s or "שחויבו" in s or "עסקות" in s)) and domestic_start is None:
            domestic_start = i
        if "האשראי תנאי" in s:
            credit_terms_start = i
            break

    # ── Phase 2: Parse foreign transactions ──
    foreign_total: int | None = None
    if foreign_start is not None:
        end = domestic_start if domestic_start is not None else credit_terms_start
        f_txns, f_total = _parse_foreign_section(all_lines, foreign_start, end, foreign_label)
        res.transactions.extend(f_txns)
        foreign_total = f_total

    # ── Phase 3: Parse domestic transactions ──
    # The statement's header date backs up any total block that prints none.
    stmt_date = _statement_date(all_lines)
    domestic_total: int | None = None
    if domestic_start is not None:
        d_txns, d_total = _parse_domestic_section(
            all_lines, domestic_start, credit_terms_start, domestic_label, stmt_date
        )
        res.transactions.extend(d_txns)
        domestic_total = d_total

    # ── Phase 4: Assign dedup keys ──
    seq: dict[str, int] = {}
    for txn in res.transactions:
        base = f"{txn.source_label}|{txn.date}|{txn.merchant}|{txn.amount_agorot}"
        seq[base] = seq.get(base, 0) + 1
        txn.dedup_key = f"{base}|{seq[base]}"

    # ── Phase 5: Source totals ──
    if res.transactions:
        has_foreign = any("foreign" in t.source_label for t in res.transactions)
        has_domestic = any("domestic" in t.source_label for t in res.transactions)
        if has_foreign:
            res.source_totals[foreign_label] = foreign_total
        if has_domestic:
            res.source_totals[domestic_label] = domestic_total
        if has_foreign and foreign_total is None:
            res.warnings.append(f"{path}: no foreign section total found")
        if has_domestic and domestic_total is None:
            res.warnings.append(f"{path}: no domestic section total found")

    undated = sum(1 for t in res.transactions if t.undated_installment)
    if undated:
        res.warnings.append(
            f"{path}: {undated} תשלומים ללא תאריך חיוב — נותרו בתאריך העסקה המקורי; "
            f"ניתן לתקן את התאריך בעמוד העבודה"
        )

    return res


# ────────────────────────────────────────────────────────────────────
# Foreign section parser
# ────────────────────────────────────────────────────────────────────

def _parse_foreign_section(
    lines: list[str], start: int, end: int, label: str
) -> tuple[list[Txn], int | None]:
    """Parse the foreign-transactions section.

    Each row block starts with a date line (dd/mm/yy) followed by:
      type-letter → merchant → blank → city → original-amount ₪ → blanks → charge-amount
    The section total is the amount on the line right after the סה"כ block.
    """
    txns: list[Txn] = []
    section_total: int | None = None
    i = start

    # Skip to first transaction date (skip header lines)
    while i < end:
        s = lines[i].strip()
        if DATE_RE.match(s):
            break
        i += 1

    while i < end:
        s = lines[i].strip()

        # Check for section total
        if 'סה"כ' in s:
            section_total = _extract_total(lines, i, min(i + 10, end))
            break

        dm = DATE_RE.match(s)
        if dm:
            dd, mm, yy = dm.groups()
            date = f"20{yy}-{mm}-{dd}"
            txn, skip = _read_foreign_row(lines, i, end, date, label)
            if txn:
                txns.append(txn)
            i += skip
        else:
            i += 1

    return txns, section_total


def _read_foreign_row(
    lines: list[str], start: int, end: int, date: str, label: str
) -> tuple[Txn | None, int]:
    """Read one foreign transaction row."""
    i = start + 1  # past the date
    consumed = 1

    # Type letter (single char: א, ק, ל, etc.)
    if i < end and len(lines[i].strip()) <= 2 and lines[i].strip():
        i += 1
        consumed += 1

    # Merchant (next non-empty line that isn't an amount)
    merchant = ""
    if i < end:
        m = lines[i].strip()
        if m and not AMOUNT_RE.match(m) and "₪" not in m:
            merchant = m
            i += 1
            consumed += 1

    # Consume remaining lines until next date or סה"כ, collecting amounts
    amounts: list[str] = []
    while i < end:
        s = lines[i].strip()
        if DATE_RE.match(s):
            break
        if 'סה"כ' in s:
            break
        if AMOUNT_RE.match(s):
            amounts.append(s)
        i += 1
        consumed += 1

    if not amounts or not merchant:
        return None, consumed

    # Last amount is the charge in NIS
    charge = _to_agorot(amounts[-1])

    return (
        Txn(
            date=date,
            merchant=merchant,
            amount_agorot=charge,
            source_label=label,
            dedup_key="",
            note='עסקת חו"ל',
            max_category="",
        ),
        consumed,
    )


# ────────────────────────────────────────────────────────────────────
# Domestic section parser
# ────────────────────────────────────────────────────────────────────

def _parse_domestic_section(
    lines: list[str], start: int, end: int, label: str, stmt_date: str | None = None
) -> tuple[list[Txn], int | None]:
    """Parse domestic ("בארץ") transactions.

    Each row block starts with a date line followed by:
      blank → card-type → merchant → branch-category → tx-amount → charge-amount
      → optional discount/installment info
    """
    txns: list[Txn] = []
    section_total: int | None = None
    i = start
    # Index into `txns` of the first row not yet closed by a total block.
    block_start = 0

    # Skip to first transaction date (past headers)
    while i < end:
        s = lines[i].strip()
        if DATE_RE.match(s):
            break
        i += 1

    while i < end:
        s = lines[i].strip()

        # The statement may contain several "לתאריך חיוב סה\"כ" blocks
        # (e.g. early-repayment subtotals before the regular rows). Do NOT
        # stop at the first one; the statement total is the SUM of these
        # charge-date totals.
        if 'לתאריך חיוב סה"כ' in s:
            total = _extract_total(lines, i, min(i + 12, end))
            if total is not None:
                section_total = (section_total or 0) + total
            # This block CLOSES every row parsed since the previous block, so it
            # supplies their charge date — never a statement-wide date. Rows on
            # either side of an early-repayment subtotal belong to different
            # charge cycles (plan Rev 2, Codex P1-a).
            _apply_charge_date(
                txns[block_start:], _block_charge_date(lines, i, min(i + 12, end)), stmt_date
            )
            block_start = len(txns)
            i += 1
            continue

        # Early-repayment fee blocks ("מע"מ כולל סה"כ") have no date line of
        # their own: fee → vat → total → "לתאריך חיוב סה"כ" → charge date.
        # Capture the fee as its own transaction so gross charge totals can
        # reconcile exactly.
        if 'מע"מ כולל סה"כ' in s:
            fee_amt: int | None = None
            for j in range(i - 1, max(-1, i - 14), -1):
                sj = lines[j].strip()
                if AMOUNT_RE.match(sj):
                    fee_amt = _to_agorot(sj)
                    break
            fee_date: str | None = None
            for j in range(i + 1, min(i + 12, end)):
                sj = lines[j].strip()
                dm_fee = DATE_RE.match(sj)
                if dm_fee:
                    dd, mm, yy = dm_fee.groups()
                    fee_date = f"20{yy}-{mm}-{dd}"
                    break
            if fee_amt is not None and fee_date is not None:
                txns.append(
                    Txn(
                        date=fee_date,
                        merchant="לעסקאות מוקדם פרעון",
                        amount_agorot=fee_amt,
                        source_label=label,
                        dedup_key="",
                        note="עמלת פרעון מוקדם",
                        max_category="עמלות",
                    )
                )
            i += 1
            continue

        dm = DATE_RE.match(s)
        if dm:
            dd, mm, yy = dm.groups()
            date = f"20{yy}-{mm}-{dd}"
            txn, skip = _read_domestic_row(lines, i, end, date, label)
            if txn:
                txns.append(txn)
            i += skip
        else:
            i += 1

    # Rows after the last total block have no block to close them, so they fall
    # straight through to the statement header date.
    _apply_charge_date(txns[block_start:], None, stmt_date)
    return txns, section_total


def _read_domestic_row(
    lines: list[str], start: int, end: int, date: str, label: str
) -> tuple[Txn | None, int]:
    """Read one domestic transaction row."""
    i = start + 1  # past date
    consumed = 1

    # Skip blanks
    while i < end and not lines[i].strip():
        i += 1
        consumed += 1

    # Card type
    card_type = ""
    if i < end:
        ct = lines[i].strip()
        if ct in CARD_TYPES:
            card_type = ct
            i += 1
            consumed += 1

    # Merchant name — the next line that isn't blank, isn't an amount, isn't a card type
    merchant = ""
    if i < end:
        m = lines[i].strip()
        if m and not AMOUNT_RE.match(m):
            merchant = m
            i += 1
            consumed += 1

    # Branch category (Leumi's classification, e.g. "דלק", "מכולת/סופר").
    # Some rows print a numeric branch code directly under the merchant
    # (e.g. "11.25" / "12.25") and THEN the category. If we mistake that
    # code for the transaction amount, the next amount shifts one column and
    # the row total becomes wrong. Consume such code lines only when a real
    # category line still follows before the transaction amounts.
    leumi_cat = ""
    if i < end:
        # Optional branch-number block: amount-looking line(s) followed by
        # another non-amount category line before this row's real amounts.
        probe = i
        while probe < end and not lines[probe].strip():
            probe += 1
        consumed = max(consumed, probe - start)
        i = probe
        if (
            probe < end
            and AMOUNT_RE.match(lines[probe].strip())
        ):
            look = probe + 1
            while look < end and not lines[look].strip():
                look += 1
            if (
                look < end
                and not AMOUNT_RE.match(lines[look].strip())
                and not DATE_RE.match(lines[look].strip())
                and lines[look].strip() not in CARD_TYPES
                and 'סה"כ' not in lines[look]
            ):
                # Treat the amount-looking line(s) as branch/category codes,
                # not transaction amounts.
                i = look
                consumed = i - start
        if i < end:
            c = lines[i].strip()
            if c and not AMOUNT_RE.match(c) and c not in CARD_TYPES and not DATE_RE.match(c):
                leumi_cat = c
                i += 1
                consumed += 1

    # Collect amounts + notes until next date or section marker
    amounts: list[str] = []
    note_parts: list[str] = []

    while i < end:
        s = lines[i].strip()
        if DATE_RE.match(s):
            break
        if 'סה"כ' in s:
            break

        if AMOUNT_RE.match(s):
            amounts.append(s)
        elif "תשלום" in s:
            inst = _read_installment(lines, i, end)
            if inst:
                note_parts.append(inst)
        # Skip "הנחה", "הוט מועדון", blank lines, etc.

        i += 1
        consumed += 1

    if not amounts or not merchant:
        return None, consumed

    # Domestic amounts:
    # - Regular: tx-amount, then charge-amount (usually same)
    # - Installment: tx-amount (total), then charge-amount (monthly)
    # → charge is amounts[1] if ≥2, else amounts[0]
    # But discount amounts ("הנחה 0.01") also appear as separate amounts.
    # The charge is the SECOND amount (index 1) — first is tx total, second is charged.
    if len(amounts) >= 2:
        charge = _to_agorot(amounts[1])
    else:
        charge = _to_agorot(amounts[0])

    note = " · ".join(note_parts) if note_parts else ""

    return (
        Txn(
            date=date,
            merchant=merchant,
            amount_agorot=charge,
            source_label=label,
            dedup_key="",
            note=note,
            max_category=leumi_cat,
        ),
        consumed,
    )


def _read_installment(lines: list[str], start: int, end: int) -> str:
    """Read 'תשלום X מתוך Y' across lines."""
    parts = []
    for j in range(start, min(start + 5, end)):
        s = lines[j].strip()
        if s:
            parts.append(s)
        if "מתוך" in s:
            if j + 1 < end and lines[j + 1].strip().isdigit():
                parts.append(lines[j + 1].strip())
            break
    return " ".join(parts) if parts else ""


def _extract_total(lines: list[str], start: int, end: int) -> int | None:
    """After a סה"כ line, find the next standalone amount."""
    for j in range(start + 1, end):
        s = lines[j].strip()
        if AMOUNT_RE.match(s):
            return _to_agorot(s)
    return None


def _apply_charge_date(
    rows: list[Txn], charge_date: str | None, fallback: str | None = None
) -> None:
    """Re-date the installment rows of one total block to its charge date.

    Non-installment rows are left alone — their printed date IS the charge for
    this cycle. Installment rows keep their deal date in the note so the row can
    still be traced back to the paper statement.

    Owner decision 2026-08-04, superseding the plan's fail-closed rule: a
    missing charge date must NOT block the report. The fallback chain is

        block charge date  →  statement header date  →  the deal date it has

    `fallback` is the statement's own header date ("פרוט פעולותיך לתאריך"),
    which belongs to the same cycle as the block that lost its date. Rows dated
    that way say so in the note. If the statement carries no date anywhere the
    row simply keeps its deal date and is flagged `undated_installment` — a
    non-blocking NOTE app-side, so the admin sees which rows to correct with the
    date editor. Nothing here ever refuses to publish.
    """
    for t in rows:
        if not INSTALLMENT_RE.search(t.note):
            continue
        date = charge_date or fallback
        if date is None:
            t.undated_installment = True
            continue
        if date == t.date:
            continue
        origin = f"עסקה מקורית: {t.date}"
        if charge_date is None:
            origin += " · תאריך לפי כותרת הדוח"
        t.note = f"{t.note} · {origin}" if t.note else origin
        t.date = date


def _statement_date(lines: list[str]) -> str | None:
    """The statement's own header date — "פרוט פעולותיך לתאריך: 15/05/26".

    Fallback charge date for a total block that prints none of its own. It is
    the same billing cycle, so it dates those rows far better than the deal date
    they arrived with. Observed on a real Isracard export at line 16-17, where
    it equals the block charge date exactly.

    The block footer 'לתאריך חיוב סה"כ' also contains "לתאריך", so a bare
    substring match would pick up the LAST block instead of the header. Rows
    carrying 'סה"כ' are excluded, and "פעולותיך" (header-only) is preferred.
    """
    for i, ln in enumerate(lines):
        s = ln.strip()
        if "פעולותיך" not in s and ("לתאריך" not in s or 'סה"כ' in s):
            continue
        for j in range(i + 1, min(i + 4, len(lines))):
            dm = DATE_RE.match(lines[j].strip())
            if dm:
                dd, mm, yy = dm.groups()
                return f"20{yy}-{mm}-{dd}"
    return None


def _block_charge_date(lines: list[str], start: int, end: int) -> str | None:
    """Charge date of the total block starting at `start`, or None.

    Block layout is: 'לתאריך חיוב סה"כ' → date → total-amount. The scan is
    BOUNDED to that window — it stops at the block's own total amount and never
    walks past it. An unbounded "first date after the label" scan would, when a
    block's date is missing or truncated, run into the NEXT transaction's date
    line and return that row's DEAL date as the charge date. Every installment
    row above would then be silently re-dated to a wrong date without being
    flagged undated, which is precisely the wrong-month bug this exists to
    prevent (plan Rev 3, Codex P1-e).
    """
    for j in range(start + 1, end):
        s = lines[j].strip()
        dm = DATE_RE.match(s)
        if dm:
            dd, mm, yy = dm.groups()
            return f"20{yy}-{mm}-{dd}"
        if AMOUNT_RE.match(s):
            return None  # block's total reached with no date — bounded, give up
    return None


def _peek(lines: list[str], fr: int, to: int) -> str:
    return " ".join(lines[max(0, fr) : to])


if __name__ == "__main__":
    import json
    import sys

    r = parse_leumi_pdf(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "leumi")
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
