/**
 * Guard-composition invariants (plan review asks 1+2, banked as tests):
 *  1. The manifest's serialized taxonomy leaves ≡ getValidLeafSet() over the
 *     same ReportCategory rows — including a malformed invalid-section row,
 *     which BOTH must drop (single filtered merge).
 *  2. No consumer is left on the base-only check: category-validation sites
 *     must not call bare isTaxonomyLeaf (sole exception: the create route's
 *     base-leaf-collision guard), and the UI/report consumers must not render
 *     the category list from the static base constants.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: {
    reportCategory: { findMany: vi.fn() },
    statementFile: { findMany: vi.fn(async () => []) },
    merchantMapping: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/agentRuntimeAuth", () => ({
  authorizeAgentJobRequest: vi.fn(async () => ({ job: { status: "processing" } })),
  appBaseUrl: () => "https://plusim.xyz",
}));
vi.mock("@/lib/appSettings", () => ({ getSetting: vi.fn(async () => "") }));

import { db } from "@/lib/db";
import { getValidLeafSet } from "@/lib/reportCategories";
import { GET as manifestGET } from "@/app/api/agent/jobs/[jobId]/manifest/route";

const categories = db.reportCategory.findMany as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("manifest and verification share ONE valid set", () => {
  it("equal leaf sets over the same rows, invalid-section row dropped from BOTH (test_manifest_and_verification_share_valid_set)", async () => {
    const rows = [
      { name: "קטגוריה חדשה", section: "שונות" },
      { name: "יתום", section: "__nonexistent__" }, // malformed row — must not split the sets
    ];
    categories.mockResolvedValue(rows);

    const res = await manifestGET(
      new NextRequest("https://plusim.xyz/api/agent/jobs/jobA/manifest?t=tok"),
      { params: Promise.resolve({ jobId: "jobA" }) },
    );
    const manifest = await res.json();
    const manifestLeaves = new Set<string>(
      (manifest.taxonomy as { leaves: string[] }[]).flatMap((s) => s.leaves),
    );

    const verifierLeaves = await getValidLeafSet();
    expect(manifestLeaves).toEqual(verifierLeaves);
    expect(manifestLeaves.has("קטגוריה חדשה")).toBe(true);
    expect(manifestLeaves.has("יתום")).toBe(false);
    expect(verifierLeaves.has("יתום")).toBe(false);
  });
});

describe("no consumer left on the base-only check (test_no_consumer_left_on_base_only_check)", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

  it("validation sites use validLeaves/getValidLeafSet, never bare isTaxonomyLeaf", () => {
    // sites 1–2: the pure verifier takes the set as a required arg
    const verifier = src("lib/reportResult.ts");
    expect(verifier).not.toMatch(/isTaxonomyLeaf/);
    expect(verifier).toMatch(/validLeaves: Set<string>\)/); // required — no "= " default
    expect(verifier).not.toMatch(/validLeaves: Set<string> =/);
    // sites 3–4: admin validation routes query the merged set
    for (const p of [
      "app/admin/api/reports/[jobId]/transactions/[txId]/route.ts",
      "app/admin/api/report-mappings/[id]/route.ts",
    ]) {
      const code = src(p);
      expect(code).not.toMatch(/isTaxonomyLeaf/);
      expect(code).toMatch(/getValidLeafSet/);
    }
    // site 5: the manifest serializes the merged taxonomy
    const manifest = src("app/api/agent/jobs/[jobId]/manifest/route.ts");
    expect(manifest).toMatch(/getMergedTaxonomy/);
    expect(manifest).not.toMatch(/taxonomy: REPORT_TAXONOMY/);
    // the result route passes the merged set to parse AND verify
    const result = src("app/api/agent/jobs/[jobId]/result/route.ts");
    expect(result).toMatch(/getValidLeafSet/);
    expect(result).toMatch(/parseAgentResult\(body, validLeaves\)/);
    expect(result).toMatch(/verifyAgentResult\(result, validLeaves, taxonomy\)/);
    expect(result).toMatch(/getMergedTaxonomy/);
  });

  it("UI/report consumers render categories from the merged source, not the base constants", () => {
    // site 6: the picker's options come from the job-detail GET's categoryLeaves
    const picker = src("components/admin/ReportJobDetail.tsx");
    expect(picker).not.toMatch(/TAXONOMY_LEAVES|REPORT_TAXONOMY/);
    expect(picker).toMatch(/categoryLeaves/);
    // site 7: /report iterates the merged taxonomy
    const report = src("app/report/page.tsx");
    expect(report).not.toMatch(/REPORT_TAXONOMY|TAXONOMY_LEAVES/);
    expect(report).toMatch(/getMergedTaxonomy/);
  });

  it("income section is last, and disjoint from expenses and the distribution exclusions", async () => {
    const { REPORT_TAXONOMY, INCOME_SECTION, isIncomeLeaf, leafAllowedForKind } = await import("@/config/reportTaxonomy");
    const { DISTRIBUTION_EXCLUDED_LEAVES } = await import("@/lib/reportAnalysis");
    expect(REPORT_TAXONOMY[REPORT_TAXONOMY.length - 1].section).toBe(INCOME_SECTION);
    const income = REPORT_TAXONOMY.find((s) => s.section === INCOME_SECTION)!.leaves;
    const expenses = REPORT_TAXONOMY.filter((s) => s.section !== INCOME_SECTION).flatMap((s) => s.leaves);
    for (const leaf of income) {
      expect(expenses).not.toContain(leaf);
      expect(DISTRIBUTION_EXCLUDED_LEAVES).not.toContain(leaf);
      expect(isIncomeLeaf(leaf, REPORT_TAXONOMY)).toBe(true);
      expect(leafAllowedForKind("income", leaf, REPORT_TAXONOMY)).toBe(true);
      expect(leafAllowedForKind("expense", leaf, REPORT_TAXONOMY)).toBe(false);
      expect(leafAllowedForKind("credit", leaf, REPORT_TAXONOMY)).toBe(true);
    }
    expect(leafAllowedForKind("income", "חשמל", REPORT_TAXONOMY)).toBe(false);
    expect(leafAllowedForKind("expense", "חשמל", REPORT_TAXONOMY)).toBe(true);
    // an admin-added income leaf is income too — only via the MERGED taxonomy
    const { mergeTaxonomy } = await import("@/config/reportTaxonomy");
    const merged = mergeTaxonomy(REPORT_TAXONOMY, [{ name: "מלגה", section: INCOME_SECTION }]);
    expect(isIncomeLeaf("מלגה", merged)).toBe(true);
    expect(isIncomeLeaf("מלגה", REPORT_TAXONOMY)).toBe(false);
  });

  it("the ONLY runtime isTaxonomyLeaf call is the create route's base-leaf-collision guard", () => {
    const create = src("app/admin/api/report-categories/route.ts");
    expect(create).toMatch(/isTaxonomyLeaf\(name\)/);
  });
});
