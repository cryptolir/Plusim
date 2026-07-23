/**
 * TB1–TB3 — the pure decision logic for the bounded pending-reply pickup.
 * Runs in the node-env suite (no DOM); the stateful timers/fetches/cancel guard
 * live in plusimRuntime.ts and are exercised manually (TB6 E2E).
 */
import { describe, it, expect } from "vitest";
import { initialPickupState, pollOutcome } from "./pendingReplyPickup";

const WINDOW = 95_000;
const t = (isoSecond: number) => new Date(isoSecond * 1000).toISOString();

describe("initialPickupState (TB1/TB2)", () => {
  it("lone fresh pending user turn → pending with a clamped remaining window", () => {
    const rows = [
      { id: "a1", role: "assistant", createdAt: t(100) },
      { id: "u2", role: "user", createdAt: t(200) },
    ];
    // serverNow 10s after the pending turn → ~85s left.
    const res = initialPickupState(rows, 210_000, WINDOW);
    expect(res.pending).toBe(true);
    expect(res.pendingId).toBe("u2");
    expect(res.remainingMs).toBeGreaterThan(80_000);
    expect(res.remainingMs).toBeLessThanOrEqual(WINDOW);
  });

  it("last row is an assistant (already answered) → not pending", () => {
    const rows = [
      { id: "u1", role: "user", createdAt: t(100) },
      { id: "a1", role: "assistant", createdAt: t(101) },
    ];
    expect(initialPickupState(rows, 200_000, WINDOW).pending).toBe(false);
  });

  it("two trailing unanswered user rows (multi-tab / failed-retry orphan) → not pending", () => {
    const rows = [
      { id: "u1", role: "user", createdAt: t(100) },
      { id: "u2", role: "user", createdAt: t(101) },
    ];
    expect(initialPickupState(rows, 101_000, WINDOW).pending).toBe(false);
  });

  it("stale turn (age ≥ window) → not pending (no poll), regardless of client clock", () => {
    const rows = [{ id: "u1", role: "user", createdAt: t(0) }];
    // serverNow is 2× the window past the turn.
    expect(initialPickupState(rows, 2 * WINDOW, WINDOW).pending).toBe(false);
  });

  it("server-anchored age: a fresh turn gets its full window (ahead client clock is irrelevant)", () => {
    const rows = [{ id: "u1", role: "user", createdAt: t(500) }];
    // serverNow == createdAt → full window, whatever the browser clock reads.
    const res = initialPickupState(rows, 500_000, WINDOW);
    expect(res.pending).toBe(true);
    expect(res.remainingMs).toBe(WINDOW);
  });

  it("empty history → not pending", () => {
    expect(initialPickupState([], 1_000, WINDOW).pending).toBe(false);
  });
});

describe("pollOutcome (TB1)", () => {
  const pendingCreatedAt = 200_000;
  const base = [
    { id: "a0", role: "assistant", createdAt: t(100) },
    { id: "u2", role: "user", createdAt: t(200) }, // captured pending turn
  ];

  it("pending turn still the last row → keep-polling", () => {
    expect(pollOutcome(base, "u2", pendingCreatedAt)).toBe("keep-polling");
  });

  it("adjacent assistant with a strictly later timestamp → complete", () => {
    const rows = [...base, { id: "a2", role: "assistant", createdAt: t(205) }];
    expect(pollOutcome(rows, "u2", pendingCreatedAt)).toBe("complete");
  });

  it("intervening user row (concurrent tab) → stop", () => {
    const rows = [...base, { id: "u3", role: "user", createdAt: t(203) }];
    expect(pollOutcome(rows, "u2", pendingCreatedAt)).toBe("stop");
  });

  it("mixed history with older assistant rows but no successor → keep-polling", () => {
    // Older assistant (a0) exists — 'an assistant row exists' must NOT complete.
    expect(pollOutcome(base, "u2", pendingCreatedAt)).toBe("keep-polling");
  });

  it("pendingUser, laterUser, laterAssistant → stop (successor is a user)", () => {
    const rows = [
      { id: "u2", role: "user", createdAt: t(200) },
      { id: "u3", role: "user", createdAt: t(201) },
      { id: "a3", role: "assistant", createdAt: t(202) },
    ];
    expect(pollOutcome(rows, "u2", pendingCreatedAt)).toBe("stop");
  });

  it("earlier unanswered turn: U1, U2(captured), A1 → stop (A1 may be U1's reply)", () => {
    const rows = [
      { id: "u1", role: "user", createdAt: t(199) },
      { id: "u2", role: "user", createdAt: t(200) },
      { id: "a1", role: "assistant", createdAt: t(201) },
    ];
    expect(pollOutcome(rows, "u2", pendingCreatedAt)).toBe("stop");
  });

  it("timestamp tie between the pending turn and its successor → stop (ambiguous)", () => {
    const rows = [...base, { id: "a2", role: "assistant", createdAt: t(200) }];
    expect(pollOutcome(rows, "u2", pendingCreatedAt)).toBe("stop");
  });

  it("captured pending row vanished from the transcript → stop", () => {
    const rows = [{ id: "a0", role: "assistant", createdAt: t(100) }];
    expect(pollOutcome(rows, "u2", pendingCreatedAt)).toBe("stop");
  });
});
