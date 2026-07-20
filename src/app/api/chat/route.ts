import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { callAgent, makeSessionKey } from "@/lib/agentglob";
import { getSetting } from "@/lib/appSettings";
import { buildLinkedFolderContext } from "@/lib/pastMeeting";

const MAX_MESSAGE_LENGTH = 3000;

export async function POST(req: NextRequest) {
  const userId = await getCurrentUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit(userId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many messages. Please wait before sending more." },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfter ?? 60) },
      }
    );
  }

  let body: { conversationId?: string; message?: string; sectionContext?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { conversationId, message, sectionContext } = body;

  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` },
      { status: 400 }
    );
  }

  let conversation;
  if (conversationId) {
    conversation = await db.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.userId !== userId) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
  } else {
    const id = crypto.randomUUID();
    const sessionKey = makeSessionKey(userId, id);
    const agentName = process.env.AGENTGLOB_AGENT_NAME ?? "onlyclaw";
    conversation = await db.conversation.create({
      data: {
        id,
        userId,
        sessionKey,
        agentName,
        sectionContext: sectionContext ?? null,
        title: message.slice(0, 80),
      },
    });
  }

  const existingMessages = await db.message.count({
    where: { conversationId: conversation.id },
  });
  const isFirstMessage = existingMessages === 0;

  const userMessage = await db.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: message,
    },
  });

  // First-message preamble (invisible to the user). Precedence preserves today's
  // behavior exactly: the "past_meeting" pin and plain conversations always get
  // the user's linked-folder meeting context (null when none). The admin-set
  // global `chat_preamble` (if any) is PREPENDED to that context — it augments,
  // never replaces — so a blank `chat_preamble` is a no-op and never suppresses
  // the Drive-summary injection.
  let hint: string | null = null;
  if (isFirstMessage) {
    const folderContext = await buildLinkedFolderContext(userId);
    if (conversation.sectionContext === "past_meeting") {
      hint = folderContext;
    } else {
      const preamble = await getSetting("chat_preamble");
      hint = [preamble, folderContext].filter(Boolean).join("\n\n") || null;
    }
  }
  const outbound = hint
    ? `<<<context>>>\n${hint}\n<<<end_context>>>\n\nUser said: ${message}`
    : message;

  let agentReply: string;
  let agentMessageId: string | undefined;
  try {
    const result = await callAgent({ sessionKey: conversation.sessionKey, message: outbound, appUserId: userId, timeoutMs: 90_000 });
    agentReply = result.reply;
    agentMessageId = result.messageId;
  } catch (err) {
    console.error("callAgent error:", err);
    return NextResponse.json({ error: "Agent unavailable. Please try again." }, { status: 502 });
  }

  // One timestamp shared by the recency bump and the view marker, so the chat
  // just used reads as updatedAt == lastViewedAt (never spuriously "unread").
  const now = new Date();
  // Title on the first message only.
  if (isFirstMessage) {
    await db.conversation.update({
      where: { id: conversation.id },
      data: { title: message.slice(0, 80) },
    });
  }
  // Bump updatedAt to `now` so the recent list orders by activity (creating a
  // Message does NOT touch the parent Conversation). Raw SQL because Prisma's
  // @updatedAt would override an explicit value with its own timestamp.
  await db.$executeRaw`UPDATE "Conversation" SET "updatedAt" = ${now} WHERE "id" = ${conversation.id}`;
  // Mark the conversation viewed (clears the "new activity" dot) with the same `now`.
  await db.conversationView.upsert({
    where: { conversationId: conversation.id },
    create: { conversationId: conversation.id, lastViewedAt: now },
    update: { lastViewedAt: now },
  });

  const assistantMessage = await db.message.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: agentReply,
      agentglobMessageId: agentMessageId ?? null,
    },
  });

  return NextResponse.json({
    conversationId: conversation.id,
    userMessage,
    assistantMessage,
  });
}
