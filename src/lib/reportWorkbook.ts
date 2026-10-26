/**
 * App-side workbook rebuild (docs/plans/report-adjust-chat.md B7, B7a).
 *
 * After a chat adjustment the Excel is rebuilt by the APP from its own rows —
 * the agent never supplies workbook bytes (Codex P1). Ordering is by revision:
 * every applied adjust bumps ReportJob.rowsRevision in the same transaction as
 * its row writes; a rebuild reads a consistent (revision, rows) snapshot and
 * stores its artifact only if that revision is still current AND newer than the
 * stored one — so rebuilds finishing in any order can never leave an older
 * workbook in place (Codex P1, Rev 3).
 */
import { db } from "@/lib/db";
import { getMergedTaxonomy } from "@/lib/reportCategories";
import { ADJUSTABLE } from "@/lib/reportEdits";
import { runWorkbookBuilder } from "@/lib/workbookBuilder";

export type RebuildResult = "updated" | "superseded" | "failed";

const SNAPSHOT_ATTEMPTS = 3;

interface RowForWorkbook {
  month: string;
  date: string;
  merchant: string;
  amountAgorot: number;
  category: string | null;
  uncategorized: boolean;
  sourceLabel: string;
  note: string | null;
  kind: string;
}

/** The dict build_workbook takes — the same fields run_job.py finalize passes. */
export function toWorkbookTxn(r: RowForWorkbook): Record<string, unknown> {
  return {
    month: r.month,
    date: r.date,
    merchant: r.merchant,
    amountAgorot: r.amountAgorot,
    category: r.category,
    uncategorized: r.uncategorized,
    sourceLabel: r.sourceLabel,
    note: r.note ?? "",
    kind: r.kind,
  };
}

const ROW_SELECT = {
  month: true,
  date: true,
  merchant: true,
  amountAgorot: true,
  category: true,
  uncategorized: true,
  sourceLabel: true,
  note: true,
  kind: true,
} as const;

/** A (revision, rows) pair read with no adjust committing in between, or null. */
async function readSnapshot(jobId: string): Promise<{ revision: number; rows: RowForWorkbook[] } | null> {
  for (let i = 0; i < SNAPSHOT_ATTEMPTS; i++) {
    const before = await db.reportJob.findUnique({ where: { id: jobId }, select: { rowsRevision: true } });
    if (!before) return null;
    const rows = await db.reportTransaction.findMany({
      where: { jobId },
      select: ROW_SELECT,
      orderBy: [{ month: "asc" }, { date: "asc" }, { id: "asc" }],
    });
    const after = await db.reportJob.findUnique({ where: { id: jobId }, select: { rowsRevision: true } });
    if (after && after.rowsRevision === before.rowsRevision) return { revision: before.rowsRevision, rows };
  }
  return null;
}

/** Rebuild the job's workbook from its current rows and store it if still current. */
export async function rebuildReportWorkbook(jobId: string, generation: Date): Promise<RebuildResult> {
  try {
    const snap = await readSnapshot(jobId);
    if (!snap) {
      console.error(`[workbook] job=${jobId} rebuild failed: no stable snapshot`);
      return "failed";
    }
    const bytes = await runWorkbookBuilder({
      taxonomy: await getMergedTaxonomy(),
      txns: snap.rows.map(toWorkbookTxn),
    });
    const existing = await db.reportArtifact.findFirst({ where: { jobId }, select: { filename: true } });
    const filename = existing?.filename ?? `plusim-report-${jobId}.xlsx`;

    const stored = await db.$transaction(async (tx) => {
      const claim = await tx.reportJob.updateMany({
        where: {
          id: jobId,
          status: { in: ADJUSTABLE },
          dispatchedAt: generation,
          rowsRevision: snap.revision,
          artifactRevision: { lt: snap.revision },
        },
        data: { artifactRevision: snap.revision },
      });
      if (claim.count === 0) return false;
      await tx.reportArtifact.deleteMany({ where: { jobId } });
      await tx.reportArtifact.create({ data: { jobId, filename, bytes } });
      return true;
    });
    console.log(`[workbook] job=${jobId} revision=${snap.revision} ${stored ? "updated" : "superseded"}`);
    return stored ? "updated" : "superseded";
  } catch (e) {
    console.error(`[workbook] job=${jobId} rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

/**
 * Make sure the stored workbook reflects the rows before it is shipped
 * (publish, client download). A never-adjusted job (revisions equal) costs one
 * read and no rebuild. Returns whether the artifact is fresh afterwards.
 */
export async function ensureFreshWorkbook(jobId: string): Promise<boolean> {
  const job = await db.reportJob.findUnique({
    where: { id: jobId },
    select: { rowsRevision: true, artifactRevision: true, dispatchedAt: true },
  });
  if (!job) return false;
  if (job.artifactRevision >= job.rowsRevision) return true;
  if (!job.dispatchedAt) return false;
  const res = await rebuildReportWorkbook(jobId, job.dispatchedAt);
  if (res === "updated") return true;
  // "superseded": a newer rebuild may have stored a fresh one — re-check.
  const now = await db.reportJob.findUnique({
    where: { id: jobId },
    select: { rowsRevision: true, artifactRevision: true },
  });
  return !!now && now.artifactRevision >= now.rowsRevision;
}
