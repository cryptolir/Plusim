/**
 * Dual-auth for Drive admin API routes (background fetches from the browser).
 *
 * Prefers the server-minted save token (scoped to the literal "drive"), minted
 * on the reliably-authenticated admin page render — immune to the stale
 * test-mode Clerk session problem. Falls back to a live Clerk session +
 * ADMIN_EMAILS. Returns a 401/403 NextResponse when denied, else null.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkAdmin } from "@/lib/adminClerk";
import { verifySaveToken } from "@/lib/adminSaveToken";

export const DRIVE_TOKEN_SCOPE = "drive";

export async function authorizeDriveRequest(req: NextRequest): Promise<NextResponse | null> {
  if (verifySaveToken(req.headers.get("x-admin-save-token") ?? "", DRIVE_TOKEN_SCOPE)) return null;
  const check = await checkAdmin();
  if (check.ok) return null;
  return check.reason === "no-session"
    ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
    : NextResponse.json({ error: "forbidden" }, { status: 403 });
}
