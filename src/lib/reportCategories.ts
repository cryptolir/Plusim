/**
 * DB-backed taxonomy accessors — the ONLY place ReportCategory rows are read.
 * The pure merge lives in src/config/reportTaxonomy.ts; these thin wrappers
 * feed the merged taxonomy / valid-leaf set to every consumer (agent manifest,
 * result verification, admin validation routes, the assign picker, /report).
 */
import { db } from "@/lib/db";
import {
  REPORT_TAXONOMY,
  mergeTaxonomy,
  mergedLeafSet,
  type ExtraCategory,
  type TaxonomySection,
} from "@/config/reportTaxonomy";

/** All admin-added categories, oldest first (stable leaf order everywhere). */
export async function listExtraCategories(): Promise<ExtraCategory[]> {
  return db.reportCategory.findMany({
    orderBy: { createdAt: "asc" },
    select: { name: true, section: true },
  });
}

/** Base ∪ DB taxonomy — what the manifest serializes and the UIs render. */
export async function getMergedTaxonomy(): Promise<TaxonomySection[]> {
  return mergeTaxonomy(REPORT_TAXONOMY, await listExtraCategories());
}

/** The full valid-leaf set — what verification and admin validation accept. */
export async function getValidLeafSet(): Promise<Set<string>> {
  return mergedLeafSet(await listExtraCategories());
}
