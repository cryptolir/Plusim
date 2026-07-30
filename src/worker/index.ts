/**
 * Dedicated report-dispatch worker (docs/plans/reports-scaling-stage1-2.md §2).
 *
 * Runs under `pnpm worker` (tsx — Node's native TS does not transform tsconfig
 * `paths`, and the reused helpers import `@/lib/*` transitively; F4) as a
 * SECOND Coolify service from this repo, 1 replica, dispatch concurrency 1
 * (the Stage 2 gate must be measured before raising it — plan §8).
 *
 * Entrypoint only — the handlers live in ./dispatch, env assertions in ./env.
 */
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { assertWorkerEnv } from "./env";
import {
  ensureReportQueues,
  REPORT_DISPATCH_QUEUE,
  REPORT_DISPATCH_DEAD_QUEUE,
  type ReportDispatchPayload,
} from "@/lib/reportQueue";
import { handleReportDispatch, handleReportDispatchDead } from "./dispatch";
import { reconcileExpiredProcessing } from "./reconcile";

const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  assertWorkerEnv();

  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  boss.on("error", (e) => console.error("[worker] pg-boss error:", e));
  await boss.start();
  await ensureReportQueues(boss);

  // batchSize 1 + default localConcurrency 1 = dispatch concurrency 1 (§8).
  await boss.work(
    REPORT_DISPATCH_QUEUE,
    { batchSize: 1, includeMetadata: true } as const,
    async (jobs: JobWithMetadata<ReportDispatchPayload>[]) => {
      for (const job of jobs) {
        await handleReportDispatch({
          id: job.id,
          data: job.data,
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        });
      }
    },
  );
  await boss.work<ReportDispatchPayload>(REPORT_DISPATCH_DEAD_QUEUE, async (jobs) => {
    for (const job of jobs) await handleReportDispatchDead(job.data);
  });

  // Expired-token sweep: at boot (right after any outage ends) and hourly.
  await reconcileExpiredProcessing().catch((e) => console.error("[worker] reconcile failed:", e));
  setInterval(() => {
    void reconcileExpiredProcessing().catch((e) => console.error("[worker] reconcile failed:", e));
  }, RECONCILE_INTERVAL_MS).unref();

  console.log("[worker] report-dispatch worker started (concurrency 1)");

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[worker] ${sig} — stopping`);
      // A kill mid-callAgent is safe by design: expiration → retry → the
      // marker branches / dead-letter reconciliation settle the row (I5).
      // stop() resolves when stopping BEGINS; exit on the stopped event, with
      // a hard fallback in case a held dispatch outlives the grace window.
      boss.once("stopped", () => process.exit(0));
      setTimeout(() => process.exit(1), 35_000).unref();
      void boss.stop({ graceful: true, timeout: 30_000 });
    });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
