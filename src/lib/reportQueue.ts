/**
 * pg-boss queue for report dispatch (docs/plans/reports-scaling-stage1-2.md).
 *
 * The web app is SEND-ONLY: the run route enqueues here and returns 202; the
 * dedicated worker (src/worker) claims, mints the token, and calls the agent.
 * pg-boss runs on the existing DATABASE_URL and owns its own `pgboss` schema.
 *
 * The payload carries the GENERATION KEY — the exact `dispatchedAt` the route's
 * CAS wrote (known before send, unlike the pg-boss entry id). Both the worker's
 * claim CAS and the dead-letter CAS match on it, so a stale entry from an old
 * generation can never touch a newer dispatch (F17).
 */
import { PgBoss } from "pg-boss";

export const REPORT_DISPATCH_QUEUE = "report-dispatch";
export const REPORT_DISPATCH_DEAD_QUEUE = "report-dispatch-dead";

// retryDelay 300 is what makes ambiguous-attempt reconciliation DELAYED: an
// ambiguous entry throws, retries ~5 and ~10 minutes later, and only then
// dead-letters — giving a live run's callback time to land first (F16).
// expireInSeconds 600 > the 300s callAgent hold, so a live handler is never
// expired mid-flight; expiration is what turns a worker death into a retry (F10).
export const REPORT_DISPATCH_QUEUE_OPTIONS = {
  retryLimit: 2,
  retryDelay: 300,
  expireInSeconds: 600,
  deadLetter: REPORT_DISPATCH_DEAD_QUEUE,
} as const;

export interface ReportDispatchPayload {
  jobId: string;
  /** Generation key: ISO timestamp of the dispatchedAt this request's CAS wrote. */
  gen: string;
}

/** Idempotent (INSERT … ON CONFLICT DO NOTHING); the dead-letter queue must exist first. */
export async function ensureReportQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(REPORT_DISPATCH_DEAD_QUEUE);
  await boss.createQueue(REPORT_DISPATCH_QUEUE, REPORT_DISPATCH_QUEUE_OPTIONS);
}

// Send-only singleton for the web app: no supervision or scheduling (the worker
// owns maintenance), tiny pool. Cached on globalThis like db.ts so dev
// hot-reload doesn't leak pools. A failed start clears the cache so the next
// request retries instead of awaiting a dead promise forever.
const globalForBoss = globalThis as unknown as { reportBoss?: Promise<PgBoss> };

function startSenderBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on("error", (e) => console.error("[reportQueue] pg-boss error:", e));
  return boss
    .start()
    .then(async () => {
      await ensureReportQueues(boss);
      return boss;
    })
    .catch((e) => {
      globalForBoss.reportBoss = undefined;
      throw e;
    });
}

/**
 * Enqueue one dispatch. Throws when the queue write fails — the caller reverts
 * its CAS and returns 502. A null send id (pg-boss suppression) is treated as a
 * failure too: silently returning would strand the job in `dispatched` until
 * the 2-minute stale reclaim.
 */
export async function sendReportDispatch(payload: ReportDispatchPayload): Promise<void> {
  const boss = await (globalForBoss.reportBoss ??= startSenderBoss());
  const id = await boss.send(REPORT_DISPATCH_QUEUE, payload);
  if (!id) throw new Error("queue did not accept the dispatch job");
}
