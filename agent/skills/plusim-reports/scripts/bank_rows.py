# -*- coding: utf-8 -*-
"""Shared rules for bank current-account rows (docs/plans/bank-statements.md A1).

Three bank parsers (Discount xlsx, Hapoalim PDF, Leumi PDF) must agree on what a
row IS, so the decision lives here, once:

  direction  "debit" (money left the account) | "credit" (money came in)
  kind       "settlement" — a debit paying a credit-card statement; every one
                           of its shekels is already itemized on the card
                           statement, so it is kept OUT of transactions and
                           reported separately for reconciliation
             "credit"     — an incoming row whose nature (income vs. a refund
                           of a known expense) the model decides
             "expense"    — any other debit; categorizes like a card row

Settlement payees are matched on WHOLE TOKENS, never substrings: a bare "כאל"
would match "מיכאל" and silently drop a transfer to a person from every total —
an under-count nothing downstream can detect (plan Rev 4, risk 1). Only strings
observed on real statements are listed; add the next issuer when its real
descriptor is seen, never from memory.

The running-balance chain is the completeness check of a current-account export
(no printed grand total exists): newest row first, each older balance must equal
the newer balance plus the newer amount (amounts are stored sign-flipped: an
expense is positive). A break is a WARNING, never a drop — the rows are real; it
is the file that may be missing one.
"""
from __future__ import annotations

import re
import unicodedata

# Observed on real Bank Hapoalim / Bank Leumi statements (2026-10). Each entry is
# a token sequence that must appear consecutively among the description's tokens.
SETTLEMENT_PAYEES: tuple[str, ...] = (
    "ישראכרט",
    "כרטיסי אשראי",
    "מקס איט",
    "לאומי מאסטרקרד",
    "לאומי ויזה",
    "דיינרס",
    "אמריקן אקספרס",
)

_SPLIT_RE = re.compile(r"""[\s\-\.,'"]+""")


def tokens(description: str) -> list[str]:
    """Whole tokens of a normalized description: split on whitespace and on
    - . , ' " (the glue characters bank exports use: ישראכרט-כ.ויזה, מקס איט פיננ-י)."""
    d = unicodedata.normalize("NFKC", description or "")
    return [t for t in _SPLIT_RE.split(d) if t]


def is_settlement_payee(description: str) -> bool:
    toks = tokens(description)
    for payee in SETTLEMENT_PAYEES:
        pt = tokens(payee)
        n = len(pt)
        if any(toks[i : i + n] == pt for i in range(0, len(toks) - n + 1)):
            return True
    return False


def classify_bank_row(description: str, amount_agorot: int) -> tuple[str, str]:
    """(direction, kind) for a bank row whose amount is already in the pipeline
    convention (expense positive, incoming negative)."""
    if amount_agorot < 0:
        return "credit", "credit"
    if is_settlement_payee(description):
        return "debit", "settlement"
    return "debit", "expense"


def check_balance_chain(chain: list[tuple[int, int, str]], path: str) -> list[str]:
    """chain: (amount_agorot, balance_agorot_after_row, description) newest → oldest.
    Returns one warning per break; an empty chain is itself a warning."""
    warnings: list[str] = []
    for (amt_new, bal_new, desc_new), (_, bal_old, _) in zip(chain, chain[1:]):
        if bal_new + amt_new != bal_old:
            warnings.append(
                f"{path}: balance-chain break after {desc_new} "
                f"(bal {bal_new} + amt {amt_new} = {bal_new + amt_new} ≠ next bal {bal_old})"
            )
    if not chain:
        warnings.append(f"{path}: no balance column found — completeness unverifiable")
    return warnings


# ────────────────────────────────────────────────────────────────────
# Overlapping exports of one account (docs/plans/scale-large-statements.md A1)
# ────────────────────────────────────────────────────────────────────


class AmbiguousBankMergeError(Exception):
    """Two exports of one account disagree about a day they both cover.

    Raised instead of guessing which rows are real: a wrong guess silently drops
    or double-counts money, and nothing downstream can see a row that was
    removed. The message names both files and the day — the admin deletes one
    of them (or re-exports for the same period) and re-runs.
    """


def _identity(t) -> tuple:
    """What must match for two exports to be showing the SAME physical row.
    Compared position-by-position within a day, never as a set: a purchase, its
    refund and an identical second purchase repeat (date, description, amount,
    balance) and only their ORDER tells them apart."""
    return (t.date, t.merchant, t.amount_agorot, t.balance_agorot, t.note)


class _Export:
    def __init__(self, name: str, index: int, result, label: str):
        self.name = name
        self.index = index
        self.result = result
        self.rows = [t for t in result.transactions if t.source_label == label]
        self.by_day: dict[str, list] = {}
        for t in self.rows:
            self.by_day.setdefault(t.date, []).append(t)
        printed = getattr(result, "periods", {}).get(label)
        dates = sorted(self.by_day)
        lo = printed[0] if printed else (dates[0] if dates else None)
        hi = printed[1] if printed else (dates[-1] if dates else None)
        # Rows outside the printed period (a misparsed header) still count as
        # covered: coverage only ever widens to what the file demonstrably holds.
        if dates:
            lo = min(lo, dates[0]) if lo else dates[0]
            hi = max(hi, dates[-1]) if hi else dates[-1]
        self.lo, self.hi = lo, hi
        self.incomplete: set[str] = set(getattr(result, "incomplete_days", {}).get(label, set()))

    def covers(self, day: str) -> bool:
        return self.lo is not None and self.lo <= day <= self.hi


def _consistent(g: _Export, chosen: _Export, day: str) -> bool:
    """May `g`'s rows for `day` be dropped in favour of `chosen`'s? Only when they
    are provably the same rows — equal, or one of the two documented partial
    shapes. Anything else is ambiguous."""
    grows = [_identity(t) for t in g.by_day.get(day, [])]
    crows = [_identity(t) for t in chosen.by_day.get(day, [])]
    if grows == crows:
        return True
    # (b) an earlier export generated mid-day on its LAST day: it holds only the
    # OLDER part of that day — a suffix of the newest-first list. Only a strictly
    # later export can be the more complete one.
    if g.hi == day and chosen.hi > day and len(grows) <= len(crows) and crows[len(crows) - len(grows):] == grows:
        return True
    # (c) the export excluded its oldest row of this day (Leumi): exactly one row
    # fewer, a prefix of the complete list.
    if day in g.incomplete and len(grows) + 1 == len(crows) and crows[: len(grows)] == grows:
        return True
    return False


def merge_bank_exports(items: list[tuple[str, object]]) -> tuple[list[str], list[str], int]:
    """Collapse overlapping exports of the same bank account, in place.

    `items`: [(file name, ParseResult)] in manifest order. Returns
    (notes, warnings, rows_not_counted_twice). For every calendar day, rows come
    from EXACTLY ONE export: among those covering the day and not known to be
    incomplete for it, the one with the latest period end (ties → manifest
    order). Every other export covering the day must show the same rows, or one
    of the two partial shapes in `_consistent`; otherwise
    AmbiguousBankMergeError. Rows are never removed on content equality alone.
    """
    groups: dict[str, list[_Export]] = {}
    for idx, (name, res) in enumerate(items):
        for label in sorted(getattr(res, "bank_labels", ())):
            groups.setdefault(label, []).append(_Export(name, idx, res, label))

    notes: list[str] = []
    warnings: list[str] = []
    total_removed = 0
    for label, exports in groups.items():
        exports = [e for e in exports if e.lo is not None]
        if len(exports) < 2:
            continue
        supplied: dict[int, set[str]] = {e.index: set() for e in exports}
        days = sorted({d for e in exports for d in e.by_day})
        removed = 0
        for day in days:
            covering = [e for e in exports if e.covers(day)]
            eligible = [e for e in covering if day not in e.incomplete] or covering
            chosen = max(eligible, key=lambda e: (e.hi, -e.index))
            for g in covering:
                if g is chosen:
                    continue
                if not _consistent(g, chosen, day):
                    raise AmbiguousBankMergeError(
                        f"{label}: הקבצים {g.name} ו־{chosen.name} אינם עקביים ביום {day} "
                        f"({len(g.by_day.get(day, []))} מול {len(chosen.by_day.get(day, []))} תנועות) — "
                        f"הסירו את אחד הקבצים או ייצאו מחדש לאותה תקופה"
                    )
                removed += len(g.by_day.get(day, []))
            supplied[chosen.index].add(day)
        for e in exports:
            keep = supplied[e.index]
            e.result.transactions = [
                t for t in e.result.transactions if t.source_label != label or t.date in keep
            ]
        total_removed += removed
        if removed:
            names = ", ".join(e.name for e in exports)
            notes.append(
                f"{removed} שורות חופפות בין הקבצים {names} "
                f"({min(e.lo for e in exports)}–{max(e.hi for e in exports)}) לא נספרו פעמיים"
            )

        # Uncovered stretches between the exports' periods.
        spans = sorted((e.lo, e.hi) for e in exports)
        cur_lo, cur_hi = spans[0]
        for lo, hi in spans[1:]:
            if lo > _next_day(cur_hi):
                warnings.append(
                    f"{label}: לא כוסו התאריכים {_next_day(cur_hi)}–{_prev_day(lo)} בין הקבצים — ייתכן שחסר ייצוא"
                )
            cur_hi = max(cur_hi, hi)

        # Completeness across the merged rows: every row but the overall oldest
        # needs a successor whose balance matches. A WARNING, never the reason a
        # row is kept or dropped.
        rows = [t for e in exports for t in e.result.transactions
                if t.source_label == label and t.balance_agorot is not None]
        if rows:
            oldest = min(t.date for t in rows)
            count: dict[int, int] = {}
            for t in rows:
                count[t.balance_agorot] = count.get(t.balance_agorot, 0) + 1
            for t in rows:
                need = t.balance_agorot + t.amount_agorot
                have = count.get(need, 0) - (1 if need == t.balance_agorot else 0)
                if have <= 0 and t.date != oldest:
                    warnings.append(
                        f"{label}: חסרות תנועות אחרי {t.date} {t.merchant} — ייתכן שחסר ייצוא"
                    )
    return notes, warnings, total_removed


def _next_day(iso: str) -> str:
    import datetime

    return (datetime.date.fromisoformat(iso) + datetime.timedelta(days=1)).isoformat()


def _prev_day(iso: str) -> str:
    import datetime

    return (datetime.date.fromisoformat(iso) - datetime.timedelta(days=1)).isoformat()
