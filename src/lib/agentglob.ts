// NOTE: @/lib/auth (Clerk) is imported LAZILY inside the one function that
// needs it, so this module stays loadable outside Next.js — the report worker
// (src/worker) reuses callAgent under plain tsx, where a top-level
// @clerk/nextjs/server import may not resolve.
const BASE = "https://app.agentglob.com";
const AGENT = process.env.AGENTGLOB_AGENT_NAME!;
const APP_KEY = process.env.AGENTGLOB_APP_API_KEY;

// Chat sessionKey format: app:<namespace>:<userId>:<conversationId>
// The <namespace> ("plusim") prevents key collisions across apps that share
// an AgentGlob agent. The agent derives <userId> as the component AFTER the
// namespace (split on ":" -> index 2) and keys each per-user file off it.
// Minted ONCE at conversation creation and stored in Conversation.sessionKey;
// conversations created before this change keep their original 3-part key
// (app:<userId>:<conversationId>), so continuity is preserved and the agent
// side must accept both the legacy 3-part and the namespaced 4-part forms.
export const APP_NAMESPACE = "plusim";
export function makeSessionKey(userId: string, conversationId: string): string {
  return `app:${APP_NAMESPACE}:${userId}:${conversationId}`;
}

export async function callAgent(opts: {
  sessionKey: string;
  message: string;
  model?: string;
  // Clerk userId — forwarded so the agent can persist per-user file sections
  // (save_user_section) keyed to this user. Same id used by getUserSection.
  appUserId?: string;
  // Abort after this many ms. Default 35s (interactive chat). Long server-side
  // jobs (e.g. summarizing a large transcript) pass a higher value.
  timeoutMs?: number;
}): Promise<{ reply: string; messageId?: string }> {
  const res = await fetch(`${BASE}/api/public/chat/${AGENT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Authenticate this app-user chat: the request carries appUserId + an
      // app: sessionKey, so AgentGlob requires the app key to prove we own the
      // "plusim" namespace (OB-18 / public-chat-app-identity). Same key the
      // user-file calls already send; safe to send now because the dashboard
      // accepts it (log-only) before it enforces (accept → send → require).
      ...(APP_KEY ? { authorization: `Bearer ${APP_KEY}` } : {}),
    },
    body: JSON.stringify({
      message: opts.message,
      sessionKey: opts.sessionKey,
      ...(opts.model && { model: opts.model }),
      ...(opts.appUserId && { appUserId: opts.appUserId }),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 35_000),
  });
  if (!res.ok) throw new Error(`agentglob ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // NOTE: the public API no longer returns message.id, so messageId is usually
  // undefined now. Kept optional for forward-compat; do not rely on it.
  return { reply: data.reply, messageId: data.message?.id };
}

let agentInfoCache: { data: AgentInfo; ts: number } | null = null;

export interface AgentInfo {
  displayName: string;
  emoji: string;
  iconImageUrl?: string;
  description?: string;
}

export async function getAgentInfo(): Promise<AgentInfo> {
  const now = Date.now();
  if (agentInfoCache && now - agentInfoCache.ts < 5 * 60 * 1000) {
    return agentInfoCache.data;
  }
  const res = await fetch(`${BASE}/api/public/chat/${AGENT}`, {
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error(`agentglob info ${res.status}`);
  const data: AgentInfo = await res.json();
  agentInfoCache = { data, ts: now };
  return data;
}

// ---------------------------------------------------------------------------
// Per-user workspace-file sections (e.g. "User_D_Prompt", "app_note").
//
// Reads a named section from the signed-in user's per-user file on the agent
// workspace, scoped by an app API key + userId. Read-only. Sections are
// HTML-comment-delimited inside the per-user file, keyed by the same userId as
// the chat sessionKey. Full contract: AGENTGLOB_USER_FILE_API.md.
//
// Returns null (→ graceful empty state) until AgentGlob ships the endpoint and
// issues AGENTGLOB_APP_API_KEY.
// ---------------------------------------------------------------------------
export async function getUserSection(
  userId: string | null | undefined,
  section: string,
  opts?: { noStore?: boolean; timeoutMs?: number },
): Promise<string | null> {
  if (!APP_KEY || !userId) return null;
  try {
    const url =
      `${BASE}/api/public/chat/${AGENT}/user-file` +
      `?userId=${encodeURIComponent(userId)}&section=${encodeURIComponent(section)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${APP_KEY}` },
      ...(opts?.noStore
        ? { cache: "no-store" as const }
        : { next: { revalidate: 60, tags: [`user-file:${userId}`] } }),
      // Bound the read so a slow dashboard never holds the home render (the
      // catch below returns null on timeout → graceful fallback).
      ...(opts?.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    if (!res.ok) return null; // endpoint absent / unauthorized today → graceful null
    const data = await res.json();
    return typeof data?.content === "string" ? data.content : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Raw whole-file read/write (admin section). Reads use the app read key; writes
// use a SEPARATE AGENTGLOB_APP_WRITE_KEY and require an If-Match etag. Backed by
// the dashboard's …/user-file/raw endpoint. See docs/ADMIN_SECTION_PLAN.md.
// ---------------------------------------------------------------------------
const WRITE_KEY = process.env.AGENTGLOB_APP_WRITE_KEY;

/** Max chars for a seeded display name (dashboard re-normalizes; it is authoritative). */
const APP_PROFILE_NAME_MAX = 200;

/**
 * Non-destructively seed the CURRENT Clerk user's app_profile `name:` from
 * their Clerk display name — only when the file has no name yet. Derives the
 * userId from the Clerk session (never takes a userId arg) so it can never be
 * pointed at another user. Best-effort: returns {ok:false} on any failure and
 * never throws and is bounded by a short timeout, so a slow/absent dashboard
 * never holds the home render for long (and the dashboard still completes the
 * write server-side even if the client aborts on timeout). The dashboard does
 * the parse/merge/clamp/CAS and is the source of
 * truth (it re-normalizes the name); this only pre-filters.
 */
export async function seedAppProfileNameIfMissing(
  name: string,
): Promise<{ ok: boolean; seeded?: boolean }> {
  if (!WRITE_KEY) return { ok: false };
  const { getCurrentUser } = await import("@/lib/auth");
  const userId = await getCurrentUser(); // Clerk session only — never a caller arg
  if (!userId) return { ok: false };
  const trimmed = (name ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!trimmed || trimmed.includes("<!-- app:")) return { ok: false };
  const capped = trimmed.slice(0, APP_PROFILE_NAME_MAX);
  try {
    const url = `${BASE}/api/public/chat/${AGENT}/user-file/seed-profile?userId=${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${WRITE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: capped }),
      cache: "no-store",
      signal: AbortSignal.timeout(2500), // bounded so first-contact render is not held
    });
    if (!res.ok) return { ok: false };
    const data = await res.json().catch(() => ({}));
    return { ok: true, seeded: Boolean(data?.seeded) };
  } catch {
    return { ok: false };
  }
}

export interface RawUserFile {
  content: string;
  etag: string;
  exists: boolean;
}

/** GET the whole raw per-user file. null on error / not configured. */
export async function getUserFileRaw(userId: string): Promise<RawUserFile | null> {
  if (!APP_KEY || !userId) return null;
  try {
    const url = `${BASE}/api/public/chat/${AGENT}/user-file/raw?userId=${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${APP_KEY}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      content: typeof data?.content === "string" ? data.content : "",
      etag: typeof data?.etag === "string" ? data.etag : "",
      exists: Boolean(data?.exists),
    };
  } catch {
    return null;
  }
}

export type SaveRawResult =
  | { ok: true; etag: string; fileUpdatedAt: string | null }
  | { ok: false; status: number; conflict?: boolean; currentEtag?: string; error?: string };

/** PUT the whole raw per-user file (admin). Requires the write key + If-Match. */
export async function saveUserFileRaw(
  userId: string,
  content: string,
  ifMatch: string,
  opts?: { force?: boolean; actor?: string },
): Promise<SaveRawResult> {
  if (!WRITE_KEY) return { ok: false, status: 500, error: "write key not configured" };
  if (!userId) return { ok: false, status: 400, error: "missing userId" };
  try {
    const force = opts?.force ? "&force=1" : "";
    const url = `${BASE}/api/public/chat/${AGENT}/user-file/raw?userId=${encodeURIComponent(userId)}${force}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${WRITE_KEY}`,
      "content-type": "application/json",
    };
    if (!opts?.force) headers["if-match"] = ifMatch;
    if (opts?.actor) headers["x-admin-actor"] = opts.actor;
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ content }),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return { ok: true, etag: typeof data?.etag === "string" ? data.etag : "", fileUpdatedAt: data?.fileUpdatedAt ?? null };
    }
    if (res.status === 409) {
      return { ok: false, status: 409, conflict: true, currentEtag: typeof data?.currentEtag === "string" ? data.currentEtag : "" };
    }
    return { ok: false, status: res.status, error: typeof data?.error === "string" ? data.error : `error ${res.status}` };
  } catch (e) {
    return { ok: false, status: 503, error: String(e) };
  }
}
