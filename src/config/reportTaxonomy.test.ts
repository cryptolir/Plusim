/**
 * Pure taxonomy merge layer: admin-added categories extend the base constant
 * via ONE filtered merge, and the valid-leaf set derives from that same merge
 * (never base ∪ raw names) — so the manifest and verification can't diverge,
 * even on a malformed (invalid-section) ReportCategory row.
 */
import { describe, it, expect } from "vitest";
import {
  REPORT_TAXONOMY,
  TAXONOMY_LEAVES,
  SECTION_NAMES,
  mergeTaxonomy,
  mergedLeafSet,
} from "./reportTaxonomy";

const DB_LEAF = { name: "קטגוריה חדשה", section: "שונות" };
const BAD_SECTION = { name: "יתום", section: "__nonexistent__" };

describe("mergeTaxonomy", () => {
  it("appends the extra leaf to the end of its matching section, others byte-identical (test_mergeTaxonomy_appends_to_matching_section)", () => {
    const merged = mergeTaxonomy(REPORT_TAXONOMY, [DB_LEAF]);
    const target = merged.find((s) => s.section === "שונות")!;
    const base = REPORT_TAXONOMY.find((s) => s.section === "שונות")!;
    expect(target.leaves).toEqual([...base.leaves, DB_LEAF.name]);
    for (const s of merged) {
      if (s.section === "שונות") continue;
      expect(s.leaves).toEqual(REPORT_TAXONOMY.find((b) => b.section === s.section)!.leaves);
    }
    // order-stable: section order unchanged
    expect(merged.map((s) => s.section)).toEqual(SECTION_NAMES);
    // pure: base constant untouched
    expect(base.leaves).not.toContain(DB_LEAF.name);
  });

  it("drops an extra whose section is not a base section (test_mergeTaxonomy_drops_unknown_section)", () => {
    const merged = mergeTaxonomy(REPORT_TAXONOMY, [BAD_SECTION]);
    expect(merged.flatMap((s) => s.leaves)).not.toContain(BAD_SECTION.name);
    expect(merged.map((s) => s.section)).toEqual(SECTION_NAMES); // no invented section
  });

  it("dedups an extra that repeats an existing leaf", () => {
    const merged = mergeTaxonomy(REPORT_TAXONOMY, [{ name: "ביט", section: "שונות" }]);
    const leaves = merged.find((s) => s.section === "שונות")!.leaves;
    expect(leaves.filter((l) => l === "ביט")).toHaveLength(1);
  });
});

describe("mergedLeafSet", () => {
  it("is base leaves ∪ valid extra names, deduped (test_mergedLeafSet_is_base_union_db)", () => {
    const set = mergedLeafSet([DB_LEAF]);
    expect(set.size).toBe(TAXONOMY_LEAVES.length + 1);
    expect(set.has(DB_LEAF.name)).toBe(true);
    for (const l of TAXONOMY_LEAVES) expect(set.has(l)).toBe(true);
  });

  it("derives from the SAME filtered merge as the taxonomy (test_mergedLeafSet_derives_from_merged_taxonomy)", () => {
    // invalid-section extra: in NEITHER the merged taxonomy nor the leaf set
    const set = mergedLeafSet([BAD_SECTION, DB_LEAF]);
    expect(set.has(BAD_SECTION.name)).toBe(false);
    expect(set.has(DB_LEAF.name)).toBe(true);
    const taxonomyLeaves = new Set(
      mergeTaxonomy(REPORT_TAXONOMY, [BAD_SECTION, DB_LEAF]).flatMap((s) => s.leaves),
    );
    expect(set).toEqual(taxonomyLeaves);
  });
});
