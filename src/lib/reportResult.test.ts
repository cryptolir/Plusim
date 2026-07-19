import { describe, it, expect } from "vitest";
import { parseAgentResult, verifyAgentResult, decodeXlsx, type AgentResult } from "./reportResult";

const FOOD = "מזון ומכולת";
const FUEL = "דלק";

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
    const v = verifyAgentResult(result());
    expect(v.fatal).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.problems).toHaveLength(0);
  });

  it("uncategorized rows ALONE are not fatal (reviewable, publishable)", () => {
    const v = verifyAgentResult(
      result({
        transactions: [tx({ category: null, uncategorized: true, merchant: "קניון עזריאלי" })],
      }),
    );
    expect(v.fatal).toBe(false);
    expect(v.uncategorizedCount).toBe(1);
  });

  it("per-source total mismatch → fatal", () => {
    const r = result();
    r.sourceTotals[0].statementTotalAgorot = 9999; // != recomputed 1579
    const v = verifyAgentResult(r);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/recomputed .* ≠ statement/);
  });

  it("unknown category → fatal", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ category: "not-a-real-leaf" })] }));
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/unknown category/);
  });

  it("date outside its month → fatal", () => {
    const v = verifyAgentResult(result({ transactions: [tx({ date: "2026-07-02" })] }));
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/outside its month/);
  });

  it("duplicate dedupKey → fatal", () => {
    const v = verifyAgentResult(
      result({
        transactions: [
          tx({ dedupKey: "dup", amountAgorot: 1000 }),
          tx({ dedupKey: "dup", amountAgorot: 579, merchant: "אושר עד" }),
        ],
      }),
    );
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/duplicate dedupKey/);
  });

  it("a source with transactions but no reported total → fatal", () => {
    const r = result({
      transactions: [tx(), tx({ sourceLabel: "max", merchant: "פז", category: FUEL, dedupKey: "v-2" })],
    });
    // sourceTotals only covers isracard-4962; "max" is orphaned.
    const v = verifyAgentResult(r);
    expect(v.fatal).toBe(true);
    expect(v.problems.join(" ")).toMatch(/no reported statement total/);
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
    expect(() => parseAgentResult({ ...base, status: undefined })).toThrow(/status/);
  });
  it("rejects empty transactions", () => {
    expect(() => parseAgentResult({ ...base, transactions: [] })).toThrow(/empty/);
  });
  it("rejects a bad month", () => {
    expect(() => parseAgentResult({ ...base, transactions: [tx({ month: "2026-13" })] })).toThrow(/bad month/);
  });
  it("rejects a non-integer amount", () => {
    expect(() => parseAgentResult({ ...base, transactions: [tx({ amountAgorot: 12.5 })] })).toThrow(/bad amount/);
  });
  it("accepts a well-formed body", () => {
    const r = parseAgentResult(base);
    expect(r.transactions).toHaveLength(1);
    expect(r.status).toBe("ok");
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
