/**
 * Plan test 12 (F6/F13): the driveFetch write bucket. Explicit non-GET consumes
 * the bucket; explicit GET, lowercase get, and an OMITTED method (how most
 * reads call driveFetch — no init, or only {signal}) do not. Spacing is checked
 * with a fake clock. Coverage of all six mutating helpers is by construction:
 * driveFetch is the single choke point, and its gate call is pinned below.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  driveWriteGate,
  takeDriveWriteToken,
  resetDriveWriteBucketForTests,
} from "./googleDrive";

beforeEach(() => {
  vi.useFakeTimers();
  resetDriveWriteBucketForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

it("reads never touch the bucket: omitted init, {signal} only, GET, lowercase get", () => {
  expect(driveWriteGate(undefined)).toBeNull();
  expect(driveWriteGate({ signal: new AbortController().signal })).toBeNull();
  expect(driveWriteGate({ method: "GET" })).toBeNull();
  expect(driveWriteGate({ method: "get" })).toBeNull(); // normalized, not literal (F13)
});

it("explicit non-GET consumes the bucket: after 3 writes the 4th must wait; reads still pass", async () => {
  await driveWriteGate({ method: "POST" });
  await driveWriteGate({ method: "PATCH" });
  await driveWriteGate({ method: "DELETE" });

  let fourthSettled = false;
  const fourth = driveWriteGate({ method: "POST" })!.then(() => (fourthSettled = true));
  await vi.advanceTimersByTimeAsync(0);
  expect(fourthSettled).toBe(false); // the three writes consumed the burst

  expect(driveWriteGate({ method: "GET" })).toBeNull(); // a read is never queued behind writes

  await vi.advanceTimersByTimeAsync(400);
  expect(fourthSettled).toBe(true);
  await fourth;
});

it("burst then spacing: 3 immediate writes, the 4th waits ~1/3s (fake clock)", async () => {
  const settled: boolean[] = [false, false, false, false];
  const takes = [0, 1, 2, 3].map((i) => takeDriveWriteToken().then(() => (settled[i] = true)));

  await vi.advanceTimersByTimeAsync(0);
  expect(settled.slice(0, 3)).toEqual([true, true, true]); // burst
  expect(settled[3]).toBe(false); // bucket dry

  await vi.advanceTimersByTimeAsync(400); // ≥ 1000ms / 3 writes-per-sec
  expect(settled[3]).toBe(true);
  await Promise.all(takes);
});

it("driveFetch awaits the gate before any request (pinned by construction, I6)", () => {
  const src = readFileSync(fileURLToPath(new URL("./googleDrive.ts", import.meta.url)), "utf8");
  const driveFetchBody = src.slice(src.indexOf("async function driveFetch"));
  expect(driveFetchBody).toContain("await driveWriteGate(init);");
  // The gate call precedes the fetch.
  expect(driveFetchBody.indexOf("await driveWriteGate(init);")).toBeLessThan(
    driveFetchBody.indexOf("return fetch("),
  );
});
