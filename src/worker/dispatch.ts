/**
 * report-dispatch queue handlers (docs/plans/reports-scaling-stage1-2.md §4).
 *
 * The claim is a dispatched-arm CAS, then an ownership read (Rev 5, F14) — one
 * OR'd updateMany cannot apply different data per arm, and writing a fresh
 * token on the retry arm would rotate a possibly-live run's token (F9).
 *
 * `dispatchAttemptedAt` is written immediately before callAgent and splits a
 * retry of our own claim into:
 *   marker null → the crash happened before any send; AgentGlob never saw a
 *     request. The raw token died with the old process (only its hash is
 *     persisted), so re-mint under a marker-null CAS (F15), then mark and send.
 *   marker set → AMBIGUOUS — the run may be live. Never re-send, never touch
 *     the token, and never complete the entry as success: THROW, so the entry
 *     exhausts to the dead-letter queue on a delay, whose reconciliation no-ops
 *     if the callback landed in the meantime (F16).
 *
 * One dispatch generation never produces two agent runs (invariant I1).
 */
import { db } from "@/lib/db";
import { mintJobToken, appBaseUrl } from "@/lib/agentRuntimeAuth";
import { callAgent } from "@/lib/agentglob";
import type { ReportDispatchPayload } from "@/lib/reportQueue";

/** Same semantics as the old route hold: timeout leaves `processing` for the callback. */
export const DISPATCH_TIMEOUT_MS = 300_000;

/** The slice of a pg-boss JobWithMetadata the handler needs (tests fake this). */
export interface DispatchQueueEntry {
  id: string;
  data: ReportDispatchPayload;
  retryCount: number;
  retryLimit: number;
}

export async function handleReportDispatch(entry: DispatchQueueEntry): Promise<void> {
  const { jobId } = entry.data;
  const gen = new Date(entry.data.gen);

  // Initial claim CAS. Minting BEFORE the CAS keeps it one write: the token is
  // minted once per dispatch generation and never rotated by a retry (F9). The
  // dispatchedAt match stops a duplicate entry from an OLDER generation from
  // claiming a newer dispatched row (F17).
  const fresh = mintJobToken();
  const claimed = await db.reportJob.updateMany({
    where: { id: jobId, status: "dispatched", dispatchedAt: gen },
    data: {
      status: "processing",
      queueJobId: entry.id,
      agentTokenHash: fresh.tokenHash,
      agentTokenExpiresAt: fresh.expiresAt,
      dispatchAttemptedAt: null,
    },
  });

  let token: string;
  if (claimed.count === 1) {
    token = fresh.token;
  } else {
    // Ownership read — safe to branch on a read: only this entry's serial
    // retries, the callback, or the DLQ handler can touch a row we own.
    const row = await db.reportJob.findUnique({
      where: { id: jobId },
      select: { status: true, queueJobId: true, dispatchAttemptedAt: true },
    });
    if (!row || row.status !== "processing" || row.queueJobId !== entry.id) {
      // Duplicate entry, another claimant, or state moved (e.g. published after
      // enqueue — invariant I2). Fail closed: never a default dispatch (I3).
      console.warn(
        `[worker] job=${jobId} entry=${entry.id} skipping — not dispatchable and not ours ` +
          `(status=${row?.status ?? "gone"} owner=${row?.queueJobId ?? "none"})`,
      );
      return;
    }
    if (row.dispatchAttemptedAt !== null) {
      // Ambiguous prior attempt — see the module comment. Throw, never complete.
      throw new Error(
        `job ${jobId}: prior attempt may have reached the agent — not re-sending; ` +
          `dead-letter reconciliation will settle it if the callback never lands`,
      );
    }
    // Our own retry, never sent — re-mint under a marker-null CAS (F15).
    const reminted = mintJobToken();
    const remint = await db.reportJob.updateMany({
      where: { id: jobId, status: "processing", queueJobId: entry.id, dispatchAttemptedAt: null },
      data: { agentTokenHash: reminted.tokenHash, agentTokenExpiresAt: reminted.expiresAt },
    });
    if (remint.count === 0) {
      console.warn(`[worker] job=${jobId} entry=${entry.id} skipping — row moved during retry re-mint`);
      return;
    }
    token = reminted.token;
  }

  // The send marker precedes every send — that ordering is what makes a null
  // marker PROOF that no run exists (F9). Ownership-conditioned like every write.
  const marked = await db.reportJob.updateMany({
    where: { id: jobId, status: "processing", queueJobId: entry.id },
    data: { dispatchAttemptedAt: new Date() },
  });
  if (marked.count === 0) {
    console.warn(`[worker] job=${jobId} entry=${entry.id} skipping — row moved before send marker`);
    return;
  }

  const manifestUrl = `${appBaseUrl()}/api/agent/jobs/${jobId}/manifest?t=${encodeURIComponent(token)}`;
  const message = `PLUSIM_REPORT_JOB v1\njob: ${jobId}\nmanifest: ${manifestUrl}`;
  console.log(`[worker] dispatching job=${jobId} entry=${entry.id} attempt=${entry.retryCount}`);
  try {
    const { reply } = await callAgent({
      sessionKey: `app:plusim:report-job:${jobId}`,
      message,
      timeoutMs: DISPATCH_TIMEOUT_MS,
    });
    console.log(`[worker] job=${jobId} agent replied: ${reply.slice(0, 200)}`);
    // The callback (not this reply) is authoritative — leave `processing` alone.
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort|timeout/i.test(msg)) {
      // Run continues server-side; the callback will complete the job.
      console.warn(`[worker] job=${jobId} dispatch wait timed out; awaiting callback`);
      return;
    }
    console.error(`[worker] job=${jobId} dispatch failed (attempt=${entry.retryCount}): ${msg}`);
    if (entry.retryCount >= entry.retryLimit) {
      // Final attempt only (F3) — earlier attempts rethrow untouched and the
      // marker-set branch above decides whether the retry may re-send.
      await db.reportJob.updateMany({
        where: { id: jobId, status: "processing", queueJobId: entry.id },
        data: { status: "failed", error: `dispatch failed: ${msg.slice(0, 500)}` },
      });
    }
    throw e instanceof Error ? e : new Error(msg);
  }
}

/**
 * Dead-letter reconciliation (F10): a final-attempt crash or expiration would
 * otherwise strand `processing` forever — unreachable by the run route and
 * invisible to the callback. Keys on the GENERATION (the dead-letter entry has
 * a NEW pg-boss id; only the payload survives — F17), so it inherently no-ops
 * when the callback already moved the row out of `processing` (F16).
 */
export async function handleReportDispatchDead(payload: ReportDispatchPayload): Promise<void> {
  const res = await db.reportJob.updateMany({
    where: { id: payload.jobId, status: "processing", dispatchedAt: new Date(payload.gen) },
    data: { status: "failed", error: "worker crashed or expired" },
  });
  if (res.count === 1) {
    console.warn(`[worker] job=${payload.jobId} gen=${payload.gen} dead-lettered — reconciled to failed`);
  } else {
    console.log(`[worker] job=${payload.jobId} gen=${payload.gen} dead-letter no-op (row moved on)`);
  }
}
