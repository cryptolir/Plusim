import { describe, it, expect } from "vitest";
import { parseAgentResult, verifyAgentResult, decodeXlsx, type AgentResult } from "./reportResult";
import { mergedLeafSet } from "@/config/reportTaxonomy";

const FOOD = "מזון ומכולת";
const FUEL = "דלק";
// The valid set is a REQUIRED argument — no default. Base-only for most cases;
// merged with a DB category where a test exercises admin-added leaves.
const BASE_LEAVES = mergedLeafSet([]);
const DB_LEAF = "קטגוריה חדשה";
const MERGED_LEAVES = mergedLeafSet([{ name: DB_LEAF, section: "שונות" }]);

// A single clean transaction + matching source total (agora-exact).
function tx(over: Partial<AgentResult["transactions"][number]> = {}) {
  return {
    month: "2026-06",
    date: "2026-06-14",
    merchant: "יוחננוף",
    amountAgorot: 1579,
    category: FOOD,
    uncategorized: false,
    sourceLabel: "isracard-4962",
    dedupKey: "v-1",
    ...over,
  };
}

function result(over: Partial<AgentResult> = {}): AgentResult {
  const transactions = over.transactions ?? [tx()];
  const computed = transactions
    .filter((t) => t.sourceLabel === "isracard-4962")
    .reduce((n, t) => n + t.amountAgorot, 0);
  return {
    status: "ok",
    transactions,
    sourceTotals: [
      { label: "isracard-4962", statementTotalAgorot: computed, computedTotalAgorot: computed },
    ],
    xlsxBase64: "",
    proposedMappings: [],
    ...over,
  };
}

describe("verifyAgentResult — fatal classification (fail closed)", () => {
  it("clean result is not fatal", () => {
    const v = verifyAgentResult(result(), BASE_LEAVES);
    expect(v.fatal).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.problems).toHaveLength(0);
  });

  it("uncategorized rows ALONE are not fatal (reviewable, publishable)", () => {
    const v = verifyAgentResult(
      result({
        transactions: [tx({ category: null, uncategorized: true, merchant: "קניון עזריאלי" })],
      }),
      BASE_LEAVES,
    );
    expect(v.fatal).toBe(false);
    expect(v.uncategorizedCount).toBe(1);
  });

  it("per-source total mismatch → fatal", () => {
    const r = result();
    r.sourceTotals[0].statementTotalAgorot = 9999; // != recomputed 1579
    const v = verifyAgentResult(r, BASE_LEAVES);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/הסכום המחושב .* ≠ הסכום בדף החשבון/);
  });

  it("unknown category → fatal", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ category: "not-a-real-leaf" })] }), BASE_LEAVES);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/קטגוריה לא מוכרת/);
  });

  it("DB category in the passed valid set → NOT fatal (test_verify_accepts_db_category_when_in_valid_set)", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ category: DB_LEAF })] }), MERGED_LEAVES);
    expect(v.fatal).toBe(false);
    expect(v.problems).toHaveLength(0);
  });

  it("leaf in neither base nor the passed set → fatal (test_verify_unknown_category_still_fatal)", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ category: "לא-קיימת" })] }), MERGED_LEAVES);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/קטגוריה לא מוכרת/);
  });

  it("the valid set is a required arg — inclusion decides, no hidden fallback (test_verify_requires_explicit_valid_set)", () => {
    // Same DB-leaf result: FATAL under base-only, clean under the merged set.
    const dbLeafResult = () => result({ transactions: [tx({ category: DB_LEAF })] });
    expect(verifyAgentResult(dbLeafResult(), BASE_LEAVES).fatal).toBe(true);
    expect(verifyAgentResult(dbLeafResult(), MERGED_LEAVES).fatal).toBe(false);
    // And omitting it entirely is a compile error, pinned at the type level:
    // @ts-expect-error validLeaves is required — no base-only default exists
    void (() => verifyAgentResult(dbLeafResult()));
    // @ts-expect-error validLeaves is required — no base-only default exists
    void (() => parseAgentResult({}));
  });

  it("date outside its month → fatal", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ date: "2026-07-02" })] }), BASE_LEAVES);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/אינו בחודש/);
  });

  it("duplicate dedupKey → fatal", () => {
    const v = verifyAgentResult(
      result({
        transactions: [
          tx({ dedupKey: "dup", amountAgorot: 1000 }),
          tx({ dedupKey: "dup", amountAgorot: 579, merchant: "אושר עד" }),
        ],
      }),
      BASE_LEAVES,
    );
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/עסקה כפולה/);
  });

  it("a source with transactions but no reported total → fatal", () => {
    const r = result({
      transactions: [tx(), tx({ sourceLabel: "max", merchant: "פז", category: FUEL, dedupKey: "v-2" })],
    });
    // sourceTotals only covers isracard-4962; "max" is orphaned.
    const v = verifyAgentResult(r, BASE_LEAVES);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/אין סכום מדווח בדף החשבון/);
  });
});

describe("parseAgentResult — structural fail-closed", () => {
  const base = {
    status: "ok",
    transactions: [tx()],
    sourceTotals: [{ label: "isracard-4962", statementTotalAgorot: 1579, computedTotalAgorot: 1579 }],
    xlsxBase64: "UEsDBAo=", // some non-empty string
  };

  it("rejects a missing status", () => {
    expect(() => parseAgentResult({ ...base, status: undefined }, BASE_LEAVES)).toThrow(/status/);
  });
  it("rejects empty transactions", () => {
    expect(() => parseAgentResult({ ...base, transactions: [] }, BASE_LEAVES)).toThrow(/empty/);
  });
  it("rejects a bad month", () => {
    expect(() => parseAgentResult({ ...base, transactions: [tx({ month: "2026-13" })] }, BASE_LEAVES)).toThrow(/bad month/);
  });
  it("rejects a non-integer amount", () => {
    expect(() => parseAgentResult({ ...base, transactions: [tx({ amountAgorot: 12.5 })] }, BASE_LEAVES)).toThrow(/bad amount/);
  });
  it("accepts a well-formed body", () => {
    const r = parseAgentResult(base, BASE_LEAVES);
    expect(r.transactions).toHaveLength(1);
    expect(r.status).toBe("ok");
  });
  it("keeps a DB-leaf proposed mapping only when the passed set contains it", () => {
    const withMapping = { ...base, proposedMappings: [{ merchant: "חנות חדשה", category: DB_LEAF }] };
    expect(parseAgentResult(withMapping, MERGED_LEAVES).proposedMappings).toHaveLength(1);
    expect(parseAgentResult(withMapping, BASE_LEAVES).proposedMappings).toHaveLength(0);
  });
});

describe("decodeXlsx — payload type (non-xlsx fails closed)", () => {
  it("rejects a non-zip payload", () => {
    const notZip = Buffer.from("this is a PDF or plain text, not a zip").toString("base64");
    expect(() => decodeXlsx(notZip)).toThrow(/not a valid zip/);
  });
  it("accepts a zip-magic payload", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]).toString("base64");
    expect(decodeXlsx(zip)).toBeInstanceOf(Buffer);
  });
});
