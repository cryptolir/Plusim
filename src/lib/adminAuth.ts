/**
 * Admin-section auth — separate from Clerk (admins are not app users).
 *
 * Credentials come from env. Dev defaults (Admin1 / Admin123) exist ONLY when
 * not in production; production fails closed unless a credential source AND a
 * session secret are configured. Password is verified against a scrypt hash
 * (ADMIN_PASSWORD_HASH, preferred) or a plaintext fallback (dev). The session is
 * a signed (HMAC-SHA256) httpOnly cookie scoped to /admin.
 */
import crypto from "node:crypto";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "plusim_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const isProd = process.env.NODE_ENV === "production";

function getUsername(): string {
  return process.env.ADMIN_USERNAME ?? (isProd ? "" : "Admin1");
}

function getSessionSecret(): string | null {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (s) return s;
  return isProd ? null : "dev-insecure-admin-secret"; // fail closed in prod
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** scrypt hash format: `scrypt$<saltHex>$<hashHex>`. */
function verifyScrypt(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = crypto.scryptSync(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function verifyPassword(password: string): boolean {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (hash) return verifyScrypt(password, hash);
  const plain = process.env.ADMIN_PASSWORD ?? (isProd ? "" : "Admin123");
  if (!plain) return false; // prod + no hash/password → fail closed
  return timingSafeEqualStr(password, plain);
}

/** True only when admin login is usable on this environment. */
export function adminConfigured(): boolean {
  if (!getSessionSecret()) return false;
  if (!getUsername()) return false;
  if (isProd && !process.env.ADMIN_PASSWORD_HASH && !process.env.ADMIN_PASSWORD) return false;
  return true;
}

export function verifyCredentials(username: string, password: string): boolean {
  if (!adminConfigured()) return false;
  // Evaluate both sides regardless to keep timing roughly constant.
  const okUser = timingSafeEqualStr(username, getUsername());
  const okPass = verifyPassword(password);
  return okUser && okPass;
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(username: string): string | null {
  const secret = getSessionSecret();
  if (!secret) return null;
  const payload = `${encodeURIComponent(username)}.${Date.now() + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const secret = getSessionSecret();
  if (!secret) return null;
  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const dot = payload.indexOf(".");
  if (dot === -1) return null;
  const exp = Number(payload.slice(dot + 1));
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return decodeURIComponent(payload.slice(0, dot));
}

export async function setAdminCookie(username: string): Promise<boolean> {
  const token = createSessionToken(username);
  if (!token) return false;
  const c = await cookies();
  c.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    path: "/admin",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return true;
}

export async function clearAdminCookie(): Promise<void> {
  const c = await cookies();
  c.set(ADMIN_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: isProd, path: "/admin", maxAge: 0 });
}

/** The admin username if the request carries a valid session, else null. */
export async function getAdminSession(): Promise<string | null> {
  const c = await cookies();
  return verifySessionToken(c.get(ADMIN_COOKIE)?.value);
}
