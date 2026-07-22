/**
 * Category taxonomy for the statement-categorization pipeline.
 *
 * Mirrors the "Main" sheet of the household budget workbook: sections contain
 * leaf categories; every transaction lands in exactly one leaf (or in
 * un_categorized). This constant is the BASE taxonomy; admin-added categories
 * (ReportCategory rows, add-only) extend it via mergeTaxonomy(). What every
 * agent job manifest carries — and what result verification, the admin
 * validation routes, the assign picker, and /report consume — is the SAME
 * merged copy (base ∪ DB, one filtered merge; src/lib/reportCategories.ts), so
 * app and agent can never disagree on category names.
 */

export interface TaxonomySection {
  section: string;
  leaves: string[];
}

export const REPORT_TAXONOMY: TaxonomySection[] = [
  {
    section: "בית",
    leaves: [
      'שכ"ד/משכנתא',
      "ועד בית",
      "חשמל",
      "גז",
      "ארנונה",
      "מים+ביוב",
      "אפיקים",
      "מזון ומכולת",
      "אחזקה ותיקונים",
      "מס שבח",
    ],
  },
  {
    section: "ביטוחים",
    leaves: [
      "בריאות\\הראל",
      "בריאות משלים",
      "פרטי",
      "חיים \\כלל",
      "משכנתא+ דירה",
      "רכב(חובה+מקיף)",
      "איתורן+ קוברה",
    ],
  },
  {
    section: "ילדים",
    leaves: ["מטפלת/מעון/גן", "צהרון", 'ביה"ס/מחציות', "חוגים", "דמי כיס", "קייטנות"],
  },
  { section: "חסכונות", leaves: ["קופת גמל", "תוכנית חיסכון"] },
  { section: "מימון", leaves: ["הלוואות", "עמלות+ריביות"] },
  {
    section: "תקשורת",
    leaves: ["טלפון קווי\\ בזק", "סלולרי\\הוט מובייל", "אינטרנט\\בזק בינלאומי"],
  },
  { section: "תחבורה", leaves: ["ציבורית", "דלק", "אחזקת רכב ותיקונים"] },
  { section: "טיפוח ויופי", leaves: ["ביגוד והנעלה", "מספרה", "קוסמטיקה"] },
  {
    section: "בכיף שלנו",
    leaves: [
      "כבלים",
      "נטפליקס",
      "פיס",
      "חופשות",
      "אפליקציות",
      "מסעדה/סרטים/הצגות",
      "חוגי מבוגרים",
      "הוצאות ריפוי",
      "חיות מחמד",
    ],
  },
  {
    section: "שונות",
    leaves: [
      "ביט",
      "עסק",
      "מעמ",
      "מס הכנסה",
      "ביטוח לאומי",
      "מוסדות קבר",
      'רכישות באתרי חו"ל',
      "העברות בנקאיות",
      "צ'קים ללא מעקב",
      "מזומן ללא מעקב",
    ],
  },
];

/** Flat list of all BASE leaf category names, in display order. */
export const TAXONOMY_LEAVES: string[] = REPORT_TAXONOMY.flatMap((s) => s.leaves);

const LEAF_SET = new Set(TAXONOMY_LEAVES);

/**
 * True when `name` is a BASE leaf. Runtime category-membership checks must use
 * the merged set (getValidLeafSet / a validLeaves param) — the only permitted
 * runtime call of this base-only check is the create-route base-leaf-collision
 * guard (see docs/plans/report-custom-categories.md, Rev 4).
 */
export function isTaxonomyLeaf(name: string): boolean {
  return LEAF_SET.has(name);
}

/** The base section names — the only sections an admin category may join. */
export const SECTION_NAMES: string[] = REPORT_TAXONOMY.map((s) => s.section);

export interface ExtraCategory {
  name: string;
  section: string;
}

/**
 * Merge admin-added categories into the base taxonomy: each extra leaf is
 * appended to its matching base section (deduped; an extra whose section is
 * not a base section is dropped defensively — create-time validation already
 * forbids it). Pure and order-stable: base sections/leaves keep their order,
 * extras append in input order.
 */
export function mergeTaxonomy(base: TaxonomySection[], extra: ExtraCategory[]): TaxonomySection[] {
  const merged = base.map((s) => ({ section: s.section, leaves: [...s.leaves] }));
  for (const e of extra) {
    const sec = merged.find((s) => s.section === e.section);
    if (sec && !sec.leaves.includes(e.name)) sec.leaves.push(e.name);
  }
  return merged;
}

/**
 * The full valid-leaf set, derived from the leaves of the SAME filtered
 * mergeTaxonomy the manifest serializes (never base ∪ raw extra names): an
 * invalid-section row dropped from the manifest is dropped here too, so the
 * manifest set and the verification/validation set are provably identical.
 */
export function mergedLeafSet(extra: ExtraCategory[]): Set<string> {
  return new Set(mergeTaxonomy(REPORT_TAXONOMY, extra).flatMap((s) => s.leaves));
}
