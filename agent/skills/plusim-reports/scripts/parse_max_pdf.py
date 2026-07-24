# -*- coding: utf-8 -*-
"""Parse a MAX "פירוט החיובים" PDF into normalized transactions.

MAX's PDF text extraction glues RTL fragments together, so this parser works on
structure, not layout: the text is split into chunks at transaction dates
(dd.mm.yy — a negative lookahead excludes the dd.mm.yyyy billing dates), each
chunk's LAST currency token is the row's charge (earlier tokens are struck-
through pre-discount amounts, e.g. card fees), and section membership comes
from the nearest preceding section header. Section totals ("סה״כ …") reconcile
the whole file to the agora.

Charge sign: cancellations (ביטול עסקה) and leading-minus tokens are negative.
MAX's own category column is captured as a hint (max_category) — the
categorizer may trust it for certain leaves (see categorization-rules.md).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from pypdf import PdfReader

# dd.mm.yy; (?!\d\d) rejects dd.mm.yyyy billing dates but still matches a
# transaction date glued to a digit-starting merchant ("10.03.264אפליקציית").
DATE_RE = re.compile(r"\b(\d{2})\.(\d{2})\.(\d{2})(?!\d\d)")
AMOUNT_RE = re.compile(r"(-?)₪\s?([\d,]+\.\d{2})")
TOTAL_LABEL = "סה״כ"
# The monthly charge-summary line ("… <dd.mm.yyyy> חיוב ב₪<total>") repeats the
# statement total. It has no "סה״כ" label, and it trails the last row's real
# charge, so the last-token rule would otherwise read that total as the row's
# amount — doubling the section sum. "חיוב ב" glued to ₪ is unique to this line
# (the legal boilerplate says "החיוב בפועל"/"חיוב בריבית", never followed by ₪).
CHARGE_SUMMARY_RE = re.compile(r"חיוב ב\s*₪")

SECTIONS = {
    "עסקאות שאושרו וטרם נקלטו": "pending",
    'עסקאות חו"ל ומט"ח': "billed",
    "עסקאות חו״ל ומט״ח": "billed",
    "עסקאות במועד החיוב": "billed",
    "עסקאות בחיוב מיידי": "billed",
}

MAX_CATEGORIES = [
    "רפואה ובתי\nמרקחת",
    "רפואה ובתי מרקחת",
    "מסעדות, קפה\nוברים",
    "מסעדות, קפה וברים",
    "קוסמטיקה\nוטיפוח",
    "קוסמטיקה וטיפוח",
    "פנאי, בידור\nוספורט",
    "פנאי, בידור וספורט",
    "שירותי תקשורת",
    "העברת כספים",
    "רכב ותחבורה",
    "מזון ומשקאות",
    "ביטוח",
    "אופנה",
    "שונות",
]

TYPE_WORDS = ["ביטול עסקה", 'חיוב עסקת חו"ל', "הוראת קבע", "רגילה", 'בש"ח', "ת.עסקה"]


@dataclass
class Txn:
    date: str
    merchant: str
    amount_agorot: int
    source_label: str
    dedup_key: str
    note: str = ""
    max_category: str = ""


@dataclass
class ParseResult:
    transactions: list[Txn] = field(default_factory=list)
    source_totals: dict[str, int | None] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def _agorot(tok: tuple[str, str]) -> int:
    sign, num = tok
    v = round(float(num.replace(",", "")) * 100)
    return -v if sign == "-" else v


def parse_max_pdf(path: str, label: str) -> ParseResult:
    reader = PdfReader(path)
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    res = ParseResult()

    billed_label = f"{label}-billed"
    pending_label = f"{label}-pending"

    # Section spans: a header occurrence only counts as a real section start if
    # the table column header ("שם בית העסק") follows shortly — MAX's legal
    # boilerplate quotes section names verbatim and must not create sections.
    marks: list[tuple[int, str]] = []
    for header, kind in SECTIONS.items():
        for m in re.finditer(re.escape(header), text):
            if "שם בית העסק" in text[m.end() : m.end() + 220]:
                marks.append((m.start(), kind))
    marks.sort()

    def section_at(pos: int) -> str:
        kind = "billed"  # a lone foreign-currency block may precede any header
        for p, k in marks:
            if p <= pos:
                kind = k
            else:
                break
        return kind

    # Statement total = sum of every section total (the nearest amount token
    # BEFORE each "סה״כ" label). Pending sections carry no totals in MAX PDFs.
    stmt_total = 0
    found_total = False
    for m in re.finditer(TOTAL_LABEL, text):
        before = text[: m.start()]
        toks = list(AMOUNT_RE.finditer(before))
        if toks:
            stmt_total += _agorot(toks[-1].groups())
            found_total = True

    dates = list(DATE_RE.finditer(text))
    seq: dict[str, int] = {}
    for i, dm in enumerate(dates):
        start = dm.end()
        end = dates[i + 1].start() if i + 1 < len(dates) else len(text)
        chunk = text[start:end]
        # Drop the monthly charge-summary total ("… חיוב ב₪<total>") when it lands
        # in this chunk (the last row before MAX's "you'll be charged X on <date>"
        # line). It carries the statement total and trails the real charge, so
        # without this the last-token rule reads the total as the row's amount.
        sm = CHARGE_SUMMARY_RE.search(chunk)
        if sm:
            chunk = chunk[: sm.start()]
        # Keep totals/section-summary amounts out of the row's amount list. MAX
        # prints "₪<total>\nסה״כ …", so the total amount sits BEFORE the label:
        # cut at the label, then drop a trailing amount separated from it by
        # whitespace only (that amount is the section total, not this row's).
        cut = chunk.find(TOTAL_LABEL)
        if cut != -1:
            head = chunk[:cut]
            toks = list(AMOUNT_RE.finditer(head))
            if toks and head[toks[-1].end() : cut].strip() == "":
                head = head[: toks[-1].start()]
            chunk = head
        amounts = list(AMOUNT_RE.finditer(chunk))
        if not amounts:
            continue  # a billing-date line, not a transaction row

        agorot = _agorot(amounts[-1].groups())
        is_cancel = "ביטול עסקה" in chunk
        if is_cancel and agorot > 0:
            agorot = -agorot

        max_cat = ""
        for c in MAX_CATEGORIES:
            if c in chunk:
                max_cat = c.replace("\n", " ")
                break

        # Merchant = the chunk minus category/type/card/amount/table noise.
        cleaned = chunk
        for c in MAX_CATEGORIES:
            cleaned = cleaned.replace(c, " ")
        # Strip the glued table-header first (longest forms first), then type
        # words — but never bare "כרטיס"/"סכום", which appear in merchant names
        # like "דמי כרטיס".
        for w in [
            "שם בית העסקקטגוריהכרטיססוג עסקהסכום",
            "שם בית העסק קטגוריה כרטיס סוג עסקה סכום",
            "שם בית העסק",
            "חיוב ב",
        ] + list(SECTIONS.keys()) + TYPE_WORDS:
            cleaned = cleaned.replace(w, " ")
        cleaned = AMOUNT_RE.sub(" ", cleaned)
        cleaned = re.sub(r"\d{2}\.\d{2}\.\d{4}", " ", cleaned)  # billing dates
        cleaned = re.sub(r"\b\d{4}\b", " ", cleaned)  # card suffix
        cleaned = re.sub(r"[:\s]+", " ", cleaned).strip(" .·—-")
        merchant = cleaned[:80] if cleaned else "(לא זוהה)"

        dd, mm, yy = dm.groups()
        date = f"20{yy}-{mm}-{dd}"
        kind = section_at(dm.start())
        src = pending_label if kind == "pending" else billed_label
        base = f"{src}|{date}|{merchant}|{agorot}"
        seq[base] = seq.get(base, 0) + 1  # identical legit rows stay distinct
        res.transactions.append(
            Txn(
                date=date,
                merchant=merchant,
                amount_agorot=agorot,
                source_label=src,
                dedup_key=f"{base}|{seq[base]}",
                note=("עסקה שטרם נקלטה" if kind == "pending" else ("ביטול עסקה" if is_cancel else "")),
                max_category=max_cat,
            )
        )

    res.source_totals[billed_label] = stmt_total if found_total else None
    if any(t.source_label == pending_label for t in res.transactions):
        res.source_totals[pending_label] = None
    if not found_total:
        res.warnings.append(f"{path}: no section totals found")
    return res


if __name__ == "__main__":
    import json
    import sys

    r = parse_max_pdf(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "max")
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
