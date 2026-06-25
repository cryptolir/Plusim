/**
 * Admin authorisation via Clerk.
 *
 * Instead of a separate username/password form, admin access is granted to any
 * Clerk-authenticated user whose primary email is in the ADMIN_EMAILS env var
 * (comma-separated). They sign in with their normal Plusim account (Google SSO
 * or email) and go straight to /admin — no second login needed.
 *
 * ADMIN_EMAILS=liran.peretz@gmail.com,other@example.com
 */
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

/** Resolved admin identity, or null if the request is not an admin. */
export interface AdminIdentity {
  userId: string;
  email: string;
}

/** Discriminated admin check so API routes can answer 401 vs 403 truthfully. */
export type AdminCheck =
  | { ok: true; identity: AdminIdentity }
  | { ok: false; reason: "no-session" | "not-admin" };

function getAllowedEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Server-component helper. Returns the admin's email if allowed, else redirects
 * to the Clerk sign-in page (if not signed in) or to / (signed in but not admin).
 */
export async function requireAdmin(): Promise<AdminIdentity> {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  const allowed = getAllowedEmails();

  if (!allowed.length || !allowed.includes(email)) {
    redirect("/?admin=denied");
  }
  return { userId, email };
}

/**
 * Route-handler helper. Distinguishes "no valid Clerk session" (the token on
 * the request was missing/expired → 401) from "signed in but not in
 * ADMIN_EMAILS" (→ 403), and logs which branch fired so prod failures are
 * diagnosable from Coolify logs.
 */
export async function checkAdmin(): Promise<AdminCheck> {
  const { userId } = await auth();
  if (!userId) {
    console.warn("[adminClerk] admin API call without a valid Clerk session (token missing or expired)");
    return { ok: false, reason: "no-session" };
  }

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  const allowed = getAllowedEmails();

  if (!allowed.length || !allowed.includes(email)) {
    console.warn(
      `[adminClerk] signed-in user is not an admin: ${email || "(no primary email)"} (allowlist size: ${allowed.length})`,
    );
    return { ok: false, reason: "not-admin" };
  }
  return { ok: true, identity: { userId, email } };
}

/** Back-compat shim over checkAdmin(). */
export async function getAdminIdentity(): Promise<AdminIdentity | null> {
  const check = await checkAdmin();
  return check.ok ? check.identity : null;
}
