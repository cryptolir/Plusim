/**
 * Dual-auth for the reports admin API routes — same pattern as driveAuth.ts:
 * prefer the server-minted save token (scope "reports", minted on the reliably
 * authenticated admin page render), fall back to a live Clerk session +
 * ADMIN_EMAILS. Returns a 401/403 NextResponse when denied, else the actor.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkAdmin } from "@/lib/adminClerk";
import { verifySaveToken } from "@/lib/adminSaveToken";

export const REPORTS_TOKEN_SCOPE = "reports";

export async function authorizeReportsRequest(
  req: NextRequest,
): Promise<{ actor: string } | NextResponse> {
  const viaToken = verifySaveToken(req.headers.get("x-admin-save-token") ?? "", REPORTS_TOKEN_SCOPE);
  if (viaToken) return { actor: viaToken.email };
  const check = await checkAdmin();
  if (check.ok) return { actor: check.identity.email };
  return check.reason === "no-session"
    ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
    : NextResponse.json({ error: "forbidden" }, { status: 403 });
}
