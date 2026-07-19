# -*- coding: utf-8 -*-
"""Reconciliation + validity checks for a categorized transaction set.

MUST pass before a job is reported ok (reference/categorization-rules.md):
  - per-source: sum of transactions == the statement's own total, to the agora
  - every transaction appears exactly once (dedupKey unique)
  - every assigned category is a real taxonomy leaf
  - every date lies inside its assigned month

Returns (ok, problems, summary). Failures never block the callback — they
demote the job to needs_review with these diagnostics attached.
"""
from __future__ import annotations


def verify(
    txns: list[dict],
    source_totals: dict[str, int | None],
    taxonomy: list[dict],
) -> tuple[bool, list[str], dict]:
    problems: list[str] = []
    leaves = {leaf for sec in taxonomy for leaf in sec["leaves"]}

    seen: set[str] = set()
    for t in txns:
        if t["dedupKey"] in seen:
            problems.append(f"duplicate dedupKey: {t['dedupKey']}")
        seen.add(t["dedupKey"])
        if not t["uncategorized"]:
            if not t.get("category"):
                problems.append(f"categorized row without category: {t['merchant']}")
            elif t["category"] not in leaves:
                problems.append(f"unknown category {t['category']!r} ({t['merchant']})")
        if not t["date"].startswith(t["month"]):
            problems.append(f"date {t['date']} outside month {t['month']} ({t['merchant']})")

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
        "problems": problems,
    }
    return (len(problems) == 0, problems, summary)
