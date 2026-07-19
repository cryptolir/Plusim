import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/api/chat/agent-info",
  "/api/health",
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Admin PAGES stay Clerk-gated (intentionally not listed). The admin API is
  // listed so the save PUT reaches its handler, which enforces its own auth:
  // a server-minted HMAC save token (lib/adminSaveToken.ts), with a Clerk
  // session as fallback. Needed because the test-mode Clerk instance can't
  // refresh session JWTs for background fetches — auth.protect() here would
  // 401 every save. Remove this entry once prod runs pk_live/sk_live keys.
  "/admin/api(.*)",
  // Agent runtime routes: server-to-server (onlyclaw → app). No browser session
  // exists on these calls; the handlers enforce their own bearer + per-job
  // token auth (lib/agentRuntimeAuth.ts).
  "/api/agent(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
