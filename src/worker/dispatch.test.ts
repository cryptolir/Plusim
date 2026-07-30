/**
 * Worker claim/retry/dead-letter machinery (docs/plans/reports-scaling-stage1-2.md §4).
 * Named plan tests: 3 (published after enqueue), 4/14 (another attempt's row /
 * duplicate entries), 5 (retry reclaims via queueJobId and re-mints), 6 (failed
 * written only on the final attempt), 7 (timeout leaves processing), 15/19/21
 * (marker branches; ambiguous throws; no claim-path data bleed), 16/20 (DLQ
 * reconciliation keyed on the generation), 22 (older gen cannot claim).
 */
import { it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { reportJob: { updateMany: vi.fn(), findUnique: vi.fn() } },
}));
vi.mock("@/lib/agentglob", () => ({ callAgent: vi.fn() }));
vi.mock("@/lib/agentRuntimeAuth", () => ({
  mintJobToken: vi.fn(),
  appBaseUrl: () => "https://plusim.xyz",
}));

import { db } from "@/lib/db";
import { callAgent } from "@/lib/agentglob";
import { mintJobToken } from "@/lib/agentRuntimeAuth";
import { handleReportDispatch, handleReportDispatchDead } from "./dispatch";

const updateMany = db.reportJob.updateMany as unknown as ReturnType<typeof vi.fn>;
const findUnique = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const agent = callAgent as unknown as ReturnType<typeof vi.fn>;
const mint = mintJobToken as unknown as ReturnType<typeof vi.fn>;

const GEN = "2026-07-30T10:00:00.000Z";
const entry = (over: Partial<{ id: string; gen: string; retryCount: number }> = {}) => ({
  id: over.id ?? "pgb-1",
  data: { jobId: "jobA", gen: over.gen ?? GEN },
  retryCount: over.retryCount ?? 0,
  retryLimit: 2,
});

/** All updateMany calls whose data touched the token hash. */
const tokenWrites = () =>
  updateMany.mock.calls.filter(([arg]) => "agentTokenHash" in (arg.data ?? {}));

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  mint.mockImplementation(() => {
    n += 1;
    return { token: `tok-${n}`, tokenHash: `hash-${n}`, expiresAt: new Date("2026-07-31T10:00:00.000Z") };
  });
  agent.mockResolvedValue({ reply: "ok" });
  updateMany.mockResolvedValue({ count: 1 });
});

// ---- fresh dispatch (baseline; claim shape also serves tests 21/22) ---------
it("fresh dispatch: claim CAS on the dispatched arm only, mark, then send with the minted token", async () => {
  await handleReportDispatch(entry());

  const claim = updateMany.mock.calls[0][0];
  // A single-arm CAS — no OR, so no per-arm data bleed is possible (F14).
  expect(claim.where).toEqual({ id: "jobA", status: "dispatched", dispatchedAt: new Date(GEN) });
  expect(claim.data).toMatchObject({
    status: "processing",
    queueJobId: "pgb-1",
    agentTokenHash: "hash-1",
    dispatchAttemptedAt: null,
  });

  // Marker precedes the send (F9) and is a ONE-SHOT claim scoped to this
  // attempt's token (F21).
  const marker = updateMany.mock.calls[1][0];
  expect(marker.where).toEqual({
    id: "jobA",
    status: "processing",
    queueJobId: "pgb-1",
    agentTokenHash: "hash-1",
    dispatchAttemptedAt: null,
  });
  expect(marker.data.dispatchAttemptedAt).toBeInstanceOf(Date);
  expect(agent).toHaveBeenCalledTimes(1);
  expect(agent.mock.calls[0][0].message).toContain("t=tok-1");
  expect(agent.mock.calls[0][0].sessionKey).toBe("app:plusim:report-job:jobA");
});

// ---- plan test 3 (invariant I2) ---------------------------------------------
it("claim re-check skips a job published after enqueue", async () => {
  updateMany.mockResolvedValueOnce({ count: 0 });
  findUnique.mockResolvedValue({ status: "published", queueJobId: null, dispatchAttemptedAt: null });

  await handleReportDispatch(entry());
  expect(agent).not.toHaveBeenCalled();
  expect(updateMany).toHaveBeenCalledTimes(1); // the claim attempt only
});

// ---- plan tests 4 + 14 (invariant I1) ----------------------------------------
it("duplicate queue entries: the claim loser sees another attempt's processing row and no-ops", async () => {
  updateMany.mockResolvedValueOnce({ count: 0 });
  findUnique.mockResolvedValue({ status: "processing", queueJobId: "pgb-OTHER", dispatchAttemptedAt: null });

  await handleReportDispatch(entry());
  expect(agent).not.toHaveBeenCalled();
  expect(updateMany).toHaveBeenCalledTimes(1);
});

// ---- plan test 22 (F17) -------------------------------------------------------
it("a duplicate entry carrying an older generation key cannot claim a newer dispatched row", async () => {
  const OLD_GEN = "2026-07-30T09:00:00.000Z";
  updateMany.mockResolvedValueOnce({ count: 0 }); // dispatchedAt mismatch → no claim
  findUnique.mockResolvedValue({ status: "processing", queueJobId: "pgb-newer", dispatchAttemptedAt: null });

  await handleReportDispatch(entry({ gen: OLD_GEN }));
  const claim = updateMany.mock.calls[0][0];
  expect(claim.where.dispatchedAt).toEqual(new Date(OLD_GEN)); // matches ITS OWN gen only
  expect(agent).not.toHaveBeenCalled();
});

// ---- plan tests 5 + 15 (marker null) ------------------------------------------
it("retry reclaims its own processing attempt via queueJobId and re-mints under a marker-null CAS", async () => {
  updateMany.mockResolvedValueOnce({ count: 0 }); // claim: row already processing
  findUnique.mockResolvedValue({ status: "processing", queueJobId: "pgb-1", dispatchAttemptedAt: null });

  await handleReportDispatch(entry({ retryCount: 1 }));

  const remint = updateMany.mock.calls[1][0];
  expect(remint.where).toEqual({
    id: "jobA",
    status: "processing",
    queueJobId: "pgb-1",
    dispatchAttemptedAt: null, // safe precisely because the marker precedes every send (F15)
  });
  expect(remint.data).toMatchObject({ agentTokenHash: "hash-2" });
  // …then marks and sends with the NEW token (the raw old one died with the old process).
  expect(agent).toHaveBeenCalledTimes(1);
  expect(agent.mock.calls[0][0].message).toContain("t=tok-2");
});

// ---- plan tests 15 (marker set) + 19 + 21 -------------------------------------
it("ambiguous retry (marker set) throws — never sends, never rotates the token, never completes", async () => {
  updateMany.mockResolvedValueOnce({ count: 0 });
  findUnique.mockResolvedValue({
    status: "processing",
    queueJobId: "pgb-1",
    dispatchAttemptedAt: new Date("2026-07-30T10:01:00.000Z"),
  });

  // Throwing (not returning) is what routes the entry to retry exhaustion and
  // dead-letter reconciliation instead of stranding `processing` forever (F16).
  await expect(handleReportDispatch(entry({ retryCount: 1 }))).rejects.toThrow(/not re-sending/);
  expect(agent).not.toHaveBeenCalled();
  // F14/F9: the only token write in the whole call was the failed claim CAS —
  // scoped to the dispatched arm, so it wrote nothing on this retry.
  expect(tokenWrites()).toHaveLength(1);
  expect(tokenWrites()[0][0].where.status).toBe("dispatched");
});

// ---- Codex round 1, F21 -------------------------------------------------------
it("a resumed zombie attempt loses the one-shot send claim and never sends (F21)", async () => {
  // Zombie A claimed long ago; pg-boss expired + redelivered the SAME entry id,
  // and the redelivery re-minted. A resumes: its marker write carries A's stale
  // token hash → no-match → skip. Simulated from A's perspective: claim wins,
  // but the marker CAS returns 0 (the hash no longer matches).
  updateMany
    .mockResolvedValueOnce({ count: 1 }) // claim (A's original)
    .mockResolvedValueOnce({ count: 0 }); // one-shot marker claim lost
  await expect(handleReportDispatch(entry())).resolves.toBeUndefined();
  expect(agent).not.toHaveBeenCalled();
});

// ---- Codex round 1, F22 -------------------------------------------------------
it("definitive send failure (app-attributed status) clears the marker so the retry re-sends", async () => {
  agent.mockRejectedValue(new Error("agentglob 503: service unavailable"));
  await expect(handleReportDispatch(entry({ retryCount: 0 }))).rejects.toThrow("agentglob 503");

  const clears = updateMany.mock.calls.filter(([a]) => a.data?.dispatchAttemptedAt === null && !a.data?.status);
  expect(clears).toHaveLength(1);
  // Scoped to OUR token — can never unmark a newer attempt.
  expect(clears[0][0].where).toEqual({
    id: "jobA",
    status: "processing",
    queueJobId: "pgb-1",
    agentTokenHash: "hash-1",
  });
  // No failed write on a non-final attempt (F3 unchanged).
  expect(updateMany.mock.calls.filter(([a]) => a.data?.status === "failed")).toHaveLength(0);
});

it("ambiguous send failures (gateway status / transport error) keep the marker set", async () => {
  for (const failure of ["agentglob 502: bad gateway", "fetch failed: socket hang up"]) {
    vi.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
    agent.mockRejectedValue(new Error(failure));
    await expect(handleReportDispatch(entry({ retryCount: 0 }))).rejects.toThrow();
    const clears = updateMany.mock.calls.filter(([a]) => a.data?.dispatchAttemptedAt === null && !a.data?.status);
    expect(clears, failure).toHaveLength(0);
  }
});

// ---- plan test 6 (F3) -----------------------------------------------------------
it("first-attempt transient error rethrows without writing failed", async () => {
  agent.mockRejectedValue(new Error("agentglob 500: upstream blew up"));
  await expect(handleReportDispatch(entry({ retryCount: 0 }))).rejects.toThrow("agentglob 500");
  const failedWrites = updateMany.mock.calls.filter(([a]) => a.data?.status === "failed");
  expect(failedWrites).toHaveLength(0);
});

it("final attempt writes failed + error text, then still rethrows (definitive failure)", async () => {
  agent.mockRejectedValue(new Error("agentglob 500: upstream blew up"));
  await expect(handleReportDispatch(entry({ retryCount: 2 }))).rejects.toThrow("agentglob 500");
  const failedWrites = updateMany.mock.calls.filter(([a]) => a.data?.status === "failed");
  expect(failedWrites).toHaveLength(1);
  expect(failedWrites[0][0].where).toEqual({ id: "jobA", status: "processing", queueJobId: "pgb-1" });
  expect(failedWrites[0][0].data.error).toContain("dispatch failed: agentglob 500");
});

// ---- Codex round 2, F24 ---------------------------------------------------------
it("AMBIGUOUS final send leaves processing (callback-eligible) and rethrows to the DLQ", async () => {
  // e.g. earlier definitive 503s cleared the marker, the final attempt re-sent,
  // and got a 502 — AgentGlob may have accepted; the run may be live. Writing
  // failed here would orphan its callback (acceptingWhere needs processing).
  agent.mockRejectedValue(new Error("agentglob 502: bad gateway"));
  await expect(handleReportDispatch(entry({ retryCount: 2 }))).rejects.toThrow("agentglob 502");
  expect(updateMany.mock.calls.filter(([a]) => a.data?.status === "failed")).toHaveLength(0);
});

// ---- plan test 7 ----------------------------------------------------------------
it("dispatch timeout leaves processing for the callback", async () => {
  agent.mockRejectedValue(new Error("The operation was aborted due to timeout"));
  await expect(handleReportDispatch(entry())).resolves.toBeUndefined();
  const statusWrites = updateMany.mock.calls.filter(([a]) => a.data?.status === "failed");
  expect(statusWrites).toHaveLength(0);
});

// ---- plan tests 16 + 20 (F10/F16/F17) + Codex round 2 F24 ---------------------------
it("dead-letter reconciliation marks failed only for the matching generation key, outside the callback grace", async () => {
  updateMany.mockResolvedValueOnce({ count: 1 });
  await handleReportDispatchDead({ jobId: "jobA", gen: GEN });
  const cas = updateMany.mock.calls[0][0];
  expect(cas.where).toMatchObject({ id: "jobA", status: "processing", dispatchedAt: new Date(GEN) });
  // F24 — never-sent rows reconcile immediately; sent rows only after the grace.
  expect(cas.where.OR[0]).toEqual({ dispatchAttemptedAt: null });
  expect(cas.where.OR[1].dispatchAttemptedAt.lt).toBeInstanceOf(Date);
  expect(cas.data).toEqual({ status: "failed", error: "worker crashed or expired" });
});

it("dead-letter reconciliation no-ops when the callback moved the row out of processing", async () => {
  updateMany.mockResolvedValueOnce({ count: 0 });
  findUnique.mockResolvedValue({ status: "completed", dispatchedAt: new Date(GEN) });
  await expect(handleReportDispatchDead({ jobId: "jobA", gen: GEN })).resolves.toBeUndefined();
  expect(updateMany).toHaveBeenCalledTimes(1);
});

it("dead-letter reconciliation DEFERS (throws) while a freshly-sent row is inside the callback grace", async () => {
  // The DLQ entry retries on backoff and reconciles once the grace has passed;
  // an accepted run's callback keeps its processing window (F24).
  updateMany.mockResolvedValueOnce({ count: 0 });
  findUnique.mockResolvedValue({ status: "processing", dispatchedAt: new Date(GEN) });
  await expect(handleReportDispatchDead({ jobId: "jobA", gen: GEN })).rejects.toThrow(
    /deferring reconciliation/,
  );
});

it("dead-letter reconciliation no-ops for a processing row owned by a NEWER generation", async () => {
  updateMany.mockResolvedValueOnce({ count: 0 });
  findUnique.mockResolvedValue({ status: "processing", dispatchedAt: new Date("2026-07-30T11:00:00.000Z") });
  await expect(handleReportDispatchDead({ jobId: "jobA", gen: GEN })).resolves.toBeUndefined();
});
