import { describe, it, expect } from "vitest";
import {
  buildAnalysis,
  monthTitle,
  DISTRIBUTION_EXCLUDED_LEAVES,
  allowedMatchTargets,
  matchTargets,
  suggestMatches,
  type AnalysisTxn,
} from "./reportAnalysis";
import type { TaxonomySection } from "@/config/reportTaxonomy";

const TAX: TaxonomySection[] = [
  { section: "בית", leaves: ["חשמל", "גז"] },
  { section: "שונות", leaves: ["ביט", "עסק", "מעמ", "מס הכנסה", "ביטוח לאומי"] },
  { section: "הכנסות", leaves: ["משכורת 1", "משכורת 2", "הכנסות נוספות", "קצבת ילדים"] },
];

let n = 0;
function tx(over: Partial<AnalysisTxn>): AnalysisTxn {
  return {
    id: `t${n++}`,
    month: "2026-01",
    date: "2026-01-15",
    merchant: "חנות",
    amountAgorot: 10_000,
    category: "חשמל",
    uncategorized: false,
    sourceLabel: "isracard-1234",
    note: null,
    ...over,
  };
}

describe("buildAnalysis", () => {
  it("sums a leaf per month and keeps months sorted", () => {
    const a = buildAnalysis(
      [
        tx({ month: "2026-02", amountAgorot: 500 }),
        tx({ month: "2026-01", amountAgorot: 300 }),
        tx({ month: "2026-01", amountAgorot: 200 }),
      ],
      TAX,
    );
    expect(a.months).toEqual(["2026-01", "2026-02"]);
    const home = a.sections.find((s) => s.section === "בית")!;
    expect(home.leaves[0].byMonth).toEqual([500, 500]);
    expect(home.total).toBe(1000);
    expect(home.avg).toBe(500);
  });

  it("a section total is exactly the sum of its leaves, and the grand total the sum of sections", () => {
    const a = buildAnalysis(
      [
        tx({ category: "חשמל", amountAgorot: 1000 }),
        tx({ category: "גז", amountAgorot: 250 }),
        tx({ category: "ביט", amountAgorot: 700 }),
      ],
      TAX,
    );
    for (const s of a.sections) {
      expect(s.total).toBe(s.leaves.reduce((x, l) => x + l.total, 0));
    }
    expect(a.grandTotal).toBe(1950);
    expect(a.monthTotals).toEqual([1950]);
    expect(a.avgPerMonth).toBe(1950);
  });

  it("drops leaves with no movement but keeps every section row", () => {
    const a = buildAnalysis([tx({ category: "חשמל" })], TAX);
    expect(a.sections.map((s) => s.section)).toEqual(["בית", "שונות"]); // never הכנסות
    expect(a.sections[0].leaves.map((l) => l.leaf)).toEqual(["חשמל"]);
    expect(a.sections[1].leaves).toEqual([]);
  });

  it("keeps a leaf whose charge and refund cancel out, so its rows stay reachable", () => {
    const a = buildAnalysis(
      [tx({ category: "גז", amountAgorot: 400 }), tx({ category: "גז", amountAgorot: -400 })],
      TAX,
    );
    const home = a.sections.find((s) => s.section === "בית")!;
    expect(home.leaves.map((l) => l.leaf)).toEqual(["גז"]);
    expect(home.leaves[0].total).toBe(0);
  });

  it("uncategorized rows are separated, never counted in a category total", () => {
    const a = buildAnalysis(
      [tx({ amountAgorot: 100 }), tx({ uncategorized: true, category: null, amountAgorot: 9999 })],
      TAX,
    );
    expect(a.grandTotal).toBe(100);
    expect(a.uncategorized).toHaveLength(1);
    expect(a.uncategorizedTotal).toBe(9999);
    expect(a.txCount).toBe(2);
  });

  it("distribution excludes the business/tax leaves but the matrix still carries them", () => {
    const a = buildAnalysis(
      [
        tx({ category: "חשמל", amountAgorot: 1000 }),
        tx({ category: "ביט", amountAgorot: 400 }),
        tx({ category: "מעמ", amountAgorot: 5000 }),
        tx({ category: "מס הכנסה", amountAgorot: 1000 }),
      ],
      TAX,
    );
    const misc = a.sections.find((s) => s.section === "שונות")!;
    expect(misc.total).toBe(6400); // matrix keeps all of it

    const dMisc = a.distribution.find((d) => d.section === "שונות")!;
    expect(dMisc.amount).toBe(400); // distribution drops מעמ + מס הכנסה
    expect(a.distributionExcludedAvg).toBe(6000);
    expect(a.distribution.reduce((x, d) => x + d.share, 0)).toBeCloseTo(1, 10);
    // Every excluded leaf name must exist in the taxonomy, or the exclusion silently does nothing.
    const leaves = TAX.flatMap((s) => s.leaves);
    for (const l of DISTRIBUTION_EXCLUDED_LEAVES) expect(leaves).toContain(l);
  });

  it("a net-negative section never pushes another slice past 100%", () => {
    const a = buildAnalysis(
      [
        tx({ category: "חשמל", amountAgorot: 1000 }),
        tx({ category: "ביט", amountAgorot: -400 }),
      ],
      TAX,
    );
    for (const d of a.distribution) expect(d.share).toBeLessThanOrEqual(1);
    expect(a.distribution.find((d) => d.section === "בית")!.share).toBe(1);
  });

  it("categories outside the taxonomy surface instead of vanishing", () => {
    const a = buildAnalysis([tx({ category: "קטגוריה חדשה", amountAgorot: 777 })], TAX);
    const orphan = a.sections.find((s) => s.section === "מחוץ לטבלה")!;
    expect(orphan.leaves.map((l) => l.leaf)).toEqual(["קטגוריה חדשה"]);
    expect(a.grandTotal).toBe(777);
  });

  it("survives an empty job", () => {
    const a = buildAnalysis([], TAX);
    expect(a.months).toEqual([]);
    expect(a.grandTotal).toBe(0);
    expect(a.avgPerMonth).toBe(0);
    expect(a.distribution).toEqual([]);
  });

  // The online report's month filter works by re-running this builder over the
  // kept rows (ReportView). What it buys is that every derived figure moves
  // together — slicing the built matrix instead would leave averages, the
  // distribution and the header stats computed over months no longer shown.
  describe("a month subset recomputes every derived figure", () => {
    const THREE = [
      tx({ month: "2026-01", amountAgorot: 300 }),
      tx({ month: "2026-02", amountAgorot: 600 }),
      tx({ month: "2026-03", amountAgorot: 900 }),
    ];

    it("averages divide by the KEPT months, not the original count", () => {
      const all = buildAnalysis(THREE, TAX);
      expect(all.months).toHaveLength(3);
      expect(all.avgPerMonth).toBe(600); // 1800 / 3

      const kept = buildAnalysis(THREE.filter((t) => t.month !== "2026-01"), TAX);
      expect(kept.months).toEqual(["2026-02", "2026-03"]);
      expect(kept.grandTotal).toBe(1500);
      expect(kept.avgPerMonth).toBe(750); // 1500 / 2 — not 1500/3
      expect(kept.sections.find((s) => s.section === "בית")!.avg).toBe(750);
    });

    it("month columns shrink to the kept months, in order", () => {
      const kept = buildAnalysis(THREE.filter((t) => t.month === "2026-02"), TAX);
      expect(kept.months).toEqual(["2026-02"]);
      expect(kept.monthTotals).toEqual([600]);
      expect(kept.sections.find((s) => s.section === "בית")!.leaves[0].byMonth).toEqual([600]);
    });

    it("the distribution is recomputed over the kept months too", () => {
      const rows = [
        ...THREE,
        tx({ month: "2026-01", category: "ביט", amountAgorot: 1200 }),
      ];
      const all = buildAnalysis(rows, TAX);
      const kept = buildAnalysis(rows.filter((t) => t.month !== "2026-01"), TAX);
      // שונות existed only in the dropped month, so it leaves the distribution.
      expect(all.distribution.some((d) => d.section === "שונות")).toBe(true);
      expect(kept.distribution.some((d) => d.section === "שונות")).toBe(false);
      // ...and the remaining slice is an average over 2 months, not 3.
      expect(kept.distribution.find((d) => d.section === "בית")!.amount).toBe(750);
    });

    it("dropping every month yields an empty analysis, not a divide-by-zero", () => {
      const none = buildAnalysis([], TAX);
      expect(none.months).toEqual([]);
      expect(none.avgPerMonth).toBe(0);
      expect(none.grandTotal).toBe(0);
      expect(none.distribution).toEqual([]);
    });
  });

  it("monthTitle renders Hebrew months and passes junk through", () => {
    expect(monthTitle("2026-06")).toBe("יוני 2026");
    expect(monthTitle("nope")).toBe("nope");
  });
});

// ── Bank statements (docs/plans/bank-statements.md C1) ────────────────────────
describe("income, uncategorized credits, מצבנו", () => {
  const salary = (over: Partial<AnalysisTxn> = {}) =>
    tx({ merchant: "מעסיק", amountAgorot: -1900000, category: "משכורת 1", kind: "income", sourceLabel: "hapoalim-1812", ...over });

  it("income rows leave sections/grandTotal and form a positive income block in taxonomy order", () => {
    const a = buildAnalysis(
      [
        tx({ category: "חשמל", amountAgorot: 1000 }),
        salary(),
        salary({ category: "קצבת ילדים", amountAgorot: -43700 }),
        salary({ category: "מלגה", amountAgorot: -100 }), // income leaf unknown to this taxonomy
      ],
      TAX,
    );
    expect(a.grandTotal).toBe(1000);
    expect(a.monthTotals).toEqual([1000]);
    expect(a.sections.flatMap((s) => s.leaves.map((l) => l.leaf))).toEqual(["חשמל"]);
    expect(a.sections.some((s) => s.section === "מחוץ לטבלה")).toBe(false);
    expect(a.income.leaves.map((l) => l.leaf)).toEqual(["משכורת 1", "קצבת ילדים", "מלגה"]);
    expect(a.income.leaves[0].byMonth).toEqual([1900000]);
    expect(a.income.total).toBe(1943800);
    expect(a.income.avg).toBe(1943800);
    expect(a.distribution.map((d) => d.section)).toEqual(["בית"]);
  });

  it("netByMonth = income − expenses, per month and on average", () => {
    const a = buildAnalysis(
      [
        tx({ month: "2026-01", amountAgorot: 1000 }),
        tx({ month: "2026-02", amountAgorot: 3000 }),
        salary({ month: "2026-01", date: "2026-01-01", amountAgorot: -5000 }),
      ],
      TAX,
    );
    expect(a.netByMonth).toEqual([4000, -3000]);
    expect(a.netAvg).toBe(500);
  });

  it("a refund credit (kind expense) stays in its expense leaf as a negative", () => {
    const a = buildAnalysis([tx({ category: "חשמל", amountAgorot: -300, kind: "expense" })], TAX);
    expect(a.grandTotal).toBe(-300);
    expect(a.income.total).toBe(0);
  });

  it("uncategorized debits and credits are summed separately", () => {
    const a = buildAnalysis(
      [
        tx({ uncategorized: true, category: null, amountAgorot: 700 }),
        tx({ uncategorized: true, category: null, amountAgorot: -1900000, kind: "credit" }),
      ],
      TAX,
    );
    expect(a.uncategorized).toHaveLength(1);
    expect(a.uncategorizedTotal).toBe(700);
    expect(a.uncategorizedCredits).toHaveLength(1);
    expect(a.uncategorizedCreditsTotal).toBe(-1900000);
    expect(a.txCount).toBe(2);
  });
});

describe("suggestMatches / allowedMatchTargets (Decision 5)", () => {
  const per = (cycles: { chargeDate: string; amountAgorot: number }[], extra: object[] = []) => [
    { label: "hapoalim-1812", statementTotalAgorot: null },
    { label: "max-1-billed", statementTotalAgorot: cycles.reduce((n, c) => n + c.amountAgorot, 0), chargeCycles: cycles },
    ...extra,
  ] as Parameters<typeof suggestMatches>[1];
  const s = (id: string, amountAgorot: number, over: Partial<{ month: string; payee: string }> = {}) => ({
    id,
    month: "2026-09",
    payee: "מקס איט פיננ-י",
    amountAgorot,
    ...over,
  });

  it("same month and within ₪5 on ONE settlement", () => {
    const m = suggestMatches([s("a", 1539514)], per([{ chargeDate: "2026-09-10", amountAgorot: 1539800 }]));
    expect(m.get("a")).toBe("max-1-billed@2026-09-10");
    const far = suggestMatches([s("a", 1539514)], per([{ chargeDate: "2026-09-10", amountAgorot: 1540100 }]));
    expect(far.size).toBe(0);
  });

  it("two same-issuer same-month debits → one cycle (the Leumi/MAX shape)", () => {
    const m = suggestMatches(
      [s("a", 1539514), s("b", 675655)],
      per([{ chargeDate: "2026-09-10", amountAgorot: 1539514 + 675655 }]),
    );
    expect(m.get("a")).toBe("max-1-billed@2026-09-10");
    expect(m.get("b")).toBe("max-1-billed@2026-09-10");
    // a different issuer in the same month does not join the sum
    const other = suggestMatches(
      [s("a", 1539514), s("b", 675655, { payee: 'ישראכרט בע"מ' })],
      per([{ chargeDate: "2026-09-10", amountAgorot: 1539514 + 675655 }]),
    );
    expect(other.size).toBe(0);
  });

  it("the target includes a sibling -foreign total on the REGULAR (latest) cycle only; cycles stay domestic-only", () => {
    const perSource = [
      { label: "hapoalim-1812", statementTotalAgorot: null, bank: true },
      { label: "card-domestic", statementTotalAgorot: 73286, chargeCycles: [{ chargeDate: "2026-09-02", amountAgorot: 73286 }] },
      { label: "card-foreign", statementTotalAgorot: 4500 },
    ];
    const t = matchTargets(perSource);
    expect(t).toEqual([
      { id: "card-domestic@2026-09-02", label: "card-domestic", chargeDate: "2026-09-02", amountAgorot: 73286, targetAgorot: 77786 },
    ]);
    expect(suggestMatches([s("a", 77786)], perSource).get("a")).toBe("card-domestic@2026-09-02");
    expect(suggestMatches([s("a", 73286)], perSource).size).toBe(0);
    // an early-repayment block (earlier date) carries no foreign charges
    const two = [
      { label: "card-domestic", statementTotalAgorot: 400000, chargeCycles: [{ chargeDate: "2026-09-02", amountAgorot: 300000 }, { chargeDate: "2026-09-20", amountAgorot: 100000 }] },
      { label: "card-foreign", statementTotalAgorot: 80000 },
    ];
    expect(matchTargets(two).map((x) => [x.chargeDate, x.targetAgorot])).toEqual([["2026-09-02", 300000], ["2026-09-20", 180000]]);
  });

  it("two cycles within ₪5 of one debit in the same month is ambiguous — no suggestion", () => {
    const perSource = [
      { label: "max-1-billed", statementTotalAgorot: 240000, chargeCycles: [{ chargeDate: "2026-09-10", amountAgorot: 240000 }] },
      { label: "isracard-1-domestic", statementTotalAgorot: 239800, chargeCycles: [{ chargeDate: "2026-09-02", amountAgorot: 239800 }] },
    ];
    expect(suggestMatches([s("a", 239800, { payee: 'ישראכרט בע"מ' })], perSource).size).toBe(0);
    // unambiguous when only one is within tolerance
    perSource[0].chargeCycles[0].amountAgorot = 250000;
    expect(suggestMatches([s("a", 239800, { payee: 'ישראכרט בע"מ' })], perSource).get("a")).toBe("isracard-1-domestic@2026-09-02");
  });

  it("two blocks in one month are two targets; equal cycles in different months take their own month", () => {
    const perSource = per([
      { chargeDate: "2026-09-02", amountAgorot: 53386 },
      { chargeDate: "2026-09-15", amountAgorot: 19900 },
    ]);
    expect(allowedMatchTargets({ perSource })).toEqual(["max-1-billed@2026-09-02", "max-1-billed@2026-09-15"]);
    const m = suggestMatches([s("a", 53386), s("b", 19900, { payee: "לאומי ויזה" })], perSource);
    expect(m.get("a")).toBe("max-1-billed@2026-09-02");
    expect(m.get("b")).toBe("max-1-billed@2026-09-15");
    const twoMonths = per([
      { chargeDate: "2026-08-10", amountAgorot: 1000 },
      { chargeDate: "2026-09-10", amountAgorot: 1000 },
    ]);
    const mm = suggestMatches([s("aug", 1000, { month: "2026-08" }), s("sep", 1000)], twoMonths);
    expect(mm.get("aug")).toBe("max-1-billed@2026-08-10");
    expect(mm.get("sep")).toBe("max-1-billed@2026-09-10");
  });

  it("no cycles ⇒ no suggestion; allowedMatchTargets is [] on null or an old-shape verification", () => {
    expect(suggestMatches([s("a", 1000)], [{ label: "hapoalim-1812", statementTotalAgorot: null }]).size).toBe(0);
    expect(allowedMatchTargets(null)).toEqual([]);
    expect(allowedMatchTargets({ problems: [] })).toEqual([]);
    expect(allowedMatchTargets({ perSource: [{ label: "x", statementTotalAgorot: 5 }] })).toEqual([]);
  });
});
