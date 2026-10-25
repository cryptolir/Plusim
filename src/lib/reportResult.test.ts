import { describe, it, expect } from "vitest";
import {
  parseAgentResult,
  verifyAgentResult,
  decodeXlsx,
  rejectionHe,
  isMinorTotalGap,
  noCyclesNote,
  MINOR_GAP_CAP_AGOROT,
  type AgentResult,
} from "./reportResult";
import { mergeTaxonomy, mergedLeafSet, REPORT_TAXONOMY } from "@/config/reportTaxonomy";

const FOOD = "מזון ומכולת";
const FUEL = "דלק";
// The valid set is a REQUIRED argument — no default. Base-only for most cases;
// merged with a DB category where a test exercises admin-added leaves.
const BASE_LEAVES = mergedLeafSet([]);
const DB_LEAF = "קטגוריה חדשה";
const MERGED_LEAVES = mergedLeafSet([{ name: DB_LEAF, section: "שונות" }]);
// The merged taxonomy is a REQUIRED third argument (income invariant).
const TAX = REPORT_TAXONOMY;
const MERGED_TAX = mergeTaxonomy(REPORT_TAXONOMY, [{ name: DB_LEAF, section: "שונות" }]);

// A single clean transaction + matching source total (agora-exact).
function tx(over: Partial<AgentResult["transactions"][number]> = {}) {
  return {
    month: "2026-06",
    date: "2026-06-14",
    merchant: "יוחננוף",
    amountAgorot: 1579,
    category: FOOD,
    uncategorized: false,
    sourceLabel: "isracard-4962",
    dedupKey: "v-1",
    ...over,
  };
}

function result(over: Partial<AgentResult> = {}): AgentResult {
  const transactions = over.transactions ?? [tx()];
  const computed = transactions
    .filter((t) => t.sourceLabel === "isracard-4962")
    .reduce((n, t) => n + t.amountAgorot, 0);
  return {
    status: "ok",
    transactions,
    sourceTotals: [
      { label: "isracard-4962", statementTotalAgorot: computed, computedTotalAgorot: computed },
    ],
    xlsxBase64: "",
    proposedMappings: [],
    ...over,
  };
}

describe("verifyAgentResult — fatal classification (fail closed)", () => {
  it("clean result is not fatal", () => {
    const v = verifyAgentResult(result(), BASE_LEAVES, TAX);
    expect(v.fatal).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.problems).toHaveLength(0);
  });

  it("uncategorized rows ALONE are not fatal (reviewable, publishable)", () => {
    const v = verifyAgentResult(
      result({
        transactions: [tx({ category: null, uncategorized: true, merchant: "קניון עזריאלי" })],
      }),
      BASE_LEAVES,
      TAX,
    );
    expect(v.fatal).toBe(false);
    expect(v.uncategorizedCount).toBe(1);
  });

  it("a MATERIAL per-source total mismatch → fatal", () => {
    const r = result();
    r.sourceTotals[0].statementTotalAgorot = 21_579; // recomputed 1579 ⇒ gap ₪200, over the floor
    const v = verifyAgentResult(r, BASE_LEAVES, TAX);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/הסכום המחושב .* ≠ הסכום בדף החשבון/);
    expect(v.notes).toEqual([]);
    expect(v.perSource[0].minorGap).toBe(false);
  });

  it("unknown category → fatal", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ category: "not-a-real-leaf" })] }), BASE_LEAVES, TAX);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/קטגוריה לא מוכרת/);
  });

  it("DB category in the passed valid set → NOT fatal (test_verify_accepts_db_category_when_in_valid_set)", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ category: DB_LEAF })] }), MERGED_LEAVES, MERGED_TAX);
    expect(v.fatal).toBe(false);
    expect(v.problems).toHaveLength(0);
  });

  it("leaf in neither base nor the passed set → fatal (test_verify_unknown_category_still_fatal)", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ category: "לא-קיימת" })] }), MERGED_LEAVES, MERGED_TAX);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/קטגוריה לא מוכרת/);
  });

  it("the valid set is a required arg — inclusion decides, no hidden fallback (test_verify_requires_explicit_valid_set)", () => {
    // Same DB-leaf result: FATAL under base-only, clean under the merged set.
    const dbLeafResult = () => result({ transactions: [tx({ category: DB_LEAF })] });
    expect(verifyAgentResult(dbLeafResult(), BASE_LEAVES, TAX).fatal).toBe(true);
    expect(verifyAgentResult(dbLeafResult(), MERGED_LEAVES, MERGED_TAX).fatal).toBe(false);
    // And omitting it entirely is a compile error, pinned at the type level:
    // @ts-expect-error validLeaves is required — no base-only default exists
    void (() => verifyAgentResult(dbLeafResult()));
    // @ts-expect-error the merged taxonomy is required too — the income invariant never falls back to base
    void (() => verifyAgentResult(dbLeafResult(), MERGED_LEAVES));
    // @ts-expect-error validLeaves is required — no base-only default exists
    void (() => parseAgentResult({}));
  });

  it("date outside its month → fatal", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ date: "2026-07-02" })] }), BASE_LEAVES, TAX);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/אינו בחודש/);
  });

  it("duplicate dedupKey → fatal", () => {
    const v = verifyAgentResult(
      result({
        transactions: [
          tx({ dedupKey: "dup", amountAgorot: 1000 }),
          tx({ dedupKey: "dup", amountAgorot: 579, merchant: "אושר עד" }),
        ],
      }),
      BASE_LEAVES,
      TAX,
    );
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/עסקה כפולה/);
  });

  it("a source with transactions but no reported total → fatal", () => {
    const r = result({
      transactions: [tx(), tx({ sourceLabel: "max", merchant: "פז", category: FUEL, dedupKey: "v-2" })],
    });
    // sourceTotals only covers isracard-4962; "max" is orphaned.
    const v = verifyAgentResult(r, BASE_LEAVES, TAX);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/אין סכום מדווח בדף החשבון/);
  });
});

describe("parseAgentResult — structural fail-closed", () => {
  const base = {
    status: "ok",
    transactions: [tx()],
    sourceTotals: [{ label: "isracard-4962", statementTotalAgorot: 1579, computedTotalAgorot: 1579 }],
    xlsxBase64: "UEsDBAo=", // some non-empty string
  };

  it("rejects a missing status", () => {
    expect(() => parseAgentResult({ ...base, status: undefined }, BASE_LEAVES)).toThrow(/status/);
  });
  it("rejects empty transactions", () => {
    expect(() => parseAgentResult({ ...base, transactions: [] }, BASE_LEAVES)).toThrow(/empty/);
  });
  it("rejects a bad month", () => {
    expect(() => parseAgentResult({ ...base, transactions: [tx({ month: "2026-13" })] }, BASE_LEAVES)).toThrow(/bad month/);
  });
  it("rejects a non-integer amount", () => {
    expect(() => parseAgentResult({ ...base, transactions: [tx({ amountAgorot: 12.5 })] }, BASE_LEAVES)).toThrow(/bad amount/);
  });
  it("accepts a well-formed body", () => {
    const r = parseAgentResult(base, BASE_LEAVES);
    expect(r.transactions).toHaveLength(1);
    expect(r.status).toBe("ok");
  });
  it("keeps a DB-leaf proposed mapping only when the passed set contains it", () => {
    const withMapping = { ...base, proposedMappings: [{ merchant: "חנות חדשה", category: DB_LEAF }] };
    expect(parseAgentResult(withMapping, MERGED_LEAVES).proposedMappings).toHaveLength(1);
    expect(parseAgentResult(withMapping, BASE_LEAVES).proposedMappings).toHaveLength(0);
  });
});

describe("decodeXlsx — payload type (non-xlsx fails closed)", () => {
  it("rejects a non-zip payload", () => {
    const notZip = Buffer.from("this is a PDF or plain text, not a zip").toString("base64");
    expect(() => decodeXlsx(notZip)).toThrow(/not a valid zip/);
  });
  it("accepts a zip-magic payload", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]).toString("base64");
    expect(decodeXlsx(zip)).toBeInstanceOf(Buffer);
  });
});

describe("rejectionHe — the job page shows a person, not the agent contract", () => {
  const HEBREW = /[֐-׿]/;

  it("explains an empty result in terms the admin can act on", () => {
    const he = rejectionHe("transactions empty");
    expect(he).not.toMatch(/transactions empty/);
    expect(he).toMatch(/כרטיס אשראי/);
  });

  it("wraps every other rejection in Hebrew, keeping the raw detail", () => {
    for (const msg of ["txn[3] bad month", "sourceTotals[0] bad totals", "xlsx too large"]) {
      const he = rejectionHe(msg);
      expect(he).toMatch(HEBREW);
      expect(he).toContain(msg); // still debuggable
    }
  });
});

describe("a small total gap is a note, not a publish blocker", () => {
  // Regression: job "s1" source max-2 came back ₪87.80 short on a ₪7,365.91
  // statement, with the CURRENT parser — so not the charge-summary bug. The old
  // code had one list, so surfacing the gap at all meant refusing to publish an
  // otherwise complete 46-transaction report.
  //
  // Every "still fatal" case below is a Codex finding on the FIRST version of
  // this change, which used max(flat, share) — the more PERMISSIVE of the two
  // limits — and waived all three.
  // Both sides matter: the proportion cap is relative to the statement, so a
  // fixture must model the REAL ratio. (First version of this test set
  // recomputed to ₪15.79, which made an ₪87.80 gap 85% of the statement —
  // correctly fatal, and nothing like s1.)
  const withTotals = (recomputedAgorot: number, statementAgorot: number) => {
    const r = result({ transactions: [tx({ amountAgorot: recomputedAgorot })] });
    r.sourceTotals[0].statementTotalAgorot = statementAgorot;
    return verifyAgentResult(r, BASE_LEAVES, TAX);
  };
  // s1 as it actually came back: ₪7,278.11 recomputed vs ₪7,365.91 stated.
  const S1_RECOMPUTED = 727_811;
  const S1_STATEMENT = 736_591;

  it("the s1 shape publishes, with the gap still stated", () => {
    const v = withTotals(S1_RECOMPUTED, S1_STATEMENT); // ₪87.80 short
    expect(v.fatal).toBe(false);
    expect(v.problems).toEqual([]);
    expect(v.notes).toHaveLength(1);
    expect(v.notes[0]).toMatch(/הפרש ₪87\.80/);
    expect(v.notes[0]).toMatch(/אינו חוסם פרסום/);
    expect(v.perSource[0].minorGap).toBe(true);
    // Still not "ok" — a note is something to read, just not to block on.
    expect(v.ok).toBe(false);
  });

  it("CODEX P1: a ₪1,000 row dropped from a ₪50,000 statement still BLOCKS", () => {
    // 2% of ₪50,000 is ₪1,000, so the share alone would have waived it.
    // The absolute cap is what refuses it.
    expect(isMinorTotalGap(4_900_000, 5_000_000)).toBe(false);
    expect(withTotals(4_900_000, 5_000_000).fatal).toBe(true);
  });

  it("CODEX P1: a source that lost EVERY transaction still BLOCKS", () => {
    // A ₪150 source recomputing to 0 has a gap equal to its whole total, which
    // sat exactly on the old flat floor. 100% of a source can never be ≤ 2%.
    expect(isMinorTotalGap(0, MINOR_GAP_CAP_AGOROT)).toBe(false);
    expect(isMinorTotalGap(0, 500)).toBe(false); // tiny source, same reasoning
    expect(isMinorTotalGap(0, 5_000_000)).toBe(false);
  });

  it("CODEX P2: an OVER-count is never minor, however small", () => {
    // A spurious row with a unique dedupKey inflates the total; no other check
    // catches it, and publishing inflated expenses is worse than blocking.
    expect(isMinorTotalGap(1579 + 100, 1579)).toBe(false);
    expect(isMinorTotalGap(736_591 + 8_780, 736_591)).toBe(false);
    const v = withTotals(S1_RECOMPUTED, S1_RECOMPUTED - 100); // statement BELOW recomputed
    expect(v.fatal).toBe(true);
    expect(v.notes).toEqual([]);
    expect(v.perSource[0].minorGap).toBe(false);
  });

  it("both caps bind — whichever is tighter wins", () => {
    // On s1's ₪7,365.91 statement the PROPORTION binds first: 2% = ₪147.31,
    // below the ₪150 absolute cap.
    expect(isMinorTotalGap(736_591 - 14_731, 736_591)).toBe(true);
    expect(isMinorTotalGap(736_591 - 14_732, 736_591)).toBe(false);
    // On a ₪1,000,000 statement the ABSOLUTE cap binds first: 2% would be
    // ₪20,000, which must never be waived.
    expect(isMinorTotalGap(100_000_000 - MINOR_GAP_CAP_AGOROT, 100_000_000)).toBe(true);
    expect(isMinorTotalGap(100_000_000 - MINOR_GAP_CAP_AGOROT - 1, 100_000_000)).toBe(false);
  });

  it("fails closed with no usable statement total", () => {
    expect(isMinorTotalGap(1000, null)).toBe(false);
    expect(isMinorTotalGap(1000, 0)).toBe(false);
    expect(isMinorTotalGap(-1000, -2000)).toBe(false); // negative total, uncalibrated
  });

  it("a note never masks a real integrity problem in the same result", () => {
    const r = result({ transactions: [tx({ category: "not-a-real-leaf" })] });
    r.sourceTotals[0].statementTotalAgorot = 1579 + 20; // ₪0.20 short of ₪15.99 = 1.25%, a minor gap
    const v = verifyAgentResult(r, BASE_LEAVES, TAX);
    expect(v.fatal).toBe(true); // the unknown category still blocks
    expect(v.notes).toHaveLength(1);
  });
});

// An installment no charge date could be found for — not its block's, not the
// statement header's — keeps its ORIGINAL DEAL date and may sit in the wrong
// month. Owner rule (2026-08-04): that must NOT block the report; it surfaces
// as a note naming the rows, and the admin corrects the date in place.
describe("an undated installment is a note, never a publish blocker", () => {
  const INSTALLMENT_NOTE = "תשלום 8 מתוך 12";

  it("notes the row without making the job fatal", () => {
    const r = result({
      transactions: [
        tx({ note: INSTALLMENT_NOTE, date: "2025-09-28", month: "2025-09", undatedInstallment: true }),
      ],
    });
    const v = verifyAgentResult(r, BASE_LEAVES, TAX);
    expect(v.fatal).toBe(false);
    expect(v.problems).toHaveLength(0);
    expect(v.notes).toHaveLength(1);
    expect(v.notes[0]).toContain("2025-09-28");
    expect(v.notes[0]).toContain("יוחננוף");
  });

  it("date/month still agree — the flag is the ONLY thing that surfaces this", () => {
    const r = result({
      transactions: [tx({ date: "2025-09-28", month: "2025-09", undatedInstallment: true })],
    });
    const v = verifyAgentResult(r, BASE_LEAVES, TAX);
    // Prove the date-outside-month rule does NOT fire here.
    expect(v.problems.some((p) => p.includes("אינו בחודש"))).toBe(false);
    expect(v.notes).toHaveLength(1);
  });

  // Skill versions predating the flag never send it; their payloads must verify
  // exactly as before (the app deploys ahead of the skill).
  it("a payload without the flag verifies exactly as today", () => {
    const r = result({ transactions: [tx({ note: INSTALLMENT_NOTE })] });
    const v = verifyAgentResult(r, BASE_LEAVES, TAX);
    expect(v.fatal).toBe(false);
    expect(v.problems).toHaveLength(0);
    expect(v.notes).toHaveLength(0);
  });

  it("parseAgentResult accepts the flag and treats non-true as absent", () => {
    const raw = (over: Record<string, unknown>) => ({
      status: "ok",
      transactions: [{ ...tx(), ...over }],
      sourceTotals: [{ label: "isracard-4962", statementTotalAgorot: 1579, computedTotalAgorot: 1579 }],
      // parseAgentResult requires a non-empty payload; content is irrelevant here.
      xlsxBase64: "UEsDBA==",
      proposedMappings: [],
    });
    expect(parseAgentResult(raw({ undatedInstallment: true }), BASE_LEAVES).transactions[0].undatedInstallment).toBe(true);
    for (const bogus of [false, "true", 1, null, undefined]) {
      const parsed = parseAgentResult(raw({ undatedInstallment: bogus }), BASE_LEAVES, TAX);
      expect(parsed.transactions[0].undatedInstallment).toBeUndefined();
    }
  });

  it("names only the flagged rows, and one note covers them all", () => {
    const r = result({
      transactions: [
        tx({ dedupKey: "v-1", merchant: "אלף", note: INSTALLMENT_NOTE, undatedInstallment: true }),
        tx({ dedupKey: "v-2", merchant: "בית", note: "תשלום 2 מתוך 2" }),
      ],
    });
    const v = verifyAgentResult(r, BASE_LEAVES, TAX);
    expect(v.notes).toHaveLength(1);
    expect(v.notes[0]).toContain("אלף");
    expect(v.notes[0]).not.toContain("בית");
    expect(v.fatal).toBe(false);
  });
});

// ── Bank statements (docs/plans/bank-statements.md B2) ────────────────────────

const SALARY = "משכורת 1";
const BANK = "hapoalim-1812";

function bankResult(transactions: AgentResult["transactions"], over: Partial<AgentResult> = {}): AgentResult {
  return {
    status: "ok",
    transactions,
    sourceTotals: [{ label: BANK, statementTotalAgorot: null, computedTotalAgorot: 0, bank: true }],
    xlsxBase64: "",
    proposedMappings: [],
    ...over,
  };
}

const income = (over: Partial<AgentResult["transactions"][number]> = {}) =>
  tx({ merchant: "מעסיק", amountAgorot: -1900000, category: SALARY, sourceLabel: BANK, dedupKey: "b-1", kind: "income", ...over });

describe("income kind ⇔ הכנסות leaf (fatal both ways)", () => {
  it("a clean income row verifies", () => {
    const v = verifyAgentResult(bankResult([income()]), BASE_LEAVES, TAX);
    expect(v.fatal).toBe(false);
    expect(v.problems).toEqual([]);
  });

  it("kind absent ⇒ identical outcome to today for expense rows", () => {
    const v = verifyAgentResult(result(), BASE_LEAVES, TAX);
    expect(v.fatal).toBe(false);
    expect(v.settlementCount).toBe(0);
  });

  it("kind income in an expense leaf → fatal; הכנסות leaf without kind income → fatal", () => {
    const a = verifyAgentResult(bankResult([income({ category: FOOD })]), BASE_LEAVES, TAX);
    expect(a.fatal).toBe(true);
    expect(a.problems.join(" ")).toMatch(/שורת הכנסה בקטגוריית הוצאה/);
    const b = verifyAgentResult(bankResult([income({ kind: undefined })]), BASE_LEAVES, TAX);
    expect(b.fatal).toBe(true);
    expect(b.problems.join(" ")).toMatch(/על שורה שאינה הכנסה/);
  });

  it("an הכנסות row with a non-negative amount, or from a card source, → fatal", () => {
    const pos = verifyAgentResult(bankResult([income({ amountAgorot: 1900000 })]), BASE_LEAVES, TAX);
    expect(pos.fatal).toBe(true);
    expect(pos.problems.join(" ")).toMatch(/שאינו זיכוי/);
    const card = verifyAgentResult(
      bankResult([income({ sourceLabel: "isracard-4962" })], {
        sourceTotals: [{ label: "isracard-4962", statementTotalAgorot: -1900000, computedTotalAgorot: -1900000 }],
      }),
      BASE_LEAVES,
      TAX,
    );
    expect(card.fatal).toBe(true);
    expect(card.problems.join(" ")).toMatch(/שאינו חשבון בנק/);
  });

  it("bank-ness is the explicit flag, not a missing total: a MAX -pending source is a card", () => {
    const v = verifyAgentResult(
      bankResult([income({ sourceLabel: "max-1-pending" })], {
        sourceTotals: [{ label: "max-1-pending", statementTotalAgorot: null, computedTotalAgorot: -1900000 }],
      }),
      BASE_LEAVES,
      TAX,
    );
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/שאינו חשבון בנק/);
    // and a "bank" that reports a printed total is a contradiction
    const w = verifyAgentResult(
      result({ sourceTotals: [{ label: "isracard-4962", statementTotalAgorot: 1579, computedTotalAgorot: 1579, bank: true }] }),
      BASE_LEAVES,
      TAX,
    );
    expect(w.problems.join(" ")).toMatch(/אינו מדפיס סכום כולל/);
    expect(w.perSource[0].bank).toBe(true);
  });

  it("a categorized row that is still kind=credit → fatal (undecided means unplaced)", () => {
    const v = verifyAgentResult(
      bankResult([tx({ sourceLabel: BANK, dedupKey: "b-9", amountAgorot: -190000, category: FOOD, kind: "credit" })]),
      BASE_LEAVES,
      TAX,
    );
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/ללא הכרעה/);
    const ok = verifyAgentResult(
      bankResult([tx({ sourceLabel: BANK, dedupKey: "b-9", amountAgorot: -190000, category: null, uncategorized: true, kind: "credit" })]),
      BASE_LEAVES,
      TAX,
    );
    expect(ok.fatal).toBe(false);
  });

  it("an admin-added income leaf is income only through the MERGED taxonomy", () => {
    const merged = mergeTaxonomy(REPORT_TAXONOMY, [{ name: "מלגה", section: "הכנסות" }]);
    const leaves = mergedLeafSet([{ name: "מלגה", section: "הכנסות" }]);
    expect(verifyAgentResult(bankResult([income({ category: "מלגה" })]), leaves, merged).fatal).toBe(false);
  });

  it("monthTotalsAgorot excludes income", () => {
    const v = verifyAgentResult(
      bankResult([income(), tx({ sourceLabel: BANK, dedupKey: "b-2", amountAgorot: 500 })]),
      BASE_LEAVES,
      TAX,
    );
    expect(v.monthTotalsAgorot).toEqual({ "2026-06": 500 });
  });

  it("a refund credit in an expense leaf (kind absent) is just a negative expense", () => {
    const v = verifyAgentResult(
      bankResult([tx({ sourceLabel: BANK, dedupKey: "b-3", amountAgorot: -2860, category: "בריאות משלים" })]),
      BASE_LEAVES,
      TAX,
    );
    expect(v.fatal).toBe(false);
    expect(v.monthTotalsAgorot["2026-06"]).toBe(-2860);
  });
});

const settlement = (over: Partial<NonNullable<AgentResult["settlements"]>[number]> = {}) => ({
  date: "2026-06-10",
  month: "2026-06",
  payee: "מקס איט פיננ-י",
  amountAgorot: 1539514,
  sourceLabel: BANK,
  dedupKey: "s-1",
  ...over,
});

describe("settlements and charge cycles", () => {
  const cardTotals = (cycles?: { chargeDate: string; amountAgorot: number }[]) => [
    { label: BANK, statementTotalAgorot: null, computedTotalAgorot: 0, bank: true as const },
    { label: "isracard-4962", statementTotalAgorot: 1579, computedTotalAgorot: 1579, ...(cycles ? { chargeCycles: cycles } : {}) },
  ];

  it("settlements are optional; with cycles present nothing is noted", () => {
    const v = verifyAgentResult(
      result({ settlements: [settlement()], sourceTotals: cardTotals([{ chargeDate: "2026-06-10", amountAgorot: 1579 }]) }),
      BASE_LEAVES,
      TAX,
    );
    expect(v.fatal).toBe(false);
    expect(v.notes).toEqual([]);
    expect(v.settlementCount).toBe(1);
    expect(v.perSource[1].chargeCycles).toEqual([{ chargeDate: "2026-06-10", amountAgorot: 1579 }]);
  });

  it("settlements with no cycles anywhere ⇒ the note, not a problem", () => {
    const v = verifyAgentResult(result({ settlements: [settlement(), settlement({ dedupKey: "s-2", amountAgorot: 486 })], sourceTotals: cardTotals() }), BASE_LEAVES, TAX);
    expect(v.fatal).toBe(false);
    expect(v.notes).toEqual([
      "2 חיובי כרטיס אשראי בסך ₪15,400.00 נמצאו בחשבון הבנק ללא מחזור חיוב תואם להתאמה — אינם נספרים כהוצאה",
    ]);
    expect(v.unmatchedSettlementsAgorot).toBe(1540000);
    expect(v.notes[0]).toBe(noCyclesNote(2, 1540000));
  });

  it("settlement date outside its month / card-labelled source / non-positive amount → fatal", () => {
    for (const bad of [
      settlement({ date: "2026-07-10" }),
      settlement({ sourceLabel: "isracard-4962" }),
      settlement({ amountAgorot: -5 }),
    ]) {
      const v = verifyAgentResult(result({ settlements: [bad], sourceTotals: cardTotals() }), BASE_LEAVES, TAX);
      expect(v.fatal, JSON.stringify(bad)).toBe(true);
    }
  });

  it("duplicate settlement key, or one colliding with a transaction → fatal", () => {
    const dup = verifyAgentResult(result({ settlements: [settlement(), settlement()], sourceTotals: cardTotals() }), BASE_LEAVES, TAX);
    expect(dup.problems.join(" ")).toMatch(/חיוב כרטיס כפול/);
    const col = verifyAgentResult(result({ settlements: [settlement({ dedupKey: "v-1" })], sourceTotals: cardTotals() }), BASE_LEAVES, TAX);
    expect(col.problems.join(" ")).toMatch(/זהה לעסקה/);
  });

  it("chargeCycles on a null-total source, not summing to the total, or with a repeated date → fatal", () => {
    const nullSrc = verifyAgentResult(
      result({
        sourceTotals: [
          { label: BANK, statementTotalAgorot: null, computedTotalAgorot: 0, chargeCycles: [{ chargeDate: "2026-06-10", amountAgorot: 1 }] },
          { label: "isracard-4962", statementTotalAgorot: 1579, computedTotalAgorot: 1579 },
        ],
      }),
      BASE_LEAVES,
      TAX,
    );
    expect(nullSrc.fatal).toBe(true);
    const badSum = verifyAgentResult(result({ sourceTotals: cardTotals([{ chargeDate: "2026-06-10", amountAgorot: 1578 }]) }), BASE_LEAVES, TAX);
    expect(badSum.problems.join(" ")).toMatch(/סכום מחזורי החיוב/);
    const dupDate = verifyAgentResult(
      result({ sourceTotals: cardTotals([{ chargeDate: "2026-06-10", amountAgorot: 1000 }, { chargeDate: "2026-06-10", amountAgorot: 579 }]) }),
      BASE_LEAVES,
      TAX,
    );
    expect(dupDate.problems.join(" ")).toMatch(/תאריך חיוב חוזר/);
  });

  it("parseAgentResult accepts kind/settlements/chargeCycles and rejects bad shapes", () => {
    const body = {
      status: "ok",
      transactions: [{ ...tx(), kind: "credit", category: null, uncategorized: true }],
      sourceTotals: [
        { label: "isracard-4962", statementTotalAgorot: 1579, computedTotalAgorot: 1579, chargeCycles: [{ chargeDate: "2026-06-10", amountAgorot: 1579 }] },
        { label: BANK, statementTotalAgorot: null, computedTotalAgorot: 0, bank: true },
      ],
      settlements: [settlement()],
      xlsxBase64: "UEsDBA==",
      proposedMappings: [],
    };
    const r = parseAgentResult(body, BASE_LEAVES);
    expect(r.transactions[0].kind).toBe("credit");
    expect(r.sourceTotals[1].bank).toBe(true);
    expect(r.sourceTotals[0].bank).toBeUndefined();
    expect(r.settlements).toHaveLength(1);
    expect(r.sourceTotals[0].chargeCycles).toEqual([{ chargeDate: "2026-06-10", amountAgorot: 1579 }]);
    expect(() => parseAgentResult({ ...body, transactions: [{ ...tx(), kind: "settlement" }] }, BASE_LEAVES)).toThrow(/bad kind/);
    expect(() => parseAgentResult({ ...body, settlements: [{ ...settlement(), date: "10/06/2026" }] }, BASE_LEAVES)).toThrow(/settlement\[0\] bad date/);
    expect(() =>
      parseAgentResult({ ...body, sourceTotals: [{ ...body.sourceTotals[0], chargeCycles: [{ chargeDate: "x", amountAgorot: 1 }] }] }, BASE_LEAVES),
    ).toThrow(/bad chargeDate/);
    // absent ⇒ undefined, exactly as before
    const plain = parseAgentResult({ ...body, transactions: [tx()], settlements: undefined }, BASE_LEAVES);
    expect(plain.transactions[0].kind).toBeUndefined();
    expect(plain.settlements).toBeUndefined();
  });
});
