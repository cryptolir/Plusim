/**
 * Agent-facing statement download. GET /api/agent/jobs/:jobId/files/:fileId?t=…
 * Same auth as the manifest; fileId must belong to the job (404 otherwise).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAgentJobRequest } from "@/lib/agentRuntimeAuth";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string; fileId: string }> },
) {
  const { jobId, fileId } = await ctx.params;
  const auth = await authorizeAgentJobRequest(req, jobId);
  if (auth instanceof NextResponse) return auth;

  const file = await db.statementFile.findFirst({
    where: { id: fileId, jobId },
  });
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.mime,
      "content-length": String(file.size),
      "content-disposition": `attachment; filename="${encodeURIComponent(file.filename)}"`,
      "cache-control": "no-store",
    },
  });
}
