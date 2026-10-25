/**
 * /report renders DB categories (plan Rev 2, Codex round-1): a published
 * transaction categorized under an admin-added leaf must appear in the page's
 * section rows — with a base-only static taxonomy the by-leaf bucketing would
 * silently drop it. The async server component is invoked as a function and
 * its element tree searched (no DOM needed).
 */
import { it, expect, vi, beforeEach } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "user-1" })) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findMany: vi.fn() },
    reportCategory: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import ReportPage from "./page";

const jobs = db.reportJob.findMany as unknown as ReturnType<typeof vi.fn>;
const categories = db.reportCategory.findMany as unknown as ReturnType<typeof vi.fn>;

const DB_LEAF = "קטגוריה חדשה";

/** Depth-first search of a React element tree for a string value. */
function treeContains(node: unknown, needle: string, seen = new Set<object>()): boolean {
  if (typeof node === "string") return node === needle;
  if (node === null || typeof node !== "object") return false;
  if (seen.has(node as object)) return false;
  seen.add(node as object);
  return Object.values(node as Record<string, unknown>).some((v) => treeContains(v, needle, seen));
}

beforeEach(() => {
  vi.clearAllMocks();
  categories.mockResolvedValue([{ name: DB_LEAF, section: "שונות" }]);
  jobs.mockResolvedValue([job()]);
});

type Txn = {
  id: string;
  month: string;
  merchant: string;
  date: string;
  amountAgorot: number;
  category: string | null;
  uncategorized: boolean;
  sourceLabel: string;
  note: string | null;
  kind: string;
};

function txn(over: Partial<Txn> = {}): Txn {
  return {
    id: "t1",
    month: "2026-06",
    merchant: "חנות חדשה",
    date: "2026-06-14",
    amountAgorot: 1579,
    category: DB_LEAF,
    uncategorized: false,
    sourceLabel: "isracard-4962",
    note: null,
    kind: "expense",
    ...over,
  };
}

function job(over: Record<string, unknown> = {}) {
  return {
    id: "jobA",
    title: "דוח יוני",
    sheetUrl: null,
    publishedAt: new Date("2026-07-01T00:00:00Z"),
    verification: null,
    artifacts: [],
    transactions: [txn()],
    settlements: [],
    ...over,
  };
}

const SETTLEMENT = {
  id: "s1",
  month: "2026-06",
  date: "2026-06-10",
  payee: "מקס איט פיננ-י",
  amountAgorot: 1579,
  sourceLabel: "hapoalim-1812",
  matchedCycle: null,
};
const NOTE = "1 חיובי כרטיס אשראי בסך ₪15.79 נמצאו בחשבון הבנק ללא מחזור חיוב תואם להתאמה — אינם נספרים כהוצאה";

it("a published DB-leaf transaction renders in the section rows (test_report_page_renders_db_category)", async () => {
  const tree = await ReportPage();
  expect(treeContains(tree, DB_LEAF)).toBe(true);
  expect(treeContains(tree, "שונות")).toBe(true); // placed under its section
});

it("without the ReportCategory row the leaf is dropped from the section rows (the failure the merge prevents)", async () => {
  categories.mockResolvedValue([]);
  const tree = await ReportPage();
  expect(treeContains(tree, DB_LEAF)).toBe(false);
});

// ── Bank statements (docs/plans/bank-statements.md C2) ────────────────────────

/** Depth-first search for an element whose props carry `data-testid`. */
function findTestId(node: unknown, id: string, seen = new Set<object>()): unknown {
  if (node === null || typeof node !== "object") return undefined;
  if (seen.has(node as object)) return undefined;
  seen.add(node as object);
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props && props["data-testid"] === id) return node;
  for (const v of Object.values(node as Record<string, unknown>)) {
    const hit = findTestId(v, id, seen);
    if (hit) return hit;
  }
  return undefined;
}

/** Render client/server components found in the tree one level, so their markup is searchable. */
function expand(node: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (node === null || typeof node !== "object" || depth > 60) return node;
  if (seen.has(node as object)) return node;
  seen.add(node as object);
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof el.type === "function" && el.props) {
    try {
      // Hooks-free components render synchronously; hook users are left as-is.
      const out = (el.type as (p: unknown) => unknown)(el.props);
      return expand(out, depth + 1, seen);
    } catch {
      return node;
    }
  }
  if (Array.isArray(node)) return node.map((n) => expand(n, depth + 1, seen));
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) copy[k] = expand(v, depth + 1, seen);
  return copy;
}

it("the settlement card renders only when the job has settlements", async () => {
  let tree = await ReportPage();
  expect(treeContains(tree, "התאמת חיובי אשראי לחשבון הבנק")).toBe(false);
  expect(findTestId(tree, "settlement-card")).toBeUndefined();

  jobs.mockResolvedValue([
    job({
      settlements: [SETTLEMENT],
      verification: {
        notes: [],
        perSource: [
          { label: "isracard-4962", statementTotalAgorot: 1579, chargeCycles: [{ chargeDate: "2026-06-10", amountAgorot: 1579 }] },
          { label: "hapoalim-1812", statementTotalAgorot: null },
        ],
      },
    }),
  ]);
  tree = await ReportPage();
  const card = findTestId(tree, "settlement-card") ?? (() => {
    // the card is a client component — locate its element by type name and props
    const found: unknown[] = [];
    const walk = (n: unknown, seen = new Set<object>()) => {
      if (n === null || typeof n !== "object" || seen.has(n as object)) return;
      seen.add(n as object);
      const el = n as { type?: { name?: string }; props?: Record<string, unknown> };
      if (el.type && typeof el.type === "function" && el.type.name === "SettlementMatchCard") found.push(el);
      for (const v of Object.values(n as Record<string, unknown>)) walk(v, seen);
    };
    walk(tree);
    return found[0];
  })();
  expect(card).toBeDefined();
  const props = (card as { props: Record<string, unknown> }).props;
  expect(props.jobId).toBe("jobA");
  expect(props.settlements).toEqual([SETTLEMENT]);
  // the suggestion is pre-computed server-side: same month, exact amount
  expect(props.suggestions).toEqual({ s1: "isracard-4962@2026-06-10" });
  expect((props.targets as { id: string }[]).map((t) => t.id)).toEqual(["isracard-4962@2026-06-10"]);
  expect(props.note).toBeNull();
});

it("with settlements but no charge cycles the card carries the no-cycles note verbatim", async () => {
  jobs.mockResolvedValue([
    job({
      settlements: [SETTLEMENT],
      verification: { notes: [NOTE], perSource: [{ label: "hapoalim-1812", statementTotalAgorot: null }] },
    }),
  ]);
  const tree = await ReportPage();
  const walk = (n: unknown, seen = new Set<object>()): Record<string, unknown> | undefined => {
    if (n === null || typeof n !== "object" || seen.has(n as object)) return undefined;
    seen.add(n as object);
    const el = n as { type?: { name?: string }; props?: Record<string, unknown> };
    if (el.type && typeof el.type === "function" && el.type.name === "SettlementMatchCard") return el.props;
    for (const v of Object.values(n as Record<string, unknown>)) {
      const hit = walk(v, seen);
      if (hit) return hit;
    }
    return undefined;
  };
  const props = walk(tree)!;
  expect(props.note).toBe(NOTE);
  expect(props.targets).toEqual([]);
  expect(props.suggestions).toEqual({});
});

it("the income table renders only when the job has income rows; מצבנו always does", async () => {
  let tree = expand(await ReportPage());
  expect(treeContains(tree, "סה\"כ הכנסות")).toBe(false);
  expect(findTestId(tree, "net-row")).toBeDefined();

  jobs.mockResolvedValue([
    job({
      transactions: [
        txn(),
        txn({ id: "t2", merchant: "מעסיק", amountAgorot: -1900000, category: "משכורת 1", sourceLabel: "hapoalim-1812", kind: "income" }),
      ],
    }),
  ]);
  tree = expand(await ReportPage());
  expect(treeContains(tree, "סה\"כ הכנסות")).toBe(true);
  expect(treeContains(tree, "משכורת 1")).toBe(true);
  // the income row never lands in the expense section rows
  expect(treeContains(tree, "הכנסות")).toBe(true);
  const expenseLeafCells = JSON.stringify(tree).match(/"pr-6"[^}]*"children":"משכורת 1"/g);
  expect(expenseLeafCells).toBeNull();
});

it("uncategorized bank credits are listed apart from uncategorized debits", async () => {
  jobs.mockResolvedValue([
    job({
      transactions: [
        txn({ id: "u1", category: null, uncategorized: true, merchant: "לא ידוע", amountAgorot: 700 }),
        txn({ id: "u2", category: null, uncategorized: true, merchant: "העברה", amountAgorot: -45000, kind: "credit", sourceLabel: "hapoalim-1812" }),
      ],
    }),
  ]);
  const tree = await ReportPage();
  expect(treeContains(tree, "ללא סיווג")).toBe(true);
  expect(treeContains(tree, "זיכויים ללא סיווג (הכנסה או החזר — טרם הוכרע)")).toBe(true);
});
