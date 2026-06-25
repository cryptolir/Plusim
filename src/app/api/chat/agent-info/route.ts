import { NextResponse } from "next/server";
import { getAgentInfo } from "@/lib/agentglob";

export async function GET() {
  try {
    const info = await getAgentInfo();
    return NextResponse.json(info);
  } catch (err) {
    console.error("agent-info error:", err);
    return NextResponse.json({ error: "Failed to fetch agent info" }, { status: 502 });
  }
}
