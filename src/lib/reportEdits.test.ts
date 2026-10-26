/**
 * The shared edit rules (docs/plans/report-adjust-chat.md B2) — one table for
 * both writers of a transaction's date / category.
 */
import { describe, it, expect } from "vitest";
import { REPORT_TAXONOMY, INCOME_SECTION } from "@/config/reportTaxonomy";
import { annotate, normalizeDate, resolveEdit, EDIT_ERRORS, type EditableRow } from "./reportEdits";

const taxonomy = REPORT_TAXONOMY;
const validLeaves = new Set(taxonomy.flatMap((s) => s.leaves));
const expenseLeaf = taxonomy.find((s) => s.section !== INCOME_SECTION)!.leaves[0];
const otherExpenseLeaf = taxonomy.find((s) => s.section !== INCOME_SECTION)!.leaves[1];
const incomeLeaf = taxonomy.find((s) => s.section === INCOME_SECTION)!.leaves[0];
const ctx = { validLeaves, taxonomy, bankLabels: new Set(["hapoalim-1812"]) };

function row(over: Partial<EditableRow> = {}): EditableRow {
  return {
    id: "t1",
    date: "2026-05-15",
    category: expenseLeaf,
    uncategorized: false,
    amountAgorot: 1000,
    sourceLabel: "max-1",
    note: null,
    ...over,
  };
}

describe("resolveEdit", () => {
  it("a date edit derives month in the same data and annotates the old date", () => {
    const r = resolveEdit(row(), { date: "2026-06-02" }, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.data).toMatchObject({ date: "2026-06-02", month: "2026-06" });
    expect(r.data.note).toBe('תוקן ע"י המנהל: תאריך 2026-05-15 → 2026-06-02');
    expect(r.data).not.toHaveProperty("category");
  });

  it.each(["2026-02-31", "2026-13-01", "15/05/2026", "", 7])("date %s is refused", (bad) => {
    expect(resolveEdit(row(), { date: bad }, ctx)).toEqual({ error: EDIT_ERRORS.badDate });
  });

  it("a category outside the merged set is refused", () => {
    expect(resolveEdit(row(), { category: "לא קיים" }, ctx)).toEqual({ error: EDIT_ERRORS.unknownCategory });
  });

  it("an expense leaf makes the row an expense and categorized", () => {
    const r = resolveEdit(row({ category: null, uncategorized: true }), { category: otherExpenseLeaf }, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.data).toMatchObject({ category: otherExpenseLeaf, uncategorized: false, kind: "expense" });
    expect(r.data.note).toContain(`ללא סיווג → ${otherExpenseLeaf}`);
  });

  it("an income leaf needs a negative amount", () => {
    expect(resolveEdit(row(), { category: incomeLeaf }, ctx)).toEqual({ error: EDIT_ERRORS.incomeNeedsCredit });
  });

  it("an income leaf needs a bank source", () => {
    expect(resolveEdit(row({ amountAgorot: -1000 }), { category: incomeLeaf }, ctx)).toEqual({
      error: EDIT_ERRORS.incomeNeedsBank,
    });
  });

  it("an income leaf on a bank credit makes it income", () => {
    const r = resolveEdit(row({ amountAgorot: -1000, sourceLabel: "hapoalim-1812" }), { category: incomeLeaf }, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.data.kind).toBe("income");
  });

  it("an expense leaf on a credit row is a refund (kind expense)", () => {
    const r = resolveEdit(
      row({ amountAgorot: -1000, sourceLabel: "hapoalim-1812", category: null, uncategorized: true }),
      { category: expenseLeaf },
      ctx,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.data.kind).toBe("expense");
  });

  it("a no-op edit changes nothing and adds no note", () => {
    const r = resolveEdit(row(), { date: "2026-05-15", category: expenseLeaf }, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.changes).toEqual([]);
    expect(r.data).not.toHaveProperty("note");
  });

  it("can never produce a field other than date / month / category / uncategorized / kind / note", () => {
    const r = resolveEdit(row(), { date: "2026-06-01", category: otherExpenseLeaf, amountAgorot: 1 } as never, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(Object.keys(r.data).sort()).toEqual(["category", "date", "kind", "month", "note", "uncategorized"]);
  });
});

describe("annotate / normalizeDate", () => {
  it("appends to an existing note", () => {
    expect(annotate("תשלום 2 מתוך 3", [{ field: "date", from: "2026-05-01", to: "2026-06-01" }])).toBe(
      'תשלום 2 מתוך 3 · תוקן ע"י המנהל: תאריך 2026-05-01 → 2026-06-01',
    );
  });
  it("normalizeDate keeps real dates only", () => {
    expect(normalizeDate("2024-02-29")).toBe("2024-02-29");
    expect(normalizeDate("2026-02-29")).toBeNull();
  });
});
