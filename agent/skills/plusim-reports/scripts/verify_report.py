# -*- coding: utf-8 -*-
"""Reconciliation + validity checks for a categorized transaction set.

MUST pass before a job is reported ok (reference/categorization-rules.md):
  - per-source: sum of transactions == the statement's own total, to the agora
  - every transaction appears exactly once (dedupKey unique) — and no settlement
    shares a key with a transaction or with another settlement
  - every assigned category is a real taxonomy leaf
  - every date lies inside its assigned month
  - income invariant (docs/plans/bank-statements.md A3): a categorized row has
    kind == "income" exactly when its leaf is in the הכנסות section, and such a
    row is a negative amount from a bank source (no printed total)
  - no settlement leaked: an expense row from a bank source never matches a
    card-issuer payee on whole tokens (bank_rows.SETTLEMENT_PAYEES)

Returns (ok, problems, summary). Failures never block the callback — they
demote the job to needs_review with these diagnostics attached.
"""
from __future__ import annotations

from bank_rows import is_settlement_payee
from build_report_xlsx import INCOME_SECTION


def verify(
    txns: list[dict],
    source_totals: dict[str, int | None],
    taxonomy: list[dict],
    settlements: list[dict] | None = None,
    bank_labels: set[str] | None = None,
) -> tuple[bool, list[str], dict]:
    """`bank_labels`: the sources parsed by a bank parser (ParseResult.bank_labels).
    When None, a source with no printed total is taken as a bank — the older,
    looser criterion, kept for callers that have no parser information."""
    problems: list[str] = []
    leaves = {leaf for sec in taxonomy for leaf in sec["leaves"]}
    income = {leaf for sec in taxonomy if sec["section"] == INCOME_SECTION for leaf in sec["leaves"]}
    settlements = settlements or []
    if bank_labels is None:
        bank_labels = {label for label, total in source_totals.items() if total is None}

    seen: set[str] = set()
    for t in txns:
        if t["dedupKey"] in seen:
            problems.append(f"duplicate dedupKey: {t['dedupKey']}")
        seen.add(t["dedupKey"])
        kind = t.get("kind") or "expense"
        bank_source = t["sourceLabel"] in bank_labels
        if kind == "credit" and not t["uncategorized"]:
            # finalize always resolves a credit to income or expense (refund);
            # a categorized "credit" would be summed as spend yet hidden from
            # both uncategorized lists.
            problems.append(f"categorized row still kind=credit: {t['merchant']} {t['date']}")
        if not t["uncategorized"]:
            if not t.get("category"):
                problems.append(f"categorized row without category: {t['merchant']}")
            elif t["category"] not in leaves:
                problems.append(f"unknown category {t['category']!r} ({t['merchant']})")
            else:
                is_income_leaf = t["category"] in income
                if (kind == "income") != is_income_leaf:
                    problems.append(
                        f"kind {kind!r} does not match leaf {t['category']!r} ({t['merchant']} {t['date']})"
                    )
                if is_income_leaf and (t["amountAgorot"] >= 0 or not bank_source):
                    problems.append(
                        f"income leaf {t['category']!r} holds a non-credit or card-source row "
                        f"({t['merchant']} {t['date']} {t['amountAgorot']})"
                    )
        if not t["date"].startswith(t["month"]):
            problems.append(f"date {t['date']} outside month {t['month']} ({t['merchant']})")
        if bank_source and kind == "expense" and t["amountAgorot"] > 0 and is_settlement_payee(t["merchant"]):
            problems.append(f"card settlement leaked into transactions: {t['merchant']} {t['date']}")

    seen_settlements: set[str] = set()
    for s in settlements:
        k = s["dedupKey"]
        if s["sourceLabel"] not in bank_labels:
            problems.append(f"settlement from a non-bank source {s['sourceLabel']}: {s['payee']} {s['date']}")
        if k in seen:
            problems.append(f"settlement dedupKey collides with a transaction: {k}")
        if k in seen_settlements:
            problems.append(f"duplicate settlement dedupKey: {k}")
        seen_settlements.add(k)

    by_source: dict[str, int] = {}
    for t in txns:
        by_source[t["sourceLabel"]] = by_source.get(t["sourceLabel"], 0) + t["amountAgorot"]

    per_source = []
    for label, stmt in source_totals.items():
        computed = by_source.get(label, 0)
        match = stmt is None or computed == stmt
        if not match:
            problems.append(f"source {label}: computed {computed} ≠ statement {stmt} agorot")
        per_source.append(
            {"label": label, "statementTotalAgorot": stmt, "computedTotalAgorot": computed, "match": match}
        )
    for label in by_source:
        if label not in source_totals:
            problems.append(f"source {label} has transactions but no statement-total entry")

    summary = {
        "perSource": per_source,
        "txCount": len(txns),
        "uncategorizedCount": sum(1 for t in txns if t["uncategorized"]),
        "settlementCount": len(settlements),
        "problems": problems,
    }
    return (len(problems) == 0, problems, summary)
