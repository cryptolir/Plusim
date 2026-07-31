import { describe, it, expect } from "vitest";
import { buildAnalysis, monthTitle, DISTRIBUTION_EXCLUDED_LEAVES, type AnalysisTxn } from "./reportAnalysis";
import type { TaxonomySection } from "@/config/reportTaxonomy";

const TAX: TaxonomySection[] = [
  { section: "בית", leaves: ["חשמל", "גז"] },
  { section: "שונות", leaves: ["ביט", "עסק", "מעמ", "מס הכנסה", "ביטוח לאומי"] },
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
    expect(a.sections.map((s) => s.section)).toEqual(["בית", "שונות"]);
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

  it("monthTitle renders Hebrew months and passes junk through", () => {
    expect(monthTitle("2026-06")).toBe("יוני 2026");
    expect(monthTitle("nope")).toBe("nope");
  });
});
