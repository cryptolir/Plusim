/**
 * PATCH /api/reports/[jobId]/settlements/[id] — the client's one write surface
 * (docs/plans/bank-statements.md B4). Ownership and status live inside the
 * write's own predicate; every refusal is a 404, never a 403.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findFirst: vi.fn() },
    reportSettlement: { updateMany: vi.fn() },
  },
}));

import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { PATCH } from "./[jobId]/settlements/[id]/route";

const authFn = auth as unknown as ReturnType<typeof vi.fn>;
const findJob = db.reportJob.findFirst as unknown as ReturnType<typeof vi.fn>;
const updateMany = db.reportSettlement.updateMany as unknown as ReturnType<typeof vi.fn>;

const CYCLE = "max-1-billed@2026-09-10";
const VERIFICATION = {
  perSource: [
    { label: "max-1-billed", statementTotalAgorot: 1539514, chargeCycles: [{ chargeDate: "2026-09-10", amountAgorot: 1539514 }] },
    { label: "hapoalim-1812", statementTotalAgorot: null },
  ],
};
const params = Promise.resolve({ jobId: "jobA", id: "setA" });
const req = (body: unknown) =>
  new NextRequest("http://localhost/api/reports/jobA/settlements/setA", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  authFn.mockResolvedValue({ userId: "user_1" });
  findJob.mockResolvedValue({ verification: VERIFICATION });
  updateMany.mockResolvedValue({ count: 1 });
});

describe("PATCH a settlement match", () => {
  it("401 when not signed in", async () => {
    authFn.mockResolvedValue({ userId: null });
    expect((await PATCH(req({ matchedCycle: CYCLE }), { params })).status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("404 not-owner / unpublished — the job read is bound to owner AND published", async () => {
    findJob.mockResolvedValue(null);
    const res = await PATCH(req({ matchedCycle: CYCLE }), { params });
    expect(res.status).toBe(404);
    expect(findJob.mock.calls[0][0].where).toEqual({ id: "jobA", targetUserId: "user_1", status: "published" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("404 for a settlement of another job (owned or not): the write matches nothing", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const res = await PATCH(req({ matchedCycle: CYCLE }), { params });
    expect(res.status).toBe(404);
  });

  it("400 for a cycle id the job does not have", async () => {
    const res = await PATCH(req({ matchedCycle: "max-1-billed@2026-10-10" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/מחזור חיוב/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("400 when the verification has no cycles at all (fail closed), clearing still allowed", async () => {
    findJob.mockResolvedValue({ verification: { perSource: [{ label: "hapoalim-1812", statementTotalAgorot: null }] } });
    expect((await PATCH(req({ matchedCycle: CYCLE }), { params })).status).toBe(400);
    findJob.mockResolvedValue({ verification: null });
    expect((await PATCH(req({ matchedCycle: CYCLE }), { params })).status).toBe(400);
    expect((await PATCH(req({ matchedCycle: null }), { params })).status).toBe(200);
  });

  it("400 for a malformed body", async () => {
    for (const body of [{}, { matchedCycle: 5 }, { matchedCycle: undefined }]) {
      expect((await PATCH(req(body), { params })).status, JSON.stringify(body)).toBe(400);
    }
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("200 sets and clears matchedCycle with ONE updateMany carrying the full predicate", async () => {
    let res = await PATCH(req({ matchedCycle: CYCLE }), { params });
    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: "setA", jobId: "jobA", job: { targetUserId: "user_1", status: "published" } },
      data: { matchedCycle: CYCLE },
    });
    res = await PATCH(req({ matchedCycle: null }), { params });
    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[1][0].data).toEqual({ matchedCycle: null });
  });

  it("never answers 403", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./[jobId]/settlements/[id]/route.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toMatch(/403/);
  });
});
