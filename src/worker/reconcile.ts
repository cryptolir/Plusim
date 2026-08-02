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

/**
 * A callback that AUTHORIZED just before expiry may still be mid-request when
 * the token lapses — authorization is checked at entry, the conditional write
 * happens later. Sweep only tokens expired by more than this margin so an
 * in-flight callback can never be failed out from under its own transaction
 * (Codex round 2 F25, round 3 refinement).
 *
 * What actually bounds the auth→write window (NOT the route's `maxDuration`,
 * which self-hosted `next start` does not enforce): Node's HTTP server kills a
 * stalled request at `requestTimeout` (default 300 s), the verification step is
 * synchronous in-process CPU, and the Prisma interactive transaction aborts at
 * its default 5 s timeout. Worst case ≈ 5 minutes; the margin is ~3×. And the
 * only exposed callbacks at all are ones authorizing in the last instant of a
 * 24-hour-old run — a rejected callback there converges by rerun, the plan's
 * accepted residual class.
 */
export const SWEEP_GRACE_MS = 15 * 60_000;

export async function reconcileExpiredProcessing(now: Date = new Date()): Promise<number> {
  const res = await db.reportJob.updateMany({
    // `lt` never matches NULL expiries, so rows without a minted token
    // (e.g. `dispatched`, or legacy rows) are untouched by construction.
    where: {
      status: "processing",
      agentTokenExpiresAt: { lt: new Date(now.getTime() - SWEEP_GRACE_MS) },
    },
    data: { status: "failed", error: "ההרצה לא הסתיימה לפני שפג תוקף ההרשאה — יש להריץ מחדש" },
  });
  if (res.count > 0) {
    console.warn(`[worker] reconciled ${res.count} expired-token processing job(s) to failed`);
  }
  return res.count;
}
