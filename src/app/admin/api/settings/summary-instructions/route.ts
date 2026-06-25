import { NextRequest, NextResponse } from "next/server";
import { authorizeDriveRequest } from "@/lib/driveAuth";
import { setSummaryInstructions } from "@/lib/summaryInstructions";

export const dynamic = "force-dynamic";

const MAX_CHARS = 20_000;

export async function PUT(req: NextRequest) {
  const denied = await authorizeDriveRequest(req);
  if (denied) return denied;

  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.text !== "string") {
    return NextResponse.json({ error: "missing text" }, { status: 400 });
  }
  if (body.text.length > MAX_CHARS) {
    return NextResponse.json({ error: "instructions too long" }, { status: 413 });
  }

  await setSummaryInstructions(body.text);
  return NextResponse.json({ ok: true });
}
