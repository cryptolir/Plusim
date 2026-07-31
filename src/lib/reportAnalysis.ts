/**
 * Report aggregation — the numbers behind the online report view.
 *
 * Mirrors the published workbook so the web view and the Excel/Sheet agree:
 *  - month sheets  → one column per month, category rows summed (column K)
 *  - ניתוח תוצאות  → this matrix: sections × months + a months average
 *  - התפלגות ההוצאות → section averages minus the business/tax leaves
 *  - un_categorized → the rows the agent could not classify
 *
 * Pure: transactions in, numbers out. Everything is agorot (integers) until a
 * formatter is called, and every derived total is recomputed here rather than
 * trusted from the agent — same rule as src/lib/reportResult.ts.
 */
import type { TaxonomySection } from "@/config/reportTaxonomy";

export interface AnalysisTxn {
  id: string;
  month: string;
  date: string;
  merchant: string;
  amountAgorot: number;
  category: string | null;
  uncategorized: boolean;
  sourceLabel: string;
  note: string | null;
}

/**
 * Leaves the workbook's התפלגות ההוצאות sheet subtracts from שונות
 * (=`'ניתוח תוצאות'!I58-I60-I61-I62-I63`): business and tax movements are not
 * household spend, so they must not skew the distribution. They stay in the
 * matrix — only the distribution excludes them, and the excluded sum is
 * reported so nothing disappears silently.
 */
export const DISTRIBUTION_EXCLUDED_LEAVES = ["עסק", "מעמ", "מס הכנסה", "ביטוח לאומי"];

export interface LeafRow {
  leaf: string;
  /** One entry per month in `Analysis.months`, same order. */
  byMonth: number[];
  /** Rows behind each month — a refund can net a month to 0 while rows exist. */
  countByMonth: number[];
  total: number;
  avg: number;
}

export interface SectionRow {
  section: string;
  /** Only leaves that actually carry transactions — empty ones are noise. */
  leaves: LeafRow[];
  byMonth: number[];
  countByMonth: number[];
  total: number;
  avg: number;
}

export interface DistributionSlice {
  section: string;
  /** Monthly average, after removing DISTRIBUTION_EXCLUDED_LEAVES. */
  amount: number;
  /** 0..1 of the distribution total. */
  share: number;
}

export interface Analysis {
  /** "2026-01" … ascending. Only months that actually have transactions. */
  months: string[];
  sections: SectionRow[];
  monthTotals: number[];
  grandTotal: number;
  /** grandTotal / months.length (0 when there are no months). */
  avgPerMonth: number;
  distribution: DistributionSlice[];
  /** Monthly average of what the distribution left out — shown as a footnote. */
  distributionExcludedAvg: number;
  uncategorized: AnalysisTxn[];
  uncategorizedTotal: number;
  txCount: number;
}

/** Agorot → "₪ 1,234.56" in Hebrew locale. */
export function shekel(agorot: number): string {
  return (agorot / 100).toLocaleString("he-IL", { style: "currency", currency: "ILS" });
}

const MONTH_NAMES = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

/** "2026-06" → "יוני 2026". Unparseable input is returned as-is. */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const name = MONTH_NAMES[(m ?? 0) - 1];
  return name && y ? `${name} ${y}` : month;
}

/** "2026-06" → "יוני 26" for tight table headers. */
export function monthShort(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const name = MONTH_NAMES[(m ?? 0) - 1];
  return name && y ? `${name} ${String(y).slice(2)}` : month;
}

/**
 * Build the whole view model in one pass over the transactions.
 *
 * `taxonomy` must be the MERGED taxonomy (base ∪ admin-added categories), the
 * same one /report and the assign picker use — a leaf missing from it would
 * drop real spend from the matrix, so anything categorized outside it is
 * surfaced under a synthetic section instead of being swallowed.
 */
export function buildAnalysis(transactions: AnalysisTxn[], taxonomy: TaxonomySection[]): Analysis {
  const months = [...new Set(transactions.map((t) => t.month))].sort();
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const zeros = () => new Array<number>(months.length).fill(0);

  // leaf → per-month sums, for every categorized row.
  const byLeaf = new Map<string, number[]>();
  const countLeaf = new Map<string, number[]>();
  const uncategorized: AnalysisTxn[] = [];
  for (const t of transactions) {
    if (t.uncategorized || !t.category) {
      uncategorized.push(t);
      continue;
    }
    const i = monthIndex.get(t.month);
    if (i === undefined) continue;
    const row = byLeaf.get(t.category) ?? zeros();
    row[i] += t.amountAgorot;
    byLeaf.set(t.category, row);
    const cnt = countLeaf.get(t.category) ?? zeros();
    cnt[i] += 1;
    countLeaf.set(t.category, cnt);
  }

  const known = new Set(taxonomy.flatMap((s) => s.leaves));
  const orphans = [...byLeaf.keys()].filter((leaf) => !known.has(leaf)).sort();
  const withOrphans: TaxonomySection[] =
    orphans.length > 0 ? [...taxonomy, { section: "מחוץ לטבלה", leaves: orphans }] : taxonomy;

  const sections: SectionRow[] = withOrphans.map((s) => {
    const leaves: LeafRow[] = s.leaves
      .map((leaf) => {
        const byMonth = byLeaf.get(leaf) ?? zeros();
        const countByMonth = countLeaf.get(leaf) ?? zeros();
        const total = byMonth.reduce((a, b) => a + b, 0);
        return { leaf, byMonth, countByMonth, total, avg: months.length ? total / months.length : 0 };
      })
      // Keyed on "has transactions", not "has a non-zero month": a leaf whose
      // charge and refund cancel out still has rows behind it, and dropping the
      // row would hide them from the section drill-down too.
      .filter((l) => byLeaf.has(l.leaf));
    const byMonth = zeros();
    const countByMonth = zeros();
    for (const l of leaves)
      for (let i = 0; i < months.length; i++) {
        byMonth[i] += l.byMonth[i];
        countByMonth[i] += l.countByMonth[i];
      }
    const total = byMonth.reduce((a, b) => a + b, 0);
    return {
      section: s.section,
      leaves,
      byMonth,
      countByMonth,
      total,
      avg: months.length ? total / months.length : 0,
    };
  });

  const monthTotals = zeros();
  for (const s of sections) for (let i = 0; i < months.length; i++) monthTotals[i] += s.byMonth[i];
  const grandTotal = monthTotals.reduce((a, b) => a + b, 0);

  // Distribution: section averages with the business/tax leaves taken out.
  const excludedTotal = DISTRIBUTION_EXCLUDED_LEAVES.reduce(
    (sum, leaf) => sum + (byLeaf.get(leaf)?.reduce((a, b) => a + b, 0) ?? 0),
    0,
  );
  const slices = sections
    .map((s) => {
      const excluded = s.leaves
        .filter((l) => DISTRIBUTION_EXCLUDED_LEAVES.includes(l.leaf))
        .reduce((sum, l) => sum + l.total, 0);
      const amount = months.length ? (s.total - excluded) / months.length : 0;
      return { section: s.section, amount };
    })
    .filter((s) => s.amount !== 0);
  // Shares are computed over positive spend only: a net-negative section (more
  // refunds than charges) would otherwise shrink the denominator and push every
  // other slice above 100%.
  const shareBase = slices.reduce((a, s) => a + Math.max(0, s.amount), 0);
  const distribution: DistributionSlice[] = slices
    .map((s) => ({ ...s, share: shareBase > 0 ? Math.max(0, s.amount) / shareBase : 0 }))
    .sort((a, b) => b.amount - a.amount);

  return {
    months,
    sections,
    monthTotals,
    grandTotal,
    avgPerMonth: months.length ? grandTotal / months.length : 0,
    distribution,
    distributionExcludedAvg: months.length ? excludedTotal / months.length : 0,
    uncategorized,
    uncategorizedTotal: uncategorized.reduce((a, t) => a + t.amountAgorot, 0),
    txCount: transactions.length,
  };
}
