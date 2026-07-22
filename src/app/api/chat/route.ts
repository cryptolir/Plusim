import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { callAgent, makeSessionKey } from "@/lib/agentglob";
import { getSetting } from "@/lib/appSettings";
import { buildLinkedFolderContext } from "@/lib/pastMeeting";
import { AGENT_TIMEOUT_MS, CONTEXT_TIMEOUT_MS } from "@/lib/chatTimeouts";

const MAX_MESSAGE_LENGTH = 3000;

export async function POST(req: NextRequest) {
  // Phase 0: total timer starts at request ENTRY (before auth/rate-limit/parse)
  // so `totalMs` captures the full server-visible wait and `authMs` stays
  // recoverable as totalMs minus the named segments (Codex P2). The pre-agent
  // DB segment is marked separately below (`tDbStart`).
  const tStart = performance.now();

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

  // Pre-agent DB segment starts here (after auth/rate-limit/parse/validate,
  // which are captured in totalMs via the entry-time `tStart` above).
  const tDbStart = performance.now();

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
  const tPreContext = performance.now();

  // First-message preamble (invisible to the user). Precedence preserves today's
  // behavior exactly: the "past_meeting" pin and plain conversations always get
  // the user's linked-folder meeting context (null when none). The admin-set
  // global `chat_preamble` (if any) is PREPENDED to that context — it augments,
  // never replaces — so a blank `chat_preamble` is a no-op and never suppresses
  // the Drive-summary injection.
  let hint: string | null = null;
  let contextTimedOut = false;
  if (isFirstMessage) {
    const isPastMeeting = conversation.sectionContext === "past_meeting";
    // B1: the folder context is bounded (returns null past the deadline).
    // B2: read it in parallel with the preamble — but `getSetting` must NOT run
    // on `past_meeting` turns (precedence + chatPreamble.test.ts:85), so the
    // preamble slot resolves to null there. Precedence output is byte-identical
    // to the prior sequential form.
    const [folderContext, preamble] = await Promise.all([
      buildLinkedFolderContext(userId, {
        timeoutMs: CONTEXT_TIMEOUT_MS,
        onTimedOut: () => {
          contextTimedOut = true;
        },
      }),
      isPastMeeting ? Promise.resolve(null) : getSetting("chat_preamble"),
    ]);
    hint = isPastMeeting
      ? folderContext
      : [preamble, folderContext].filter(Boolean).join("\n\n") || null;
  }
  const outbound = hint
    ? `<<<context>>>\n${hint}\n<<<end_context>>>\n\nUser said: ${message}`
    : message;

  const tPreAgent = performance.now();
  const dbBeforeAgentMs = Math.round(tPreContext - tDbStart);
  const contextMs = Math.round(tPreAgent - tPreContext);

  let agentReply: string;
  let agentMessageId: string | undefined;
  try {
    const result = await callAgent({ sessionKey: conversation.sessionKey, message: outbound, appUserId: userId, timeoutMs: AGENT_TIMEOUT_MS });
    agentReply = result.reply;
    agentMessageId = result.messageId;
  } catch (err) {
    console.error("callAgent error:", err);
    console.info(
      "chat_latency_error",
      JSON.stringify({
        conversationId: conversation.id,
        isFirstMessage,
        hasContext: Boolean(hint),
        contextTimedOut,
        dbBeforeAgentMs,
        contextMs,
        agentMs: Math.round(performance.now() - tPreAgent),
        totalMs: Math.round(performance.now() - tStart),
        outboundChars: outbound.length,
      })
    );
    return NextResponse.json({ error: "Agent unavailable. Please try again." }, { status: 502 });
  }
  const tPostAgent = performance.now();

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

  const tEnd = performance.now();
  // One `chat_latency` line per successful turn. `contextTimedOut` is always
  // false until Phase B bounds the Drive context build; the field is emitted
  // now so the log shape is stable across the phased rollout.
  console.info(
    "chat_latency",
    JSON.stringify({
      conversationId: conversation.id,
      isFirstMessage,
      hasContext: Boolean(hint),
      contextTimedOut,
      dbBeforeAgentMs,
      contextMs,
      agentMs: Math.round(tPostAgent - tPreAgent),
      dbAfterAgentMs: Math.round(tEnd - tPostAgent),
      totalMs: Math.round(tEnd - tStart),
      outboundChars: outbound.length,
      replyChars: agentReply.length,
    })
  );

  return NextResponse.json({
    conversationId: conversation.id,
    userMessage,
    assistantMessage,
  });
}
