/**
 * Provably-safe reconciliation of dead `processing` rows (Codex round 1, F23).
 *
 * A `processing` row whose per-job token has EXPIRED can never complete:
 * authorizeAgentJobRequest rejects an expired token before the result route
 * writes a byte, so no callback — however late — can move the row. Failing it
 * is therefore race-free, unlike a wall-clock janitor (which the plan rejected
 * because it cannot distinguish a stalled run from a live one). This is the
 * backstop for the residuals that would otherwise strand `processing` forever
 * now that the run route refuses `processing` rows:
 *   - a DB outage long enough to exhaust the dead-letter queue's retries;
 *   - an agent run that was accepted but never called back (24 h token TTL).
 */
import { db } from "@/lib/db";

export async function reconcileExpiredProcessing(now: Date = new Date()): Promise<number> {
  const res = await db.reportJob.updateMany({
    // `lt` never matches NULL expiries, so rows without a minted token
    // (e.g. `dispatched`, or legacy rows) are untouched by construction.
    where: { status: "processing", agentTokenExpiresAt: { lt: now } },
    data: { status: "failed", error: "run never completed before its token expired" },
  });
  if (res.count > 0) {
    console.warn(`[worker] reconciled ${res.count} expired-token processing job(s) to failed`);
  }
  return res.count;
}
