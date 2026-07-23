/**
 * Pure decision logic for the bounded pending-reply pickup (P2).
 *
 * Extracted as pure functions with NO React/DOM/fetch so they run in the repo's
 * node-env vitest suite (there is no component-test infra). The stateful timers,
 * fetches, and the shared cancel/generation guard live in `plusimRuntime.ts`;
 * everything that decides "is there a reply to wait for, and has it arrived?"
 * lives here. See docs/plans/chat-bootstrap.md (P2).
 */

export interface PickupRow {
  id: string;
  role: string;
  createdAt: string | number | Date;
}

function ms(v: string | number | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

export interface InitialPickup {
  pending: boolean;
  pendingId?: string;
  pendingCreatedAtMs?: number;
  /** Server-anchored time left in the bounded window (ms). */
  remainingMs?: number;
}

/**
 * On a freshly-hydrated `?cid` transcript, decide whether the last row is a lone
 * pending user turn worth picking up, and how much of the bounded window is left.
 *
 * Age is derived from SERVER time only (`serverNowMs − pendingTurn.createdAt`,
 * both DB-server clock) so neither browser-clock direction can shrink or extend
 * the window (Rev 12). The pickup runs ONLY when the captured pending turn is the
 * SOLE trailing unanswered turn — an earlier unanswered user row (a concurrent
 * multi-tab send or a failed-retry orphan) makes the adjacent-assistant
 * completion rule ambiguous, so we back off (Rev 21/22).
 */
export function initialPickupState(
  rows: PickupRow[],
  serverNowMs: number,
  windowMs: number,
): InitialPickup {
  if (rows.length === 0) return { pending: false };
  const last = rows[rows.length - 1];
  if (last.role !== "user") return { pending: false }; // already answered / empty
  const prev = rows[rows.length - 2];
  if (prev && prev.role === "user") return { pending: false }; // ≥2 trailing unanswered ⇒ ambiguous
  const pendingCreatedAtMs = ms(last.createdAt);
  const age = serverNowMs - pendingCreatedAtMs;
  const remainingMs = Math.min(Math.max(windowMs - age, 0), windowMs);
  if (remainingMs <= 0) return { pending: false }; // stale turn ⇒ no poll
  return { pending: true, pendingId: last.id, pendingCreatedAtMs, remainingMs };
}

export type PollOutcome = "complete" | "keep-polling" | "stop";

/**
 * Positional completion (Rev 5/13/21): completion = the row IMMEDIATELY AFTER the
 * captured pending turn is its adjacent `assistant` reply. Any ambiguity — the
 * pending row vanished, an intervening/earlier `user` row (concurrent tab), or a
 * `createdAt` tie adjacent to the captured turn (ms-precision collision) — ⇒
 * `stop` silently and fall back to normal reopen; never hydrate a wrong reply.
 */
export function pollOutcome(
  rows: PickupRow[],
  pendingId: string,
  pendingCreatedAtMs: number,
): PollOutcome {
  const i = rows.findIndex((r) => r.id === pendingId);
  if (i === -1) return "stop"; // transcript changed out from under us
  const prev = rows[i - 1];
  if (prev && prev.role === "user") return "stop"; // earlier unanswered turn ⇒ ambiguous
  const next = rows[i + 1];
  if (!next) return "keep-polling"; // still the last row ⇒ reply not written yet
  if (next.role === "user") return "stop"; // concurrent intervening turn ⇒ ambiguous
  if (ms(next.createdAt) === pendingCreatedAtMs) return "stop"; // timestamp tie ⇒ ambiguous
  return "complete"; // unambiguous adjacent assistant reply
}
