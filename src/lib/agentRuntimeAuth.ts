/**
 * Auth for the agent-facing runtime routes (/api/agent/jobs/*).
 *
 * Two layers, both required:
 *  1. Static bearer — PLUSIM_AGENT_RUNTIME_TOKEN, the same secret set in the
 *     AgentGlob workspace as PLUSIM_RUNTIME_TOKEN. Proves "this is onlyclaw".
 *  2. Per-job token — random 32 bytes minted at dispatch, carried as `?t=` on
 *     the manifest URL sent to the agent. Only its sha256 is stored
 *     (ReportJob.agentTokenHash) with a TTL. Scopes a run to one job.
 *
 * These routes are middleware-public (see src/proxy.ts) because the caller is
 * a server, not a browser session — so this module IS the security boundary.
 */
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

const JOB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — admin re-dispatch re-mints

function staticToken(): string {
  return process.env.PLUSIM_AGENT_RUNTIME_TOKEN ?? "";
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** Mint a fresh per-job token; caller persists the returned hash + expiry. */
export function mintJobToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + JOB_TOKEN_TTL_MS),
  };
}

export interface AgentJobAuth {
  job: {
    id: string;
    targetUserId: string;
    status: string;
  };
  /** sha256 of the presented per-job token (== stored agentTokenHash). Lets the
   *  result callback do a conditional write keyed on the exact token that
   *  authorized, so a publish/re-dispatch between auth and write can't be clobbered. */
  tokenHash: string;
}

/**
 * Authorize an agent request against a specific job. Returns the job on
 * success, or a NextResponse (401/404) to return as-is. 404 (not 403) for
 * unknown/expired jobs so probing can't distinguish existence.
 */
export async function authorizeAgentJobRequest(
  req: NextRequest,
  jobId: string,
): Promise<AgentJobAuth | NextResponse> {
  const expected = staticToken();
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || !bearer || !timingSafeEqualStr(bearer, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t = new URL(req.url).searchParams.get("t") ?? "";
  if (!t || !jobId) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = await db.reportJob.findUnique({
    where: { id: jobId },
    select: { id: true, targetUserId: true, status: true, agentTokenHash: true, agentTokenExpiresAt: true },
  });
  if (
    !job ||
    !job.agentTokenHash ||
    !job.agentTokenExpiresAt ||
    job.agentTokenExpiresAt.getTime() < Date.now() ||
    !timingSafeEqualStr(sha256Hex(t), job.agentTokenHash)
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return {
    job: { id: job.id, targetUserId: job.targetUserId, status: job.status },
    tokenHash: job.agentTokenHash,
  };
}

/** Absolute base URL for links handed to the agent (manifest, files, callback). */
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "https://plusim.xyz").replace(/\/+$/, "");
}
