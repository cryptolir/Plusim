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
