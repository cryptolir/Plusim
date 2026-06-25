/**
 * Short-lived signed token authorising admin file saves.
 *
 * Why this exists: prod currently runs a Clerk *development* instance
 * (pk_test/sk_test) on the live domain, where the 60-second session JWT often
 * cannot be silently refreshed by the browser SDK. Page navigations still
 * authenticate (Clerk's handshake redirect re-mints the token), but background
 * fetch() calls arrive with an expired token and get 401'd by the middleware —
 * so saving from the admin editor always "session-expires".
 *
 * The admin page render IS reliably authenticated (requireAdmin passes), so it
 * mints this HMAC token server-side and hands it to the editor; the save API
 * accepts it instead of a live Clerk session. Scoped to one target userId,
 * expires after TTL_MS. Signed with CLERK_SECRET_KEY (server-only, high
 * entropy) to avoid introducing a new secret.
 *
 * This whole module can be deleted once prod moves to a production Clerk
 * instance (pk_live/sk_live) and session refresh works.
 */
import crypto from "crypto";

const SECRET = process.env.CLERK_SECRET_KEY ?? "";
const TTL_MS = 60 * 60 * 1000; // 1 hour — reload the page to re-arm after that

function hmac(data: string): string {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

export function mintSaveToken(adminEmail: string, targetUserId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ e: adminEmail, u: targetUserId, x: Date.now() + TTL_MS }),
  ).toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

export function verifySaveToken(
  token: string,
  targetUserId: string,
): { email: string } | null {
  if (!SECRET || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(payload));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;

  let data: { e?: unknown; u?: unknown; x?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof data.e !== "string" || typeof data.u !== "string" || typeof data.x !== "number") {
    return null;
  }
  if (data.u !== targetUserId) return null;
  if (Date.now() > data.x) return null;
  return { email: data.e };
}
