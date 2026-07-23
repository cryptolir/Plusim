/**
 * Publish a completed report to its target user, exporting the xlsx artifact
 * to Google Sheets in the user's assigned Drive folder.
 *
 * Publishing is what makes a report client-visible, so it asserts — twice, at
 * the pre-check AND inside the write — that the thing it publishes is the
 * result it verified:
 *
 *  - fatal verification diagnostics ⇒ never (existing rule);
 *  - RESULT FRESHNESS: `completedAt >= dispatchedAt`. A rejected callback writes
 *    status/error and deliberately leaves completedAt alone (api/agent/jobs/
 *    [jobId]/result), so after a failed re-run the job sits at needs_review
 *    holding the PREVIOUS run's artifact — publishing it would ship a report
 *    missing exactly the statements the admin just appended;
 *  - FILE COVERAGE: no StatementFile with `createdAt >= dispatchedAt`, i.e. no
 *    file the last run cannot be proven to have seen. `>=`, not `>`: both are
 *    TIMESTAMP(3), and a same-millisecond tie must fail closed (one visible
 *    re-run) rather than pass as covered;
 *  - the final write is a CONDITIONAL updateMany pinning status + both
 *    watermarks + the file set, so a run or callback landing between the
 *    pre-check and the write can never be published unverified (0 rows ⇒ 409).
 *
 * Sheet export stays best-effort — it never blocks publish — but a re-publish
 * must not leave the client on a link to the OLD workbook: the existing sheet is
 * updated in place when it is still contained, a fallback creates a fresh one
 * (trashing the stale one), and if BOTH fail the stale `sheetUrl` is cleared.
 */
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import {
  isDriveConnected,
  assertEntryUnderRoot,
  assertEntryUnderFolder,
  uploadXlsxAsSpreadsheet,
  updateXlsxSpreadsheet,
  trashFile,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PUBLISHABLE = ["completed", "needs_review", "published"];

function sheetIdFromUrl(url: string): string | null {
  return /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(url)?.[1] ?? null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId } = await ctx.params;
  // ONE consistent snapshot of the job AND the artifact it will export, so every
  // guard below and the Drive write all refer to the SAME state. Reading the
  // artifact separately at export time would let a callback landing mid-publish
  // push an unreviewed (or fatal) workbook into the client's bookmarked Sheet —
  // which the conditional write below cannot undo, because Drive is not part of
  // that transaction.
  //
  // REPEATABLE READ is load-bearing, not decoration: Postgres defaults to READ
  // COMMITTED, where every statement takes its OWN snapshot, so a plain batch
  // could still read the job from before a result callback and the artifact from
  // after it. The result callback writes job + transactions + artifact in one
  // transaction, so under a transaction-wide snapshot this read sees all of a
  // run or none of it.
  const [job, artifact] = await db.$transaction(
    [
      db.reportJob.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          status: true,
          targetUserId: true,
          title: true,
          sheetUrl: true,
          verification: true,
          dispatchedAt: true,
          completedAt: true,
        },
      }),
      db.reportArtifact.findFirst({ where: { jobId }, orderBy: { createdAt: "desc" } }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!PUBLISHABLE.includes(job.status)) {
    return NextResponse.json({ error: `cannot publish a ${job.status} job` }, { status: 409 });
  }
  // Never publish a job with FATAL verification diagnostics — a total mismatch,
  // duplicate dedupKey, date-outside-month, unknown category, or non-xlsx payload
  // (Rev 4 — Codex P1). A merely-uncategorized (non-fatal) job may publish.
  const fatal =
    job.verification !== null &&
    typeof job.verification === "object" &&
    !Array.isArray(job.verification) &&
    (job.verification as { fatal?: unknown }).fatal === true;
  if (fatal) {
    return NextResponse.json(
      { error: "cannot publish — the report has fatal verification diagnostics; re-run the job" },
      { status: 409 },
    );
  }
  // Result freshness: the stored artifact must come from the newest run.
  if (!job.completedAt || (job.dispatchedAt && job.completedAt < job.dispatchedAt)) {
    return NextResponse.json(
      { error: "the latest run has not produced a result — re-run the agent before publishing" },
      { status: 409 },
    );
  }
  // File coverage: nothing appended at-or-after the last dispatch.
  if (job.dispatchedAt) {
    const unprocessed = await db.statementFile.count({
      where: { jobId, createdAt: { gte: job.dispatchedAt } },
    });
    if (unprocessed > 0) {
      return NextResponse.json(
        { error: `${unprocessed} statement file(s) were added after the last run — re-run the agent before publishing` },
        { status: 409 },
      );
    }
  }

  const remainingUncat = await db.reportTransaction.count({
    where: { jobId, uncategorized: true },
  });

  // Sheets export (best-effort). Skipped when Drive is not connected or the user
  // has no assigned folder; a re-publish refreshes the EXISTING sheet so the
  // client's bookmarked link stays valid and current.
  let sheetUrl = job.sheetUrl;
  let exportNote: string | null = null;
  // Set ONLY when the previous sheet passed folder containment. A sheet that
  // failed containment may sit in another client's folder — it is not ours to
  // write to, and trashing is a write. Cleanup happens after the publish
  // commits, so a raced publish never trashes a sheet that stays in use.
  let containedExistingId: string | null = null;
  // True only once THIS publish has put the current workbook in Drive (updated
  // in place or created anew). Every other outcome — an exception, or any of the
  // skip paths (no Drive, no folder, no artifact) — leaves it false.
  let exportedCurrent = false;
  try {
    if (!(await isDriveConnected())) {
      exportNote = "Drive not connected — sheet export skipped";
    } else {
      const folder = await db.userDriveFolder.findUnique({ where: { userId: job.targetUserId } });
      if (!folder) {
        exportNote = "user has no assigned Drive folder — sheet export skipped";
      } else if (!artifact) {
        exportNote = "no xlsx artifact to export";
      } else {
        // BOTH containments, before ANY write. assertEntryUnderFolder proves the
        // sheet belongs to THIS client but walks only as far as folderId — it
        // never consults the root — so the assigned folder itself must be
        // re-contained too, exactly as the upload path does at write time.
        await assertEntryUnderRoot(folder.folderId);
        const xlsx = Buffer.from(artifact.bytes);
        const existingId = sheetUrl ? sheetIdFromUrl(sheetUrl) : null;

        let updatedInPlace = false;
        if (existingId) {
          try {
            await assertEntryUnderFolder(existingId, folder.folderId);
            // Contained: this id is now a legitimate write target, so it may
            // also be trashed if the update fails and we create a replacement.
            containedExistingId = existingId;
            await updateXlsxSpreadsheet({ fileId: existingId, xlsx });
            updatedInPlace = true;
            exportedCurrent = true;
          } catch (e) {
            console.warn(
              `[admin/reports] job=${jobId} in-place sheet update failed, creating a new sheet: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }

        if (!updatedInPlace) {
          const entry = await uploadXlsxAsSpreadsheet({
            parentFolderId: folder.folderId,
            name: job.title || artifact.filename.replace(/\.xlsx$/i, ""),
            xlsx,
            appProperties: { plusimReport: "true", plusimJobId: jobId },
          });
          sheetUrl = `https://docs.google.com/spreadsheets/d/${entry.id}/edit`;
          exportedCurrent = true;
        }
      }
    }
  } catch (e) {
    exportNote = `sheet export failed: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[admin/reports] job=${jobId} ${exportNote}`);
  }

  // ONE post-condition covering every way this publish failed to produce a
  // current workbook — a thrown export AND each skip path. The client must never
  // be handed a link to the previous workbook beside freshly published tables;
  // no link is the honest state, and the next successful publish restores one.
  if (!exportedCurrent && job.sheetUrl) {
    sheetUrl = null;
    exportNote = `${exportNote ?? "no current workbook was exported"} — stale sheet link cleared`;
  }

  // Conditional publish: re-assert everything the pre-check validated. Both
  // watermarks are the values READ ABOVE (Prisma cannot compare two columns of
  // one row), so any run or callback that landed meanwhile fails the match.
  const upd = await db.reportJob.updateMany({
    where: {
      id: jobId,
      status: { in: PUBLISHABLE },
      dispatchedAt: job.dispatchedAt,
      completedAt: job.completedAt,
      ...(job.dispatchedAt ? { files: { none: { createdAt: { gte: job.dispatchedAt } } } } : {}),
    },
    data: {
      status: "published",
      publishedAt: new Date(),
      sheetUrl,
      // Published jobs must not accept late agent callbacks.
      agentTokenHash: null,
      agentTokenExpiresAt: null,
    },
  });
  if (upd.count === 0) {
    console.warn(`[admin/reports] job=${jobId} publish raced a run/append — nothing published`);
    return NextResponse.json(
      { error: "the job changed while publishing (a run or an upload landed) — re-check it and publish again" },
      { status: 409 },
    );
  }

  // The publish committed and sheetUrl now points at the replacement, so the old
  // sheet is genuinely superseded — otherwise it would sit beside the new one
  // showing stale numbers. Only ever a contained id, only after the commit, and
  // strictly best-effort (trash is recoverable).
  if (containedExistingId && sheetUrl && !sheetUrl.includes(containedExistingId)) {
    try {
      await trashFile(containedExistingId);
    } catch (e) {
      console.warn(
        `[admin/reports] job=${jobId} could not trash the superseded sheet ${containedExistingId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  console.log(
    `[admin/reports] job=${jobId} published by=${auth.actor} uncatLeft=${remainingUncat} sheet=${sheetUrl ? "yes" : "no"}`,
  );
  return NextResponse.json({ ok: true, sheetUrl, remainingUncategorized: remainingUncat, exportNote });
}
