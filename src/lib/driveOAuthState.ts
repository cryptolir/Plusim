/**
 * Dedicated signed `state` token for the Google Drive OAuth connect flow.
 *
 * Separate from lib/adminSaveToken.ts (which is scoped to a target userId) — the
 * OAuth connect is not tied to a user file. Signed (HMAC-SHA256) with a dedicated
 * DRIVE_OAUTH_STATE_SECRET, short TTL, purpose-tagged. Replay is bounded by the
 * TTL and, more strongly, by Google invalidating the authorization `code` after
 * its first exchange — so a replayed (state, code) pair fails at token exchange.
 *
 * Token shape: <base64url(payload)>.<base64url(hmac)>
 *   payload = { p:"drive_oauth", e:adminEmail, n:nonce, iat, exp }
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TTL_MS = 10 * 60 * 1000;

function secret(): string {
  const s = process.env.DRIVE_OAUTH_STATE_SECRET;
  if (!s) throw new Error("DRIVE_OAUTH_STATE_SECRET not configured");
  return s;
}

interface StatePayload {
  p: "drive_oauth";
  e: string;
  n: string;
  iat: number;
  exp: number;
}

export function mintOAuthState(adminEmail: string): string {
  const payload: StatePayload = {
    p: "drive_oauth",
    e: adminEmail,
    n: randomBytes(8).toString("hex"),
    iat: Date.now(),
    exp: Date.now() + TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyOAuthState(state: string | null | undefined): { email: string } | null {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    if (payload.p !== "drive_oauth") return null;
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return { email: String(payload.e ?? "") };
  } catch {
    return null;
  }
}
