import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { makeSessionKey } from "@/lib/agentglob";

export async function POST(req: NextRequest) {
  const userId = await getCurrentUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sectionContext: string | null = body.sectionContext ?? null;

  const conversationId = crypto.randomUUID();
  const sessionKey = makeSessionKey(userId, conversationId);
  const agentName = process.env.AGENTGLOB_AGENT_NAME ?? "onlyclaw";

  const conversation = await db.conversation.create({
    data: {
      id: conversationId,
      userId,
      sessionKey,
      agentName,
      sectionContext,
    },
  });

  // Prune the user's older empty placeholder conversations: new-session creates a
  // Conversation before any message is sent, so bare /chat visits would otherwise
  // accumulate cruft. Age-guarded (>1 day) so a placeholder a concurrent tab just
  // created (whose cid is live in its URL) is never deleted out from under it.
  // Best-effort — a prune failure must never block session creation.
  try {
    await db.conversation.deleteMany({
      where: {
        userId,
        messages: { none: {} },
        id: { not: conversationId },
        createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
  } catch {
    // non-fatal
  }

  // P3 (Rev 2): the awaited `getAgentInfo()` was dropped — new-session's only
  // caller (`chat/page.tsx`) reads `conversationId` and discards `agentInfo`, so
  // blocking the bootstrap response on an external AgentGlob round trip only
  // widened the bare-load gate window for no consumer.
  return NextResponse.json({ conversationId: conversation.id });
}
