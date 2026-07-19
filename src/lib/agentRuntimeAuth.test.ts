import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock the DB layer this module reaches into.
vi.mock("@/lib/db", () => ({ db: { reportJob: { findUnique: vi.fn() } } }));

import { db } from "@/lib/db";
import { authorizeAgentJobRequest, sha256Hex, mintJobToken } from "./agentRuntimeAuth";

const RUNTIME = "runtime-secret-abc";
const findUnique = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;

function reqFor(jobId: string, opts: { bearer?: string; t?: string } = {}) {
  const url = `https://plusim.xyz/api/agent/jobs/${jobId}/manifest${opts.t !== undefined ? `?t=${opts.t}` : ""}`;
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return new NextRequest(url, { headers });
}

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: "jobA",
    targetUserId: "user-1",
    status: "processing",
    agentTokenHash: sha256Hex("good-token"),
    agentTokenExpiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

beforeEach(() => {
  findUnique.mockReset();
  process.env.PLUSIM_AGENT_RUNTIME_TOKEN = RUNTIME;
});

describe("authorizeAgentJobRequest — layer 1 (runtime bearer)", () => {
  it("missing bearer → 401", async () => {
    const res = await authorizeAgentJobRequest(reqFor("jobA", { t: "good-token" }), "jobA");
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("wrong bearer → 401", async () => {
    const res = await authorizeAgentJobRequest(reqFor("jobA", { bearer: "nope", t: "good-token" }), "jobA");
    expect((res as Response).status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("authorizeAgentJobRequest — layer 2 (per-job token)", () => {
  it("valid bearer but MISSING per-job token → 404", async () => {
    const res = await authorizeAgentJobRequest(reqFor("jobA", { bearer: RUNTIME }), "jobA");
    expect((res as Response).status).toBe(404);
  });

  it("valid bearer but WRONG per-job token → 404", async () => {
    findUnique.mockResolvedValue(jobRow());
    const res = await authorizeAgentJobRequest(reqFor("jobA", { bearer: RUNTIME, t: "wrong-token" }), "jobA");
    expect((res as Response).status).toBe(404);
  });

  it("token from job A used on job B → 404 (jobId is the identity)", async () => {
    // Job B exists but its stored hash is for a different token.
    findUnique.mockResolvedValue(jobRow({ id: "jobB", agentTokenHash: sha256Hex("token-B") }));
    const res = await authorizeAgentJobRequest(reqFor("jobB", { bearer: RUNTIME, t: "good-token" }), "jobB");
    expect((res as Response).status).toBe(404);
  });

  it("expired per-job token → 404", async () => {
    findUnique.mockResolvedValue(jobRow({ agentTokenExpiresAt: new Date(Date.now() - 1000) }));
    const res = await authorizeAgentJobRequest(reqFor("jobA", { bearer: RUNTIME, t: "good-token" }), "jobA");
    expect((res as Response).status).toBe(404);
  });

  it("published job (token cleared) → 404", async () => {
    findUnique.mockResolvedValue(jobRow({ status: "published", agentTokenHash: null, agentTokenExpiresAt: null }));
    const res = await authorizeAgentJobRequest(reqFor("jobA", { bearer: RUNTIME, t: "good-token" }), "jobA");
    expect((res as Response).status).toBe(404);
  });

  it("happy path → returns the job + the authorizing token hash", async () => {
    findUnique.mockResolvedValue(jobRow());
    const res = await authorizeAgentJobRequest(reqFor("jobA", { bearer: RUNTIME, t: "good-token" }), "jobA");
    expect(res).not.toBeInstanceOf(Response);
    if (res instanceof Response) throw new Error("unexpected 4xx");
    expect(res.job.id).toBe("jobA");
    expect(res.job.targetUserId).toBe("user-1");
    expect(res.tokenHash).toBe(sha256Hex("good-token"));
  });
});

describe("mintJobToken", () => {
  it("token hashes to the stored hash and carries a future expiry", () => {
    const { token, tokenHash, expiresAt } = mintJobToken();
    expect(sha256Hex(token)).toBe(tokenHash);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
