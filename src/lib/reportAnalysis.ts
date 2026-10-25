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
import { INCOME_SECTION, type TaxonomySection } from "@/config/reportTaxonomy";
import { cycleId } from "@/lib/reportResult";

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
  /**
   * "expense" | "income" | "credit" (docs/plans/bank-statements.md). Income is
   * recognized by THIS, never by sign: a refund credit in an expense leaf is
   * also negative. Absent ⇒ expense (rows stored before the column existed).
   */
  kind?: string | null;
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

export interface IncomeBlock {
  /** Income leaves that carry rows, in taxonomy order; amounts are POSITIVE (sign flipped for display). */
  leaves: LeafRow[];
  byMonth: number[];
  total: number;
  avg: number;
}

export interface Analysis {
  /** "2026-01" … ascending. Only months that actually have transactions. */
  months: string[];
  /** Expense sections only — income rows never enter these. */
  sections: SectionRow[];
  monthTotals: number[];
  grandTotal: number;
  /** grandTotal / months.length (0 when there are no months). */
  avgPerMonth: number;
  distribution: DistributionSlice[];
  /** Monthly average of what the distribution left out — shown as a footnote. */
  distributionExcludedAvg: number;
  /** kind === "income" rows (bank credits in the הכנסות section), positive. */
  income: IncomeBlock;
  /** מצבנו: income − expenses, per month and on average. */
  netByMonth: number[];
  netAvg: number;
  /** Uncategorized debits (and card refunds) — the rows the agent could not place. */
  uncategorized: AnalysisTxn[];
  uncategorizedTotal: number;
  /** Uncategorized bank credits (kind === "credit"): income or refund, undecided. Listed apart so a −₪19k salary never nets against unplaced expenses. */
  uncategorizedCredits: AnalysisTxn[];
  uncategorizedCreditsTotal: number;
  txCount: number;
}

/** Agorot → "₪ 1,234.56" in Hebrew locale. */
export function shekel(agorot: number): string {
  return (agorot / 100).toLocaleString("he-IL", { style: "currency", currency: "ILS" });
}

/**
 * Installment info from a transaction note: "תשלום 8 מתוך 12" → {n: 8, of: 12},
 * including the RTL-reordered credit wording "תשלום - קרדיט 6 מתוך 13".
 *
 * The marker rides the existing free-text `note` — the card parsers already put
 * it there and it survives every hop (payload → DB → views → workbook), so no
 * column and no stored field. Display-only by design: nothing in verification,
 * month bucketing, or export may branch on this.
 *
 * The bounded gap (≤20 non-digits) is what stops "תשלום" in one clause and
 * digits from an unrelated later clause — notes are concatenated with " · " —
 * from bridging into a false match. Mirrors INSTALLMENT_RE in
 * agent/skills/plusim-reports/scripts/parse_leumi_pdf.py; the two must agree,
 * or a row the parser re-dated would show no badge (or the reverse).
 */
export function installmentInfo(note: string | null | undefined): { n: number; of: number } | null {
  const m = /תשלום(?:[^0-9]{0,20})(\d{1,3})\s*מתוך\s*(\d{1,3})/.exec(note ?? "");
  return m ? { n: Number(m[1]), of: Number(m[2]) } : null;
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
  const incomeByLeaf = new Map<string, number[]>();
  const incomeCount = new Map<string, number[]>();
  const uncategorized: AnalysisTxn[] = [];
  const uncategorizedCredits: AnalysisTxn[] = [];
  for (const t of transactions) {
    if (t.uncategorized || !t.category) {
      (t.kind === "credit" ? uncategorizedCredits : uncategorized).push(t);
      continue;
    }
    const i = monthIndex.get(t.month);
    if (i === undefined) continue;
    if (t.kind === "income") {
      // Income leaves the expense matrix entirely; shown positive.
      const row = incomeByLeaf.get(t.category) ?? zeros();
      row[i] += -t.amountAgorot;
      incomeByLeaf.set(t.category, row);
      const cnt = incomeCount.get(t.category) ?? zeros();
      cnt[i] += 1;
      incomeCount.set(t.category, cnt);
      continue;
    }
    const row = byLeaf.get(t.category) ?? zeros();
    row[i] += t.amountAgorot;
    byLeaf.set(t.category, row);
    const cnt = countLeaf.get(t.category) ?? zeros();
    cnt[i] += 1;
    countLeaf.set(t.category, cnt);
  }

  const expenseTaxonomy = taxonomy.filter((s) => s.section !== INCOME_SECTION);
  const known = new Set(expenseTaxonomy.flatMap((s) => s.leaves));
  const orphans = [...byLeaf.keys()].filter((leaf) => !known.has(leaf)).sort();
  const withOrphans: TaxonomySection[] =
    orphans.length > 0 ? [...expenseTaxonomy, { section: "מחוץ לטבלה", leaves: orphans }] : expenseTaxonomy;

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

  // Income block: the הכנסות leaves in taxonomy order, then any income leaf
  // the taxonomy no longer lists (never swallowed), as on the expense side.
  const incomeOrder = taxonomy.filter((s) => s.section === INCOME_SECTION).flatMap((s) => s.leaves);
  const incomeLeafNames = [
    ...incomeOrder.filter((l) => incomeByLeaf.has(l)),
    ...[...incomeByLeaf.keys()].filter((l) => !incomeOrder.includes(l)).sort(),
  ];
  const incomeLeaves: LeafRow[] = incomeLeafNames.map((leaf) => {
    const byMonth = incomeByLeaf.get(leaf) ?? zeros();
    const countByMonth = incomeCount.get(leaf) ?? zeros();
    const total = byMonth.reduce((a, b) => a + b, 0);
    return { leaf, byMonth, countByMonth, total, avg: months.length ? total / months.length : 0 };
  });
  const incomeByMonth = zeros();
  for (const l of incomeLeaves) for (let i = 0; i < months.length; i++) incomeByMonth[i] += l.byMonth[i];
  const incomeTotal = incomeByMonth.reduce((a, b) => a + b, 0);
  const netByMonth = months.map((_, i) => incomeByMonth[i] - monthTotals[i]);

  return {
    months,
    sections,
    monthTotals,
    grandTotal,
    avgPerMonth: months.length ? grandTotal / months.length : 0,
    distribution,
    distributionExcludedAvg: months.length ? excludedTotal / months.length : 0,
    income: {
      leaves: incomeLeaves,
      byMonth: incomeByMonth,
      total: incomeTotal,
      avg: months.length ? incomeTotal / months.length : 0,
    },
    netByMonth,
    netAvg: months.length ? (incomeTotal - grandTotal) / months.length : 0,
    uncategorized,
    uncategorizedTotal: uncategorized.reduce((a, t) => a + t.amountAgorot, 0),
    uncategorizedCredits,
    uncategorizedCreditsTotal: uncategorizedCredits.reduce((a, t) => a + t.amountAgorot, 0),
    txCount: transactions.length,
  };
}

// ── Settlement reconciliation (docs/plans/bank-statements.md C1, Decision 5) ──

export interface PerSourceCycles {
  label: string;
  statementTotalAgorot: number | null;
  chargeCycles?: { chargeDate: string; amountAgorot: number }[];
  bank?: boolean;
}

export interface MatchTarget {
  /** `${label}@${chargeDate}` */
  id: string;
  label: string;
  chargeDate: string;
  /** The card's own cycle amount (domestic for a Leumi card statement). */
  amountAgorot: number;
  /** cycle + the sibling `<label>-foreign` total when one exists — what the bank actually debits. */
  targetAgorot: number;
}

export interface SettlementLike {
  id: string;
  month: string;
  payee: string;
  amountAgorot: number;
}

/** Suggestion tolerance: ₪5 either way. */
export const MATCH_TOLERANCE_AGOROT = 500;

/**
 * The stored verification's perSource list — the ONE reader of that shape for
 * every consumer (/report, the admin edit route, the match allow-list). `[]`
 * for a null or old-shape verification: fail closed.
 */
export function perSourceOf(verification: unknown): PerSourceCycles[] {
  if (typeof verification !== "object" || verification === null) return [];
  const per = (verification as { perSource?: unknown }).perSource;
  if (!Array.isArray(per)) return [];
  return per.filter(
    (s): s is PerSourceCycles =>
      typeof s === "object" && s !== null && typeof (s as { label?: unknown }).label === "string",
  );
}

/** Labels of the job's bank current-account sources (AgentSourceTotal.bank). */
export function bankSources(verification: unknown): Set<string> {
  return new Set(perSourceOf(verification).filter((s) => s.bank === true).map((s) => s.label));
}

/**
 * Every charge cycle of the job as a match target. The bank pays a card's
 * domestic and foreign sections in ONE debit, so the sibling `<label>-foreign`
 * source's total is added to the card's REGULAR cycle — the latest charge date
 * of the source (an early-repayment subtotal is an earlier, separate block and
 * carries no foreign charges). The Leumi card parser emits cycles for the
 * domestic section only, so their Σ still equals that section's total.
 */
export function matchTargets(perSource: PerSourceCycles[]): MatchTarget[] {
  const out: MatchTarget[] = [];
  for (const s of perSource) {
    if (!s.chargeCycles || s.chargeCycles.length === 0) continue;
    const base = s.label.endsWith("-domestic") ? s.label.slice(0, -"-domestic".length) : null;
    const foreign = base ? perSource.find((f) => f.label === `${base}-foreign`) : undefined;
    const foreignTotal = foreign?.statementTotalAgorot ?? 0;
    const latest = [...s.chargeCycles].map((c) => c.chargeDate).sort().at(-1);
    for (const c of s.chargeCycles) {
      out.push({
        id: cycleId(s.label, c.chargeDate),
        label: s.label,
        chargeDate: c.chargeDate,
        amountAgorot: c.amountAgorot,
        targetAgorot: c.amountAgorot + (c.chargeDate === latest ? foreignTotal : 0),
      });
    }
  }
  return out;
}

/**
 * The cycle ids a settlement of this job may be matched to — the allow-list
 * the client write route checks. `[]` for a null or old-shape verification:
 * fail closed, nothing to match.
 */
export function allowedMatchTargets(verification: unknown): string[] {
  return matchTargets(perSourceOf(verification)).map((t) => t.id);
}

/** The first token of a payee — the issuer, shared by every debit to it ("מקס איט פיננ-י" → "מקס"). */
function issuerToken(payee: string): string {
  return payee.split(/[\s\-\.,'"]+/).filter(Boolean)[0] ?? payee;
}

/**
 * Pre-selection only — the client confirms (Decision 5). A settlement suggests
 * a cycle when the cycle's charge month equals the settlement's month and
 * either the settlement alone, or the sum of the same-month settlements to the
 * same issuer, is within ₪5 of the cycle's target. Many-to-one by design:
 * Leumi pays MAX in two debits. A source without cycles is never suggested.
 */
export function suggestMatches(settlements: SettlementLike[], perSource: PerSourceCycles[]): Map<string, string> {
  const targets = matchTargets(perSource);
  const out = new Map<string, string>();
  if (targets.length === 0) return out;
  const groupSum = new Map<string, number>();
  for (const s of settlements) {
    const k = `${s.month}|${issuerToken(s.payee)}`;
    groupSum.set(k, (groupSum.get(k) ?? 0) + s.amountAgorot);
  }
  for (const s of settlements) {
    const group = groupSum.get(`${s.month}|${issuerToken(s.payee)}`) ?? s.amountAgorot;
    const hits = targets.filter(
      (t) =>
        t.chargeDate.slice(0, 7) === s.month &&
        (Math.abs(s.amountAgorot - t.targetAgorot) <= MATCH_TOLERANCE_AGOROT ||
          Math.abs(group - t.targetAgorot) <= MATCH_TOLERANCE_AGOROT),
    );
    // Two cycles within ₪5 of the same debit (two cards charged alike in one
    // month) is ambiguous: a suggestion here is a wrong reconciliation one
    // click away. The source label says nothing reliable about the issuer, so
    // nothing is suggested and the client picks.
    if (hits.length === 1) out.set(s.id, hits[0].id);
  }
  return out;
}
