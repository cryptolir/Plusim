/**
 * Agent result payload: strict parsing + independent verification.
 *
 * The agent's callback is never trusted arithmetically: we re-sum the
 * transactions it sent and compare against the statement totals its parsers
 * reported per source. Any mismatch, invalid category, bad month, or duplicate
 * dedupKey demotes the job to needs_review — the report is stored either way
 * so the admin can inspect what came back.
 *
 * Category membership is checked against a REQUIRED `validLeaves` set (the
 * merged base ∪ ReportCategory taxonomy, from getValidLeafSet()). There is
 * deliberately NO default: a caller that forgets to pass the merged set is a
 * typecheck error, never a silent base-only fallback that would turn a legit
 * admin-added leaf into a false FATAL (plan Rev 3/4).
 *
 * Bank statements (docs/plans/bank-statements.md B2): a transaction may carry
 * `kind` ("income" | "credit"; absent ⇒ expense), the result may carry
 * `settlements` (card-statement debits kept out of the transactions), and a
 * card source may carry `chargeCycles`. All optional — a skill predating them
 * sends none and verifies exactly as before. The merged taxonomy is a REQUIRED
 * argument of verifyAgentResult so the income invariant is checked against the
 * same הכנסות section the manifest served.
 */
import { INCOME_SECTION, isIncomeLeaf, type TaxonomySection } from "@/config/reportTaxonomy";

export interface AgentTxn {
  month: string; // "2026-06"
  date: string; // "2026-06-14"
  merchant: string;
  amountAgorot: number;
  category: string | null;
  uncategorized: boolean;
  sourceLabel: string;
  note?: string;
  dedupKey: string;
  /**
   * Set by a card parser when a row is an installment (תשלום N מתוך M) that no
   * charge date could be found for — neither its own total block's nor the
   * statement header's — so it still holds the ORIGINAL DEAL date and may sit
   * in the wrong month. Surfaces as a non-blocking NOTE naming the rows, since
   * a missing charge date must never block the report; the admin corrects the
   * date in place. Optional: skill versions predating the flag never send it,
   * and its absence must verify exactly as before. Transient — never persisted.
   */
  undatedInstallment?: boolean;
  /**
   * "income": a bank credit categorized into the הכנסות section. "credit": a bank
   * credit the agent could not place (income or refund — still undecided, so
   * it is listed apart from uncategorized debits). Absent ⇒ expense, which is
   * every card row, every bank debit, and a refund credit in an expense leaf.
   * Strict string match like `undatedInstallment`.
   */
  kind?: "income" | "credit";
}

/**
 * One charge block of a card statement: what the bank debits on that date.
 * A type alias, not an interface: it is stored inside the `verification` Json
 * column, and Prisma's InputJsonValue accepts aliases (implicit index
 * signature) but not interfaces.
 */
export type AgentChargeCycle = {
  chargeDate: string; // "YYYY-MM-DD"
  amountAgorot: number;
};

export interface AgentSourceTotal {
  label: string;
  statementTotalAgorot: number | null; // null = statement carries no usable total
  computedTotalAgorot: number;
  /** Only on a source with a printed total; Σ amountAgorot === that total. */
  chargeCycles?: AgentChargeCycle[];
  /**
   * The source is a bank current account (set by the skill from the parser
   * that produced it). Explicit on purpose: a missing printed total is NOT the
   * criterion — a MAX pending section has none either and is a card. Only a
   * bank source may carry income rows or settlements.
   */
  bank?: true;
}

/** A bank debit that paid a card statement — reconciled by the client, never summed. */
export interface AgentSettlement {
  date: string;
  month: string;
  payee: string;
  amountAgorot: number; // positive
  sourceLabel: string; // a bank source (statementTotalAgorot === null)
  dedupKey: string;
}

export interface AgentResult {
  status: "ok" | "needs_review";
  transactions: AgentTxn[];
  sourceTotals: AgentSourceTotal[];
  settlements?: AgentSettlement[];
  xlsxBase64: string;
  xlsxFilename?: string;
  proposedMappings: { merchant: string; category: string; evidence?: string }[];
  agentNotes?: string;
}

/**
 * Hebrew for a rejected agent result.
 *
 * The thrown messages are an agent-contract vocabulary — English on purpose,
 * and they stay that way in the HTTP response and the logs. But the same text
 * lands in `ReportJob.error`, which the job page renders verbatim to a person
 * ("תוצאת הסוכן נדחתה: transactions empty"), so it gets translated here.
 *
 * Only "transactions empty" earns a real explanation: it is the one rejection
 * an admin can act on (wrong file, unreadable scan). The rest are agent bugs —
 * a Hebrew sentence plus the raw detail is enough to report them.
 */
export function rejectionHe(msg: string): string {
  if (msg === "transactions empty") {
    return "הסוכן לא מצא אף עסקה בקבצים. בדקו שהקבצים הם דפי חשבון של כרטיס אשראי, ושהטקסט בהם ניתן לקריאה (קובץ סרוק כתמונה לא ייקרא).";
  }
  if (msg.startsWith("xlsx")) return `קובץ האקסל שהסוכן יצר אינו תקין (${msg})`;
  return `תשובת הסוכן לא עברה בדיקת תקינות (${msg})`;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TXNS = 5000;
const MAX_SETTLEMENTS = 2000;
const MAX_CYCLES = 24;
const MAX_STR = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, cap = MAX_STR): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= cap ? v : null;
}

function intAgorot(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) < 1_000_000_000 ? v : null;
}

/** Parse + structurally validate the callback body. Throws with a reason on malformed input. */
export function parseAgentResult(body: unknown, validLeaves: Set<string>): AgentResult {
  if (!isRecord(body)) throw new Error("body is not an object");
  const status = body.status === "ok" || body.status === "needs_review" ? body.status : null;
  if (!status) throw new Error("status must be ok|needs_review");

  if (!Array.isArray(body.transactions)) throw new Error("transactions missing");
  if (body.transactions.length === 0) throw new Error("transactions empty");
  if (body.transactions.length > MAX_TXNS) throw new Error("too many transactions");

  const transactions: AgentTxn[] = body.transactions.map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`txn[${i}] not an object`);
    const month = str(raw.month, 7);
    const date = str(raw.date, 10);
    const merchant = str(raw.merchant);
    const amountAgorot = intAgorot(raw.amountAgorot);
    const sourceLabel = str(raw.sourceLabel, 100);
    const dedupKey = str(raw.dedupKey, 200);
    const uncategorized = raw.uncategorized === true;
    const category = uncategorized ? null : str(raw.category);
    if (!month || !MONTH_RE.test(month)) throw new Error(`txn[${i}] bad month`);
    if (!date || !DATE_RE.test(date)) throw new Error(`txn[${i}] bad date`);
    if (!merchant) throw new Error(`txn[${i}] bad merchant`);
    if (amountAgorot === null || amountAgorot === undefined) throw new Error(`txn[${i}] bad amount`);
    if (!sourceLabel) throw new Error(`txn[${i}] bad sourceLabel`);
    if (!dedupKey) throw new Error(`txn[${i}] bad dedupKey`);
    if (!uncategorized && !category) throw new Error(`txn[${i}] categorized without category`);
    const txn: AgentTxn = {
      month,
      date,
      merchant,
      amountAgorot,
      category,
      uncategorized,
      sourceLabel,
      note: typeof raw.note === "string" ? raw.note.slice(0, MAX_STR) : undefined,
      dedupKey,
      // Strict === true: anything else (absent, null, "false") is not a flag.
      undatedInstallment: raw.undatedInstallment === true ? true : undefined,
      // Strict string match; "expense" is the absent default and is not stored
      // on the wire. Any other value is a contract violation, not a guess.
      kind: raw.kind === "income" || raw.kind === "credit" ? raw.kind : undefined,
    };
    if (raw.kind !== undefined && raw.kind !== "income" && raw.kind !== "credit") {
      throw new Error(`txn[${i}] bad kind`);
    }
    return txn;
  });

  if (!Array.isArray(body.sourceTotals)) throw new Error("sourceTotals missing");
  const sourceTotals: AgentSourceTotal[] = body.sourceTotals.map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`sourceTotals[${i}] not an object`);
    const label = str(raw.label, 100);
    if (!label) throw new Error(`sourceTotals[${i}] bad label`);
    const stmt = raw.statementTotalAgorot === null ? null : intAgorot(raw.statementTotalAgorot);
    const computed = intAgorot(raw.computedTotalAgorot);
    if (stmt === undefined || computed === null) throw new Error(`sourceTotals[${i}] bad totals`);
    const total: AgentSourceTotal = { label, statementTotalAgorot: stmt, computedTotalAgorot: computed };
    if (raw.bank === true) total.bank = true;
    if (raw.chargeCycles !== undefined) {
      if (!Array.isArray(raw.chargeCycles)) throw new Error(`sourceTotals[${i}] bad chargeCycles`);
      if (raw.chargeCycles.length > MAX_CYCLES) throw new Error(`sourceTotals[${i}] too many chargeCycles`);
      total.chargeCycles = raw.chargeCycles.map((c, k) => {
        if (!isRecord(c)) throw new Error(`sourceTotals[${i}].chargeCycles[${k}] not an object`);
        const chargeDate = str(c.chargeDate, 10);
        const amountAgorot = intAgorot(c.amountAgorot);
        if (!chargeDate || !DATE_RE.test(chargeDate)) throw new Error(`sourceTotals[${i}].chargeCycles[${k}] bad chargeDate`);
        if (amountAgorot === null) throw new Error(`sourceTotals[${i}].chargeCycles[${k}] bad amount`);
        return { chargeDate, amountAgorot };
      });
    }
    return total;
  });

  let settlements: AgentSettlement[] | undefined;
  if (body.settlements !== undefined) {
    if (!Array.isArray(body.settlements)) throw new Error("settlements not an array");
    if (body.settlements.length > MAX_SETTLEMENTS) throw new Error("too many settlements");
    settlements = body.settlements.map((raw, i) => {
      if (!isRecord(raw)) throw new Error(`settlement[${i}] not an object`);
      const month = str(raw.month, 7);
      const date = str(raw.date, 10);
      const payee = str(raw.payee);
      const amountAgorot = intAgorot(raw.amountAgorot);
      const sourceLabel = str(raw.sourceLabel, 100);
      const dedupKey = str(raw.dedupKey, 200);
      if (!month || !MONTH_RE.test(month)) throw new Error(`settlement[${i}] bad month`);
      if (!date || !DATE_RE.test(date)) throw new Error(`settlement[${i}] bad date`);
      if (!payee) throw new Error(`settlement[${i}] bad payee`);
      if (amountAgorot === null) throw new Error(`settlement[${i}] bad amount`);
      if (!sourceLabel) throw new Error(`settlement[${i}] bad sourceLabel`);
      if (!dedupKey) throw new Error(`settlement[${i}] bad dedupKey`);
      return { month, date, payee, amountAgorot, sourceLabel, dedupKey };
    });
  }

  const xlsxBase64 = typeof body.xlsxBase64 === "string" ? body.xlsxBase64 : "";
  if (!xlsxBase64 || xlsxBase64.length > 20_000_000) throw new Error("xlsxBase64 missing or too large");

  const proposedMappings = Array.isArray(body.proposedMappings)
    ? body.proposedMappings.flatMap((raw) => {
        if (!isRecord(raw)) return [];
        const merchant = str(raw.merchant, 200);
        const category = str(raw.category, 200);
        if (!merchant || !category || !validLeaves.has(category)) return [];
        return [{ merchant, category, evidence: typeof raw.evidence === "string" ? raw.evidence.slice(0, MAX_STR) : undefined }];
      })
    : [];

  return {
    status,
    transactions,
    sourceTotals,
    settlements,
    xlsxBase64,
    xlsxFilename: typeof body.xlsxFilename === "string" ? body.xlsxFilename.slice(0, 200) : undefined,
    proposedMappings,
    agentNotes: typeof body.agentNotes === "string" ? body.agentNotes.slice(0, 4000) : undefined,
  };
}

/**
 * Whether a per-source total gap is small enough to be a note rather than a
 * publish blocker. THREE conditions, all of which must hold — the waiver is
 * deliberately hard to earn, because everything it lets through is a report
 * published with numbers that do not reconcile.
 *
 *  1. SHORTFALL ONLY. Only `recomputed < statement` qualifies. The artifact this
 *     exists for is missing rows (trailing summary lines the statement's own
 *     total counts and the row parse does not), which can only ever undercount.
 *     An OVER-count means a row exists that the statement does not justify — a
 *     misparse or a spurious row with a unique dedupKey, which no other check
 *     catches — and publishing inflated expenses is worse than blocking
 *     (Codex #41 P2).
 *  2. ABSOLUTE CAP. At most MINOR_GAP_CAP_AGOROT, full stop.
 *  3. PROPORTION CAP. AND at most MINOR_GAP_MAX_SHARE of the statement.
 *
 * (2) and (3) are an AND, not the `max()` this shipped with first. `max()` took
 * the more PERMISSIVE of the two, which admitted precisely the failures the
 * reconciliation gate exists to catch (Codex #41 P1): a ₪1,000 row dropped from
 * a ₪50,000 statement is 2%, and a source totalling ≤ ₪150 that lost EVERY row
 * has a gap equal to its whole total yet still sat under the flat floor. Under
 * the AND both are fatal — 100% of a source can never be under 2% of it.
 *
 * Calibrated on job "s1" source max-2: ₪87.80 short on ₪7,365.91 (1.2%),
 * reproduced with the CURRENT parser, so not the charge-summary bug #38 fixed.
 * On that statement the proportion cap binds first (₪147.31), not the flat one.
 */
export const MINOR_GAP_CAP_AGOROT = 15_000; // ₪150 — absolute ceiling
export const MINOR_GAP_MAX_SHARE = 0.02; // AND at most 2% of the statement

export function isMinorTotalGap(
  recomputedAgorot: number,
  statementTotalAgorot: number | null,
): boolean {
  // No statement total ⇒ nothing to reconcile against, so nothing to waive.
  // A non-positive total is outside the calibrated shape; fail closed.
  if (statementTotalAgorot === null || statementTotalAgorot <= 0) return false;
  const shortfall = statementTotalAgorot - recomputedAgorot;
  if (shortfall <= 0) return false; // (1) over-count is never minor
  return (
    shortfall <= MINOR_GAP_CAP_AGOROT && // (2)
    shortfall <= statementTotalAgorot * MINOR_GAP_MAX_SHARE // (3)
  );
}

/** Agorot → "₪1,234.56". Shared so a note and the UI never disagree on format. */
export function shekel(agorot: number): string {
  return `₪${(agorot / 100).toLocaleString("he-IL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface VerificationOutcome {
  ok: boolean;
  /**
   * True when any integrity check failed (a MATERIAL per-source total mismatch,
   * unknown category, date-outside-month, duplicate dedupKey, orphan source).
   * These are FATAL — distinct from a job that merely has uncategorized rows
   * awaiting admin categorization (non-fatal). The publish route refuses fatal
   * jobs.
   */
  fatal: boolean;
  problems: string[];
  /**
   * Findings worth showing but not worth blocking on — today, a total gap under
   * isMinorTotalGap(). Kept separate from `problems` precisely so "visible" and
   * "blocking" stop being the same decision: the old code had only one list, so
   * surfacing a small gap at all meant refusing to publish the report.
   */
  notes: string[];
  perSource: {
    label: string;
    statementTotalAgorot: number | null;
    recomputedTotalAgorot: number;
    match: boolean;
    /** Mismatched, but within isMinorTotalGap — shown as a note, not a blocker. */
    minorGap?: boolean;
    /** Carried verbatim from the agent; a cycle's id is `${label}@${chargeDate}`. */
    chargeCycles?: AgentChargeCycle[];
    /** A bank current-account source (AgentSourceTotal.bank). */
    bank?: true;
  }[];
  txCount: number;
  uncategorizedCount: number;
  /** Count of card-settlement debits kept out of the transactions. */
  settlementCount: number;
  /**
   * Σ of the settlements when no card source has charge cycles — nothing to
   * match them against (bank-only job, Isracard xlsx). Absent otherwise. The
   * client card and the admin panel read THIS, not the note's wording.
   */
  unmatchedSettlementsAgorot?: number;
  /** Expense totals per month — income rows are excluded. */
  monthTotalsAgorot: Record<string, number>;
}

/** The id the client matches a settlement against: one per charge block of a card source. */
export function cycleId(label: string, chargeDate: string): string {
  return `${label}@${chargeDate}`;
}

/** The one sentence shown wherever settlements exist with no cycle to match (plan B2). */
export function noCyclesNote(count: number, sumAgorot: number): string {
  return `${count} חיובי כרטיס אשראי בסך ${shekel(sumAgorot)} נמצאו בחשבון הבנק ללא מחזור חיוב תואם להתאמה — אינם נספרים כהוצאה`;
}

/**
 * Independently verify the parsed result. Never trusts the agent's own sums.
 * `taxonomy` is the merged base ∪ DB taxonomy (the one the manifest served) —
 * required, so the income invariant can never fall back to the base section.
 */
export function verifyAgentResult(
  result: AgentResult,
  validLeaves: Set<string>,
  taxonomy: TaxonomySection[],
): VerificationOutcome {
  const problems: string[] = [];
  const notes: string[] = [];
  const bankSources = new Set(result.sourceTotals.filter((s) => s.bank === true).map((s) => s.label));

  // Category validity (structural pass already ensured presence).
  for (const t of result.transactions) {
    if (!t.uncategorized && t.category && !validLeaves.has(t.category)) {
      problems.push(`קטגוריה לא מוכרת "${t.category}" (${t.merchant})`);
    }
    if (!t.date.startsWith(t.month)) {
      problems.push(`תאריך העסקה ${t.date} אינו בחודש ${t.month} (${t.merchant})`);
    }
    // Income invariant (plan B2): kind === "income" ⇔ leaf ∈ הכנסות, and an
    // income row is a negative amount from a bank source. Held by the persisted
    // kind, never by sign — a refund credit in an expense leaf is also negative.
    if (!t.uncategorized && t.category && validLeaves.has(t.category)) {
      const income = isIncomeLeaf(t.category, taxonomy);
      if (t.kind === "income" && !income) {
        problems.push(`שורת הכנסה בקטגוריית הוצאה "${t.category}" (${t.merchant} ${t.date})`);
      } else if (income && t.kind !== "income") {
        problems.push(`קטגוריית ${INCOME_SECTION} "${t.category}" על שורה שאינה הכנסה (${t.merchant} ${t.date})`);
      }
      if (income) {
        if (t.amountAgorot >= 0) {
          problems.push(`הכנסה בסכום שאינו זיכוי ${shekel(t.amountAgorot)} (${t.merchant} ${t.date})`);
        }
        if (!bankSources.has(t.sourceLabel)) {
          problems.push(`הכנסה ממקור שאינו חשבון בנק "${t.sourceLabel}" (${t.merchant} ${t.date})`);
        }
      }
    }
    // An undecided credit is by definition unplaced: the skill resolves every
    // categorized credit to income or expense (refund). A categorized "credit"
    // would be summed as spend yet hidden from both uncategorized lists.
    if (t.kind === "credit" && !t.uncategorized) {
      problems.push(`זיכוי מסווג שנותר ללא הכרעה (הכנסה/החזר): ${t.merchant} ${t.date}`);
    }
  }

  // Installments the parser could not re-date: no block charge date and no
  // statement header date either, so the row still holds its DEAL date and may
  // sit in the wrong month. A NOTE, not a problem — the owner's rule is that a
  // missing charge date never blocks the report (2026-08-04); the admin fixes
  // the date in place, which is why the message names the editor. date/month
  // agree with each other, so nothing else surfaces these at all.
  const undated = result.transactions.filter((t) => t.undatedInstallment);
  if (undated.length > 0) {
    const names = undated
      .slice(0, 5)
      .map((t) => `${t.merchant} (${t.date})`)
      .join(", ");
    const more = undated.length > 5 ? ` ועוד ${undated.length - 5}` : "";
    notes.push(
      `${undated.length} תשלומים ללא תאריך חיוב נותרו בתאריך העסקה המקורי — ${names}${more}. ` +
        `ניתן לתקן את התאריך בטבלת כל העסקאות.`,
    );
  }

  // Duplicate identity check.
  const seen = new Map<string, number>();
  for (const t of result.transactions) {
    const n = (seen.get(t.dedupKey) ?? 0) + 1;
    seen.set(t.dedupKey, n);
    if (n === 2) problems.push(`עסקה כפולה (${t.dedupKey})`);
  }

  // Settlements (plan B2): never summed anywhere, but they must be real bank
  // debits of this result — a card-labelled settlement is a parser bug, and a
  // key shared with a transaction means a row was counted AND set aside.
  const settlements = result.settlements ?? [];
  const seenSettlement = new Set<string>();
  for (const s of settlements) {
    if (s.amountAgorot <= 0) problems.push(`חיוב כרטיס בסכום שאינו חיובי ${shekel(s.amountAgorot)} (${s.payee} ${s.date})`);
    if (!s.date.startsWith(s.month)) problems.push(`תאריך חיוב הכרטיס ${s.date} אינו בחודש ${s.month} (${s.payee})`);
    if (!bankSources.has(s.sourceLabel)) {
      problems.push(`חיוב כרטיס ממקור שאינו חשבון בנק "${s.sourceLabel}" (${s.payee} ${s.date})`);
    }
    if (seen.has(s.dedupKey)) problems.push(`חיוב כרטיס זהה לעסקה (${s.dedupKey})`);
    if (seenSettlement.has(s.dedupKey)) problems.push(`חיוב כרטיס כפול (${s.dedupKey})`);
    seenSettlement.add(s.dedupKey);
  }

  // Recompute per-source totals from the transactions themselves.
  const bySource = new Map<string, number>();
  for (const t of result.transactions) {
    bySource.set(t.sourceLabel, (bySource.get(t.sourceLabel) ?? 0) + t.amountAgorot);
  }
  const perSource = result.sourceTotals.map((s) => {
    const recomputed = bySource.get(s.label) ?? 0;
    const match = s.statementTotalAgorot === null ? true : recomputed === s.statementTotalAgorot;
    let minorGap = false;
    if (!match) {
      const gap = Math.abs(recomputed - (s.statementTotalAgorot ?? 0));
      const line =
        `מקור "${s.label}": הסכום המחושב ${shekel(recomputed)} ≠ הסכום בדף החשבון ` +
        `${shekel(s.statementTotalAgorot ?? 0)} (הפרש ${shekel(gap)})`;
      // A small gap is a known reconciliation artifact — trailing summary lines
      // some statements print after the last transaction, which the statement's
      // own total counts and the row parse does not. It stays VISIBLE as a note
      // but must not block a report that is otherwise complete.
      //
      // A large gap is the shape of a real parse failure (a dropped section, a
      // layout change), where publishing would ship a materially wrong report.
      // That still blocks, so the check keeps the job it exists to do.
      minorGap = isMinorTotalGap(recomputed, s.statementTotalAgorot);
      if (minorGap) {
        notes.push(`${line} — פער קטן, כנראה שורות סיכום בסוף דף החשבון; אינו חוסם פרסום`);
      } else {
        problems.push(line);
      }
    }
    // Charge cycles (plan B2): only a source with a printed total has them,
    // they sum to that total exactly, and no two share a date.
    if (s.bank && s.statementTotalAgorot !== null) {
      problems.push(`מקור בנק "${s.label}" מדווח סכום דף חשבון — חשבון בנק אינו מדפיס סכום כולל`);
    }
    if (s.chargeCycles) {
      if (s.statementTotalAgorot === null) {
        problems.push(`למקור "${s.label}" מחזורי חיוב אך אין סכום בדף החשבון`);
      } else {
        const sum = s.chargeCycles.reduce((n, c) => n + c.amountAgorot, 0);
        if (sum !== s.statementTotalAgorot) {
          problems.push(
            `מקור "${s.label}": סכום מחזורי החיוב ${shekel(sum)} ≠ הסכום בדף החשבון ${shekel(s.statementTotalAgorot)}`,
          );
        }
      }
      const dates = new Set(s.chargeCycles.map((c) => c.chargeDate));
      if (dates.size !== s.chargeCycles.length) problems.push(`מקור "${s.label}": תאריך חיוב חוזר במחזורי החיוב`);
    }
    return {
      label: s.label,
      statementTotalAgorot: s.statementTotalAgorot,
      recomputedTotalAgorot: recomputed,
      match,
      minorGap,
      ...(s.chargeCycles ? { chargeCycles: s.chargeCycles } : {}),
      ...(s.bank ? { bank: true as const } : {}),
    };
  });
  // A source present in transactions but missing from sourceTotals is suspicious.
  for (const label of bySource.keys()) {
    if (!result.sourceTotals.some((s) => s.label === label)) {
      problems.push(`למקור "${label}" יש עסקאות אך אין סכום מדווח בדף החשבון`);
    }
  }

  // Settlements with nothing to match against: a bank-only job, or a card
  // source without charge dates (Isracard xlsx). The card spend they paid is
  // not in this report and must never go missing silently — a NOTE, so the
  // admin and the client's card both say so (plan B2).
  let unmatchedSettlementsAgorot: number | undefined;
  if (settlements.length > 0 && !result.sourceTotals.some((s) => s.chargeCycles && s.chargeCycles.length > 0)) {
    unmatchedSettlementsAgorot = settlements.reduce((n, s) => n + s.amountAgorot, 0);
    notes.push(noCyclesNote(settlements.length, unmatchedSettlementsAgorot));
  }

  // Expense totals only: income rows are the other side of מצבנו.
  const monthTotalsAgorot: Record<string, number> = {};
  for (const t of result.transactions) {
    if (!t.uncategorized && t.kind !== "income") {
      monthTotalsAgorot[t.month] = (monthTotalsAgorot[t.month] ?? 0) + t.amountAgorot;
    }
  }

  return {
    // `ok` stays "nothing at all to report" — a note is still something the
    // admin should read, even though it does not block.
    ok: problems.length === 0 && notes.length === 0,
    fatal: problems.length > 0,
    problems,
    notes,
    perSource,
    txCount: result.transactions.length,
    uncategorizedCount: result.transactions.filter((t) => t.uncategorized).length,
    settlementCount: settlements.length,
    ...(unmatchedSettlementsAgorot !== undefined ? { unmatchedSettlementsAgorot } : {}),
    monthTotalsAgorot,
  };
}

/** Decode + sanity-check the xlsx (must be a ZIP container). */
export function decodeXlsx(xlsxBase64: string): Buffer {
  const buf = Buffer.from(xlsxBase64, "base64");
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error("xlsx payload is not a valid zip container");
  }
  if (buf.length > 15_000_000) throw new Error("xlsx too large");
  return buf;
}
