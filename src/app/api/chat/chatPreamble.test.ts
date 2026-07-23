/**
 * First-message preamble precedence (Codex review P2). Guards the regression
 * where "blank chat_preamble → no preamble" would have suppressed the Drive
 * meeting-summary context that plain chats get today. The admin chat_preamble
 * AUGMENTS that context (prepended), never replaces it, and past_meeting keeps
 * routing straight to the folder context.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => "user-1") }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/db", () => ({
  db: {
    conversation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    message: { count: vi.fn(async () => 0), create: vi.fn(async () => ({ id: "m" })) },
    conversationView: { upsert: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
vi.mock("@/lib/agentglob", () => ({
  callAgent: vi.fn(async () => ({ reply: "ok" })),
  makeSessionKey: (u: string, c: string) => `app:plusim:${u}:${c}`,
}));
vi.mock("@/lib/appSettings", () => ({ getSetting: vi.fn() }));
vi.mock("@/lib/pastMeeting", () => ({ buildLinkedFolderContext: vi.fn() }));

import { db } from "@/lib/db";
import { callAgent } from "@/lib/agentglob";
import { getSetting } from "@/lib/appSettings";
import { buildLinkedFolderContext } from "@/lib/pastMeeting";
import { POST } from "./route";

const convFind = db.conversation.findUnique as unknown as ReturnType<typeof vi.fn>;
const agent = callAgent as unknown as ReturnType<typeof vi.fn>;
const setting = getSetting as unknown as ReturnType<typeof vi.fn>;
const folderCtx = buildLinkedFolderContext as unknown as ReturnType<typeof vi.fn>;

/** Run one first-message POST and return the message actually sent to the agent. */
async function outbound(opts: {
  sectionContext: string | null;
  preamble: string | null;
  folder: string | null;
}): Promise<string> {
  convFind.mockResolvedValue({
    id: "c1",
    userId: "user-1",
    sessionKey: "app:plusim:user-1:c1",
    sectionContext: opts.sectionContext,
  });
  setting.mockResolvedValue(opts.preamble);
  folderCtx.mockResolvedValue(opts.folder);
  const req = new NextRequest("https://plusim.xyz/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "c1", message: "hi" }),
  });
  await POST(req);
  return agent.mock.calls[0][0].message as string;
}

beforeEach(() => vi.clearAllMocks());

it("blank preamble + linked folder → folder context is preserved (P2)", async () => {
  const msg = await outbound({ sectionContext: null, preamble: null, folder: "FOLDER" });
  expect(msg).toContain("FOLDER");
  expect(msg).toBe("<<<context>>>\nFOLDER\n<<<end_context>>>\n\nUser said: hi");
});

it("preamble set + linked folder → preamble prepended to the folder context", async () => {
  const msg = await outbound({ sectionContext: null, preamble: "PRE", folder: "FOLDER" });
  expect(msg).toContain("PRE");
  expect(msg).toContain("FOLDER");
  expect(msg.indexOf("PRE")).toBeLessThan(msg.indexOf("FOLDER"));
});

it("blank preamble + no folder → no context wrapper (raw message)", async () => {
  const msg = await outbound({ sectionContext: null, preamble: null, folder: null });
  expect(msg).toBe("hi");
});

it("past_meeting routes to the folder context and never applies chat_preamble", async () => {
  const msg = await outbound({ sectionContext: "past_meeting", preamble: "PRE", folder: "FOLDER" });
  expect(msg).toBe("<<<context>>>\nFOLDER\n<<<end_context>>>\n\nUser said: hi");
  expect(setting).not.toHaveBeenCalled();
});

/**
 * T1b (P1d) — the first-turn context is keyed on "no assistant reply persisted
 * yet" (the filtered `_count.messages`), not "no messages". A first turn that
 * 502'd leaves an orphan user row (0 assistants), and the retry must STILL inject
 * the meeting/Drive context; a turn that already has a reply must not.
 */
async function outboundWithReplies(assistantCount: number): Promise<string> {
  convFind.mockResolvedValue({
    id: "c1",
    userId: "user-1",
    sessionKey: "app:plusim:user-1:c1",
    sectionContext: "past_meeting",
    title: "t",
    _count: { messages: assistantCount },
  });
  setting.mockResolvedValue(null);
  folderCtx.mockResolvedValue("FOLDER");
  const req = new NextRequest("https://plusim.xyz/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "c1", message: "hi" }),
  });
  await POST(req);
  return agent.mock.calls[0][0].message as string;
}

it("orphan user row (0 assistant replies) → context is re-injected on retry (T1b)", async () => {
  const msg = await outboundWithReplies(0);
  expect(msg).toBe("<<<context>>>\nFOLDER\n<<<end_context>>>\n\nUser said: hi");
});

it("a turn that already has a reply (≥1 assistant) → no context re-injection (T1b)", async () => {
  const msg = await outboundWithReplies(1);
  expect(msg).toBe("hi");
  expect(folderCtx).not.toHaveBeenCalled();
});
