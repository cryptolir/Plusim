import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

// Records that the current user has viewed a conversation (clears its "new
// activity" dot in the home-hub recent list). Upserts ConversationView.lastViewedAt
// WITHOUT touching Conversation.updatedAt, so opening a chat never reorders the list.
export async function POST(req: NextRequest) {
  const userId = await getCurrentUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { conversationId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  // Ownership check — only the conversation's owner may mark it viewed.
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true },
  });
  if (!conv || conv.userId !== userId) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  await db.conversationView.upsert({
    where: { conversationId },
    create: { conversationId, lastViewedAt: new Date() },
    update: { lastViewedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
