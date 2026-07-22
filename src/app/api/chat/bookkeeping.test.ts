/**
 * C3 post-agent write path:
 *  - T7: once the reply is persisted, a transient failure in the bookkeeping
 *    (title update / updatedAt bump / view upsert) must NOT turn the saved
 *    reply into a client error. A failure in the assistant-message create
 *    itself still errors (that write is not isolated).
 *  - T4: a first message on a legacy null-title conversation runs the title
 *    update BEFORE the raw updatedAt bump, and the bump + view upsert share the
 *    exact same `now`, so updatedAt == lastViewedAt (no spurious "unread").
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => "user-1") }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/agentglob", () => ({
  callAgent: vi.fn(async () => ({ reply: "REPLY" })),
  makeSessionKey: (u: string, c: string) => `app:plusim:${u}:${c}`,
}));
vi.mock("@/lib/appSettings", () => ({ getSetting: vi.fn(async () => null) }));
vi.mock("@/lib/pastMeeting", () => ({ buildLinkedFolderContext: vi.fn(async () => null) }));

const dbMock = vi.hoisted(() => ({
  conversation: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  message: { create: vi.fn() },
  conversationView: { upsert: vi.fn() },
  $executeRaw: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { POST } from "./route";

function post(body: object) {
  return POST(
    new NextRequest("https://plusim.xyz/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.conversation.update.mockResolvedValue({});
  dbMock.conversationView.upsert.mockResolvedValue({});
  dbMock.$executeRaw.mockResolvedValue(1);
  dbMock.message.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({
    id: "m",
    createdAt: new Date(),
    ...a.data,
  }));
});

it("T7: a bookkeeping failure still returns the persisted reply (200)", async () => {
  dbMock.conversation.findUnique.mockResolvedValue({
    id: "c1", userId: "user-1", sessionKey: "app:plusim:user-1:c1",
    sectionContext: null, title: null, _count: { messages: 0 },
  });
  dbMock.conversation.update.mockRejectedValue(new Error("db down"));
  dbMock.$executeRaw.mockRejectedValue(new Error("db down"));
  dbMock.conversationView.upsert.mockRejectedValue(new Error("db down"));

  const res = await post({ conversationId: "c1", message: "hi" });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.assistantMessage.content).toBe("REPLY");
});

it("T7: a failure in the assistant-message create itself errors (not isolated)", async () => {
  dbMock.conversation.findUnique.mockResolvedValue({
    id: "c1", userId: "user-1", sessionKey: "app:plusim:user-1:c1",
    sectionContext: null, title: "t", _count: { messages: 2 },
  });
  dbMock.message.create.mockImplementation(async (a: { data: { role: string } }) => {
    if (a.data.role === "assistant") throw new Error("assistant write failed");
    return { id: "m", ...a.data };
  });
  await expect(post({ conversationId: "c1", message: "hi" })).rejects.toThrow("assistant write failed");
});

it("T4: null-title first message → title update precedes the bump, and bump==view now", async () => {
  dbMock.conversation.findUnique.mockResolvedValue({
    id: "c1", userId: "user-1", sessionKey: "app:plusim:user-1:c1",
    sectionContext: null, title: null, _count: { messages: 0 },
  });
  const order: string[] = [];
  let rawNow: Date | undefined;
  let viewNow: Date | undefined;
  dbMock.conversation.update.mockImplementation(async () => {
    order.push("title");
    return {};
  });
  dbMock.$executeRaw.mockImplementation(async (_s: unknown, ...values: unknown[]) => {
    order.push("bump");
    rawNow = values[0] as Date;
    return 1;
  });
  dbMock.conversationView.upsert.mockImplementation(async (arg: { create: { lastViewedAt: Date } }) => {
    order.push("view");
    viewNow = arg.create.lastViewedAt;
    return {};
  });

  const res = await post({ conversationId: "c1", message: "hello" });
  expect(res.status).toBe(200);
  // Title write ran and strictly before the raw updatedAt bump.
  expect(order.indexOf("title")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("title")).toBeLessThan(order.indexOf("bump"));
  // Bump and view share the exact same timestamp → updatedAt == lastViewedAt.
  expect(rawNow).toBeInstanceOf(Date);
  expect(viewNow).toBeInstanceOf(Date);
  expect(rawNow?.getTime()).toBe(viewNow?.getTime());
});

it("T4b: a conversation that already has a title skips the title write", async () => {
  dbMock.conversation.findUnique.mockResolvedValue({
    id: "c1", userId: "user-1", sessionKey: "app:plusim:user-1:c1",
    sectionContext: null, title: "existing", _count: { messages: 0 },
  });
  await post({ conversationId: "c1", message: "hello" });
  expect(dbMock.conversation.update).not.toHaveBeenCalled();
});
