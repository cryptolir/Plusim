/**
 * The edit rules shared by every writer of a transaction's date / category:
 * the admin edit route (transactions/[txId]) and the agent adjust route
 * (api/agent/jobs/[jobId]/adjust). Two writers must never hold two copies of
 * the income invariant (docs/plans/report-adjust-chat.md B2). Pure — no db.
 */
import { isIncomeLeaf, type TaxonomySection, type TxnKind } from "@/config/reportTaxonomy";

/** Statuses during which the agent run owns the transaction rows. */
export const AGENT_OWNS_ROWS = ["dispatched", "processing"];

/** Statuses whose rows the adjustment chat may change. */
export const ADJUSTABLE = ["completed", "needs_review", "published"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date, or null. The shape test alone accepts 2026-02-31, which
 * Date() silently rolls forward to March 3 — so the parsed value must render
 * back to the same string.
 */
export function normalizeDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !DATE_RE.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === raw ? raw : null;
}

export const EDIT_ERRORS = {
  unknownCategory: "קטגוריה לא מוכרת",
  incomeNeedsCredit: "קטגוריית הכנסה אפשרית רק לזיכוי (סכום שלילי)",
  incomeNeedsBank: "קטגוריית הכנסה אפשרית רק לשורה מחשבון בנק",
  badDate: "תאריך לא תקין",
} as const;

/** Category validity only; `incomeLeaf` tells the caller whether the row check applies. */
export function checkCategory(
  category: unknown,
  ctx: { validLeaves: Set<string>; taxonomy: TaxonomySection[] },
): { error: string } | { category: string; incomeLeaf: boolean } {
  if (typeof category !== "string" || !ctx.validLeaves.has(category)) return { error: EDIT_ERRORS.unknownCategory };
  return { category, incomeLeaf: isIncomeLeaf(category, ctx.taxonomy) };
}

/**
 * Income invariant (docs/plans/bank-statements.md B5): an הכנסות leaf is allowed
 * only on a bank credit — a negative amount from a source the parser flagged
 * as a bank. Returns the refusal, or null when allowed.
 */
export function incomeRowError(row: { amountAgorot: number; sourceLabel: string }, bankLabels: Set<string>): string | null {
  if (row.amountAgorot >= 0) return EDIT_ERRORS.incomeNeedsCredit;
  if (!bankLabels.has(row.sourceLabel)) return EDIT_ERRORS.incomeNeedsBank;
  return null;
}

/** The kind written in the SAME update as the category, so the two never diverge. */
export function kindForCategory(incomeLeaf: boolean): TxnKind {
  return incomeLeaf ? "income" : "expense";
}

export interface EditableRow {
  id: string;
  date: string;
  category: string | null;
  uncategorized: boolean;
  amountAgorot: number;
  sourceLabel: string;
  note: string | null;
}

export interface EditChange {
  field: "date" | "category";
  from: string | null;
  to: string;
}

export interface ResolvedEdit {
  data: { date?: string; month?: string; category?: string; uncategorized?: boolean; kind?: TxnKind; note?: string };
  changes: EditChange[];
}

/** The annotation appended to a row's note for each applied change (Decision 6). */
export function annotate(note: string | null, changes: EditChange[]): string {
  const parts = changes.map(
    (c) => `תוקן ע"י המנהל: ${c.field === "date" ? "תאריך" : "קטגוריה"} ${c.from ?? "ללא סיווג"} → ${c.to}`,
  );
  return [note, ...parts].filter((p) => p && p.length > 0).join(" · ");
}

/**
 * Validate one edit against its row and build the exact data to write. Only
 * date and category can ever be produced — the caller writes `data` as is.
 */
export function resolveEdit(
  row: EditableRow,
  edit: { date?: unknown; category?: unknown },
  ctx: { validLeaves: Set<string>; taxonomy: TaxonomySection[]; bankLabels: Set<string> },
): ResolvedEdit | { error: string } {
  const data: ResolvedEdit["data"] = {};
  const changes: EditChange[] = [];

  if (edit.category !== undefined) {
    const c = checkCategory(edit.category, ctx);
    if ("error" in c) return c;
    if (c.incomeLeaf) {
      const err = incomeRowError(row, ctx.bankLabels);
      if (err) return { error: err };
    }
    data.category = c.category;
    data.uncategorized = false;
    data.kind = kindForCategory(c.incomeLeaf);
    if (row.uncategorized || row.category !== c.category) {
      changes.push({ field: "category", from: row.uncategorized ? null : row.category, to: c.category });
    }
  }

  if (edit.date !== undefined) {
    const date = normalizeDate(edit.date);
    if (!date) return { error: EDIT_ERRORS.badDate };
    // month is derived in the same write — a mismatch is a FATAL verification problem.
    data.date = date;
    data.month = date.slice(0, 7);
    if (row.date !== date) changes.push({ field: "date", from: row.date, to: date });
  }

  if (changes.length > 0) data.note = annotate(row.note, changes);
  return { data, changes };
}
