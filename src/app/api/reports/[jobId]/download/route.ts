/**
 * Client xlsx download for a PUBLISHED report. Clerk-gated (middleware) and
 * ownership-checked: only the job's target user can fetch it.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { jobId } = await ctx.params;
  const job = await db.reportJob.findFirst({
    where: { id: jobId, targetUserId: userId, status: "published" },
    select: { id: true },
  });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  const artifact = await db.reportArtifact.findFirst({
    where: { jobId, kind: "xlsx" },
    orderBy: { createdAt: "desc" },
  });
  if (!artifact) return NextResponse.json({ error: "not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(artifact.bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${encodeURIComponent(artifact.filename)}"`,
      "cache-control": "private, no-store",
    },
  });
}
