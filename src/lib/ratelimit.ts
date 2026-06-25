const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

const store = new Map<string, { count: number; windowStart: number }>();

export function rateLimit(userId: string): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = store.get(userId);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    store.set(userId, { count: 1, windowStart: now });
    return { ok: true };
  }

  if (entry.count >= MAX_PER_WINDOW) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { ok: false, retryAfter };
  }

  entry.count++;
  return { ok: true };
}

// ── Admin login limiter (keyed by IP + username) ─────────────────────────────
// The user-scoped rateLimit() above is unsuitable for login (no user yet, and
// its 20/min budget is too lenient for a password form). This is stricter and
// keyed by the attempt's IP + username so one bad client can't lock out others.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX = 5;
const loginStore = new Map<string, { count: number; windowStart: number }>();

export function loginRateLimit(ip: string, username: string): { ok: boolean; retryAfter?: number } {
  const key = `${ip}:${username.toLowerCase()}`;
  const now = Date.now();
  const entry = loginStore.get(key);

  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginStore.set(key, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (entry.count >= LOGIN_MAX) {
    return { ok: false, retryAfter: Math.ceil((LOGIN_WINDOW_MS - (now - entry.windowStart)) / 1000) };
  }
  entry.count++;
  return { ok: true };
}
