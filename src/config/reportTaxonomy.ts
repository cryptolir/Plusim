/**
 * Category taxonomy for the statement-categorization pipeline.
 *
 * Mirrors the "Main" sheet of the household budget workbook: sections contain
 * leaf categories; every transaction lands in exactly one leaf (or in
 * un_categorized). This constant is serialized into every agent job manifest —
 * the manifest copy is what the agent actually uses, so app and agent can
 * never disagree on category names.
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

/** Flat list of all leaf category names, in display order. */
export const TAXONOMY_LEAVES: string[] = REPORT_TAXONOMY.flatMap((s) => s.leaves);

const LEAF_SET = new Set(TAXONOMY_LEAVES);

/** True when `name` is a valid leaf category. */
export function isTaxonomyLeaf(name: string): boolean {
  return LEAF_SET.has(name);
}
