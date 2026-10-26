/**
 * POST/GET /admin/api/reports/:jobId/chat (docs/plans/report-adjust-chat.md B4):
 * admin-only, one live per-turn token per job minted in one CAS for the current
 * generation, cleared in `finally` on every path, isolated agent session with no
 * appUserId, and a thread filed by generation —
 * test_previous_turn_reply_after_dispatch_is_not_in_new_thread (Codex P2, Rev 3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/agentglob", () => ({ callAgent: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn(), updateMany: vi.fn() },
    reportChatMessage: { create: vi.fn(), findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { callAgent } from "@/lib/agentglob";
import { sha256Hex } from "@/lib/agentRuntimeAuth";
import { POST, GET, adjustSessionKey } from "./[jobId]/chat/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const agent = callAgent as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobUpdate = db.reportJob.updateMany as unknown as ReturnType<typeof vi.fn>;
const msgCreate = db.reportChatMessage.create as unknown as ReturnType<typeof vi.fn>;
const msgFind = db.reportChatMessage.findMany as unknown as ReturnType<typeof vi.fn>;

const G1 = new Date("2026-10-01T10:00:00.000Z");
const G2 = new Date("2026-10-02T10:00:00.000Z");
const params = { params: Promise.resolve({ jobId: "jobA" }) };
const post = (message: unknown = "העבר את תשלום 2 של רמי לוי לחודש הבא") =>
  POST(
    new NextRequest("https://plusim.xyz/admin/api/reports/jobA/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_BASE_URL = "https://plusim.xyz";
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  jobFind.mockResolvedValue({ status: "published", dispatchedAt: G1 });
  jobUpdate.mockResolvedValue({ count: 1 });
  msgCreate.mockImplementation(async ({ data }) => ({ id: `m-${data.role}`, createdAt: new Date(), ...data }));
  agent.mockResolvedValue({ reply: "הזזתי את התשלום ל־2026-06-02" });
});

const mintCall = () => jobUpdate.mock.calls[0][0];
const clearCalls = () => jobUpdate.mock.calls.slice(1).map((c) => c[0]);

describe("admin chat POST", () => {
  it("non-admin ⇒ the auth response, no token minted, no agent call", async () => {
    auth.mockResolvedValue(NextResponse.json({ error: "אין הרשאה" }, { status: 403 }));
    expect((await post()).status).toBe(403);
    expect(jobUpdate).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
  });

  it.each(["processing", "dispatched", "uploaded", "failed"])("status %s ⇒ 409, nothing minted", async (status) => {
    jobFind.mockResolvedValue({ status, dispatchedAt: G1 });
    expect((await post()).status).toBe(409);
    expect(jobUpdate).not.toHaveBeenCalled();
  });

  it.each([["empty", ""], ["too long", "x".repeat(2001)], ["not a string", 7]])("%s message ⇒ 400", async (_l, m) => {
    expect((await post(m)).status).toBe(400);
    expect(jobUpdate).not.toHaveBeenCalled();
  });

  it("mints in ONE CAS: adjustable, the read generation, no live token — and binds the generation", async () => {
    await post();
    const { where, data } = mintCall();
    expect(where).toMatchObject({ id: "jobA", dispatchedAt: G1 });
    expect(where.status.in).toEqual(["completed", "needs_review", "published"]);
    expect(where.OR).toEqual([{ adjustTokenHash: null }, { adjustTokenExpiresAt: { lt: expect.any(Date) } }]);
    expect(data.adjustGeneration).toEqual(G1);
    expect(data.adjustTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a second message while a live token exists ⇒ 409, no agent call, nothing overwritten", async () => {
    jobUpdate.mockResolvedValueOnce({ count: 0 });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("עדיין עובד");
    expect(agent).not.toHaveBeenCalled();
    expect(jobUpdate).toHaveBeenCalledTimes(1); // the failed claim only — no clear of someone else's token
  });

  it("the outbound message carries the two URLs with the minted token and the admin text; isolated session, no appUserId", async () => {
    await post();
    const call = agent.mock.calls[0][0];
    expect(call.sessionKey).toBe(adjustSessionKey("jobA", G1));
    expect(call.sessionKey).toBe("app:plusim:report-adjust:jobA:2026-10-01T10:00:00.000Z");
    expect(call).not.toHaveProperty("appUserId");
    const token = decodeURIComponent(/rows\?t=([^\s]+)/.exec(call.message)![1]);
    expect(sha256Hex(token)).toBe(mintCall().data.adjustTokenHash);
    expect(call.message).toContain("PLUSIM_REPORT_ADJUST v1");
    expect(call.message).toContain(`https://plusim.xyz/api/agent/jobs/jobA/rows?t=`);
    expect(call.message).toContain(`https://plusim.xyz/api/agent/jobs/jobA/adjust?t=`);
    expect(call.message).not.toContain("artifact");
    expect(call.message).toContain("<<<admin>>>\nהעבר את תשלום 2 של רמי לוי לחודש הבא\n<<<end_admin>>>");
  });

  it.each([
    ["success", () => agent.mockResolvedValue({ reply: "ok" }), 200],
    ["agent error", () => agent.mockRejectedValue(new Error("agentglob 500")), 502],
    ["timeout", () => agent.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" })), 502],
  ])("the token is cleared in finally on %s", async (_l, setup, status) => {
    setup();
    expect((await post()).status).toBe(status);
    const hash = mintCall().data.adjustTokenHash;
    expect(clearCalls()).toEqual([
      {
        where: { id: "jobA", adjustTokenHash: hash },
        data: { adjustTokenHash: null, adjustTokenExpiresAt: null, adjustGeneration: null },
      },
    ]);
  });

  it("the reply is persisted only on success; the user message stays on failure", async () => {
    agent.mockRejectedValue(new Error("down"));
    await post();
    expect(msgCreate.mock.calls.map((c) => c[0].data.role)).toEqual(["user"]);
    vi.clearAllMocks();
    jobUpdate.mockResolvedValue({ count: 1 });
    jobFind.mockResolvedValue({ status: "published", dispatchedAt: G1 });
    msgCreate.mockImplementation(async ({ data }) => ({ id: `m-${data.role}`, createdAt: new Date(), ...data }));
    agent.mockResolvedValue({ reply: "ok" });
    const res = await post();
    expect(msgCreate.mock.calls.map((c) => c[0].data.role)).toEqual(["user", "assistant"]);
    const body = await res.json();
    expect(body.conversationId).toBe("jobA");
    expect(body.assistantMessage.content).toBe("ok");
  });

  it("test_previous_turn_reply_after_dispatch_is_not_in_new_thread", async () => {
    // The turn is minted for G1; a re-run moves the job to G2 while the agent works.
    agent.mockImplementation(async () => {
      jobFind.mockResolvedValue({ status: "completed", dispatchedAt: G2 });
      return { reply: "הזזתי את התשלום" };
    });
    await post();
    const reply = msgCreate.mock.calls.find((c) => c[0].data.role === "assistant")![0].data;
    expect(reply.generation).toEqual(G1); // filed under the turn's generation, not the job's new one
    // The new thread asks for G2 only.
    msgFind.mockResolvedValue([]);
    await GET(new NextRequest("https://plusim.xyz/admin/api/reports/jobA/chat"), params);
    expect(msgFind.mock.calls[0][0].where).toEqual({ jobId: "jobA", generation: G2 });
  });
});

describe("admin chat GET", () => {
  it("returns the current generation's messages in (createdAt, id) order with serverNow", async () => {
    msgFind.mockResolvedValue([{ id: "a", role: "user", content: "x", createdAt: new Date() }]);
    const res = await GET(new NextRequest("https://plusim.xyz/admin/api/reports/jobA/chat"), params);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(typeof body.serverNow).toBe("string");
    const q = msgFind.mock.calls[0][0];
    expect(q.where).toEqual({ jobId: "jobA", generation: G1 });
    expect(q.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });
  it("non-admin ⇒ the auth response", async () => {
    auth.mockResolvedValue(NextResponse.json({ error: "נדרשת התחברות מחדש" }, { status: 401 }));
    expect((await GET(new NextRequest("https://plusim.xyz/admin/api/reports/jobA/chat"), params)).status).toBe(401);
    expect(msgFind).not.toHaveBeenCalled();
  });
});
