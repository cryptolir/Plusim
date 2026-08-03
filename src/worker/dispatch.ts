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

/**
 * True when a callAgent failure carries an HTTP status ATTRIBUTABLE TO THE
 * AGENTGLOB APP (callAgent throws `agentglob <status>: <body>` for non-ok
 * responses). 502/504 are excluded — a gateway answered, and the backend may
 * still hold (or be running) the request. Everything else (network reset,
 * DNS, abort) has no status at all and stays ambiguous.
 */
export function isDefinitiveSendFailure(msg: string): boolean {
  const status = /^agentglob (\d{3}):/.exec(msg)?.[1];
  return status !== undefined && status !== "502" && status !== "504";
}

/**
 * The agent's own give-up ack (`FAILED <jobId> <reason>`), carried as a throw so
 * the entry reaches the dead-letter grace path. A distinct CLASS, not a message
 * prefix: the reason is agent-supplied free text, and classifying it by text is
 * what F33/F35 are about.
 */
export class AgentGaveUpError extends Error {
  constructor(reason: string) {
    super(`הסוכן דיווח על כשל: ${reason}`);
    this.name = "AgentGaveUpError";
  }
}

/**
 * OUR 300 s abort, or the AgentGlob app answering? Classify structurally, not
 * by message text: `AbortSignal.timeout` throws a DOMException named
 * TimeoutError (AbortError when aborted otherwise), while an app error is a
 * plain Error carrying an `agentglob NNN:` status prefix (agentglob.ts:50,52).
 *
 * Matching /abort|timeout/ over the raw message read `agentglob 500: upstream
 * timeout` as our own abort — the handler then returned SUCCESSFULLY, so
 * pg-boss acked the entry with dispatchAttemptedAt still set: no retry, no
 * dead-letter, and the row sat `processing` until the ~25 h expiry sweep
 * (Codex round 9, F33). A status-prefixed message can now never reach the text
 * fallback, which is kept only for transport aborts that lost their
 * DOMException identity.
 *
 * `AgentGaveUpError` gets the same structural exemption: its message embeds the
 * agent's own free-text reason, so `FAILED <job> analysis script timeout` would
 * otherwise text-match here and reproduce F33 exactly (Codex round 2, F35).
 */
export function isOwnDispatchAbort(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof AgentGaveUpError) return false;
  if (/^agentglob \d{3}:/.test(msg)) return false;
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return true;
  return /abort|timeout/i.test(msg);
}

/** jobId is a cuid today; escaping keeps the FAILED matcher literal regardless. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  let tokenHash: string;
  if (claimed.count === 1) {
    token = fresh.token;
    tokenHash = fresh.tokenHash;
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
    tokenHash = reminted.tokenHash;
  }

  // The send marker precedes every send — that ordering is what makes a null
  // marker PROOF that no run exists (F9). It is a ONE-SHOT claim (Codex round 1,
  // F21): matching our own token hash + a still-null marker means a paused
  // handler that resumes after pg-boss expired and redelivered its entry (same
  // entry id!) no-matches here — the redelivery re-minted, so the zombie's hash
  // is stale — and can never perform a second send for the generation (I1).
  const marked = await db.reportJob.updateMany({
    where: {
      id: jobId,
      status: "processing",
      queueJobId: entry.id,
      agentTokenHash: tokenHash,
      dispatchAttemptedAt: null,
    },
    data: { dispatchAttemptedAt: new Date() },
  });
  if (marked.count === 0) {
    console.warn(
      `[worker] job=${jobId} entry=${entry.id} skipping — lost the one-shot send claim (a newer attempt owns it)`,
    );
    return;
  }

  const manifestUrl = `${appBaseUrl()}/api/agent/jobs/${jobId}/manifest?t=${encodeURIComponent(token)}`;
  const message = `PLUSIM_REPORT_JOB v1\njob: ${jobId}\nmanifest: ${manifestUrl}`;
  console.log(`[worker] dispatching job=${jobId} entry=${entry.id} attempt=${entry.retryCount}`);
  try {
    const { reply } = await callAgent({
      // Keyed on the dispatch GENERATION, not just the job. A per-job key made
      // every re-run land in the same agent conversation, so the model read its
      // own previous verdict and repeated it instead of re-examining: job
      // cmsbmx7vo's session held two identical "FAILED — plusim-reports scripts
      // not found" turns and answered a third dispatch the same way in 12 s with
      // zero tool calls, hours after the scripts were verified present. A
      // re-run's whole purpose is a clean attempt, so it gets a clean session.
      //
      // Retries WITHIN one generation deliberately keep sharing a session — they
      // are the same logical attempt, and re-sending the same generation is
      // exactly the case where prior context is legitimate.
      sessionKey: `app:plusim:report-job:${jobId}:${entry.data.gen}`,
      message,
      timeoutMs: DISPATCH_TIMEOUT_MS,
    });
    console.log(`[worker] job=${jobId} agent replied: ${reply.slice(0, 200)}`);
    // The callback stays authoritative — but `FAILED <jobId> <reason>` (the
    // skill's documented give-up ack, SKILL.md "Failure handling") was
    // previously logged and dropped, leaving the row `processing` until the
    // ~25 h expiry sweep.
    //
    // Settling it HERE would be wrong (Codex round 1, F34): the skill retries a
    // failing script before giving up, so an ambiguous finalize POST can still
    // be committing server-side while this reply arrives. Writing `failed` would
    // move the row out of `acceptingWhere` (result/route.ts:39) and the real
    // result would 409 into the void, unrecoverable — the entry is acked, so
    // neither a retry nor the DLQ can bring it back.
    //
    // So THROW instead: the catch below leaves the row `processing` (no
    // `agentglob NNN:` prefix ⇒ not a definitive send failure ⇒ no status write
    // and no marker clear), the entry exhausts to the dead-letter queue, and
    // `handleReportDispatchDead` settles it only after
    // DEAD_LETTER_CALLBACK_GRACE_MS — no-opping if the callback landed in the
    // meantime. Same grace path an ambiguous send already takes.
    const gaveUp = new RegExp(`^FAILED\\s+${escapeRe(jobId)}\\b[\\s:-]*([\\s\\S]*)`).exec(reply.trim());
    if (gaveUp) {
      throw new AgentGaveUpError((gaveUp[1].trim() || "ללא פירוט").slice(0, 500));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isOwnDispatchAbort(e)) {
      // Run continues server-side; the callback will complete the job. Only a
      // genuine client-side abort may ack the entry like this (F33).
      console.warn(`[worker] job=${jobId} dispatch wait timed out; awaiting callback`);
      return;
    }
    console.error(`[worker] job=${jobId} dispatch failed (attempt=${entry.retryCount}): ${msg}`);
    if (entry.retryCount >= entry.retryLimit && isDefinitiveSendFailure(msg)) {
      // Final attempt AND the app itself rejected — no run exists, safe to fail
      // now (F3). An AMBIGUOUS final failure must NOT write failed here: the
      // run may be live, and its callback needs the row to stay `processing`
      // (acceptingWhere) — the throw below dead-letters the entry and the DLQ
      // handler reconciles AFTER the callback grace window (Codex round 2, F24).
      await db.reportJob.updateMany({
        where: { id: jobId, status: "processing", queueJobId: entry.id },
        data: { status: "failed", error: `השליחה לסוכן נכשלה: ${msg.slice(0, 500)}` },
      });
    } else if (entry.retryCount < entry.retryLimit && isDefinitiveSendFailure(msg)) {
      // The AgentGlob APP answered with an error status — THIS attempt's request
      // terminated without an accepted run (and the agent posts its callback
      // BEFORE replying, so any run that mattered already called back). Clearing
      // the marker — scoped to our own token so it can never unmark a newer
      // attempt — is what lets the retry re-mint and re-send; without it, every
      // send-error retry hits the ambiguous branch and retryLimit provides no
      // recovery at all (Codex round 1, F22). Gateway statuses (502/504) and
      // transport errors stay ambiguous: the backend may have the request.
      await db.reportJob.updateMany({
        where: { id: jobId, status: "processing", queueJobId: entry.id, agentTokenHash: tokenHash },
        data: { dispatchAttemptedAt: null },
      });
    }
    throw e instanceof Error ? e : new Error(msg);
  }
}

/**
 * Grace before reconciling a row whose LAST SEND is recent: an ambiguous final
 * send can dead-letter seconds after callAgent returned, while the accepted run
 * is still working — its callback needs `processing` to survive until it lands.
 * 10 min covers the 300 s callAgent hold + the result route's 60 s budget with
 * slack; the DLQ's retry backoff (5 × 60 s backoff ≈ 30 min) guarantees a later
 * attempt lands after the grace expires (Codex round 2, F24).
 */
export const DEAD_LETTER_CALLBACK_GRACE_MS = 10 * 60_000;

/**
 * Dead-letter reconciliation (F10): a final-attempt crash or expiration would
 * otherwise strand `processing` forever — unreachable by the run route and
 * invisible to the callback. Keys on the GENERATION (the dead-letter entry has
 * a NEW pg-boss id; only the payload survives — F17), so it inherently no-ops
 * when the callback already moved the row out of `processing` (F16). A row
 * whose send marker is within the callback grace throws instead — the DLQ
 * entry retries on backoff and reconciles once the grace has passed (F24).
 */
export async function handleReportDispatchDead(payload: ReportDispatchPayload): Promise<void> {
  const gen = new Date(payload.gen);
  const graceCutoff = new Date(Date.now() - DEAD_LETTER_CALLBACK_GRACE_MS);
  const res = await db.reportJob.updateMany({
    where: {
      id: payload.jobId,
      status: "processing",
      dispatchedAt: gen,
      // Never-sent rows (marker null) reconcile immediately; sent rows only
      // after the callback grace.
      OR: [{ dispatchAttemptedAt: null }, { dispatchAttemptedAt: { lt: graceCutoff } }],
    },
    data: { status: "failed", error: "תהליך הרקע קרס או פג תוקפו לפני שהעבודה נשלחה" },
  });
  if (res.count === 1) {
    console.warn(`[worker] job=${payload.jobId} gen=${payload.gen} dead-lettered — reconciled to failed`);
    return;
  }
  // 0 rows: either the callback moved the row on (done), or the row is still
  // ours but freshly sent — defer, don't discard.
  const row = await db.reportJob.findUnique({
    where: { id: payload.jobId },
    select: { status: true, dispatchedAt: true },
  });
  if (row && row.status === "processing" && row.dispatchedAt?.getTime() === gen.getTime()) {
    throw new Error(
      `job ${payload.jobId}: recent send may still produce a callback — deferring reconciliation`,
    );
  }
  console.log(`[worker] job=${payload.jobId} gen=${payload.gen} dead-letter no-op (row moved on)`);
}
