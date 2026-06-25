import { NextRequest, NextResponse } from "next/server";
import { verifyOAuthState } from "@/lib/driveOAuthState";
import { exchangeCodeAndStore } from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

// Behind Traefik, req.url reflects the container's internal host
// (http://localhost:3000), so user-facing redirects must be built against the
// public origin — derived deterministically from GOOGLE_OAUTH_REDIRECT_URI.
function appOrigin(req: NextRequest): string {
  try {
    return new URL(process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "").origin;
  } catch {
    return new URL(req.url).origin;
  }
}

// GET /admin/api/drive/callback — Google redirects here. Lives under /admin/api
// (middleware-public) because a top-level Google redirect carries no reliable
// Clerk cookie; auth rests on verifying the signed `state` token. The OAuth
// `code` is single-use at Google, so a replayed (state, code) fails the exchange.
export async function GET(req: NextRequest) {
  const base = appOrigin(req);
  const url = new URL(req.url);

  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(new URL(`/admin/drive?error=${encodeURIComponent(error)}`, base));
  }
  const state = url.searchParams.get("state");
  if (!verifyOAuthState(state)) {
    return NextResponse.redirect(new URL("/admin/drive?error=bad_state", base));
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/admin/drive?error=missing_code", base));
  }
  try {
    await exchangeCodeAndStore(code);
    return NextResponse.redirect(new URL("/admin/drive?connected=1", base));
  } catch (e) {
    console.error("[drive/callback]", e instanceof Error ? e.message : e);
    return NextResponse.redirect(new URL("/admin/drive?error=exchange_failed", base));
  }
}
