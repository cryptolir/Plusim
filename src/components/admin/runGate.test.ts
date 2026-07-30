/**
 * Pure logic extracted from ReportJobDetail (round 7, F30) so it is testable
 * without a component-test harness (none exists in this repo). Plan-adjacent
 * tests: running stays true regardless of staleness (it gates the upload
 * control, which the server 409s unconditionally for any in-flight status);
 * rerunLocked is the only thing staleness affects (F28); processing never
 * reopens (the worker sweep owns that recovery, not the admin button).
 */
import { it, expect } from "vitest";
import { computeRunGate } from "./ReportJobDetail";

const NOW = new Date("2026-07-30T12:00:00.000Z").getTime();
const FRESH = new Date("2026-07-30T11:59:30.000Z").toISOString(); // 30s old
const STALE = new Date("2026-07-30T11:57:00.000Z").toISOString(); // 3min old

it("uploaded: neither running nor locked", () => {
  expect(computeRunGate("uploaded", null, NOW)).toEqual({ running: false, rerunLocked: false });
});

it("fresh dispatched: running AND rerun locked — upload hidden, button disabled", () => {
  expect(computeRunGate("dispatched", FRESH, NOW)).toEqual({ running: true, rerunLocked: true });
});

it("stale dispatched: still running (upload stays hidden, 409 avoided) but rerun unlocked (F28)", () => {
  expect(computeRunGate("dispatched", STALE, NOW)).toEqual({ running: true, rerunLocked: false });
});

it("processing, however old: running and locked — the worker sweep owns recovery, not the button", () => {
  expect(computeRunGate("processing", STALE, NOW)).toEqual({ running: true, rerunLocked: true });
});

it("completed/failed/published: neither running nor locked", () => {
  for (const status of ["completed", "needs_review", "failed", "published"]) {
    expect(computeRunGate(status, null, NOW)).toEqual({ running: false, rerunLocked: false });
  }
});
