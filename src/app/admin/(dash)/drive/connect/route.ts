import { NextRequest, NextResponse } from "next/server";
import { checkAdmin } from "@/lib/adminClerk";
import { mintOAuthState } from "@/lib/driveOAuthState";
import { buildConsentUrl } from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

function appOrigin(req: NextRequest): string {
  try {
    return new URL(process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "").origin;
  } catch {
    return new URL(req.url).origin;
  }
}

// GET /admin/drive/connect — top-level navigation (Clerk session present), so
// middleware auth.protect() guards it; we also enforce ADMIN_EMAILS here. Mints
// a dedicated OAuth state token and 302s to Google's consent screen.
export async function GET(req: NextRequest) {
  const check = await checkAdmin();
  if (!check.ok) return NextResponse.redirect(new URL("/admin", appOrigin(req)));
  const state = mintOAuthState(check.identity.email);
  return NextResponse.redirect(buildConsentUrl(state));
}
