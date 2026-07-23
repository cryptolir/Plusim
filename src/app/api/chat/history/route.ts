import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const userId = await getCurrentUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conversationId = req.nextUrl.searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Deterministic total order (Rev 13): `createdAt` is millisecond precision, so
  // concurrent inserts can tie; the secondary `id` key gives the pending-reply
  // pickup a stable "row immediately after" for its positional completion rule.
  const messages = await db.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // `serverNow` anchors the pickup window to the DB/server clock (Rev 12): the
  // client derives `age = serverNow − pendingTurn.createdAt` (both server-clock,
  // skew-free) instead of reading its own wall clock, so neither browser-clock
  // direction can shrink or extend the bounded window.
  return NextResponse.json({ messages, serverNow: new Date().toISOString() });
}
