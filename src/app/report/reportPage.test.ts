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
  jobs.mockResolvedValue([
    {
      id: "jobA",
      title: "דוח יוני",
      sheetUrl: null,
      publishedAt: new Date("2026-07-01T00:00:00Z"),
      artifacts: [],
      transactions: [
        { month: "2026-06", merchant: "חנות חדשה", date: "2026-06-14", amountAgorot: 1579, category: DB_LEAF, uncategorized: false },
      ],
    },
  ]);
});

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
