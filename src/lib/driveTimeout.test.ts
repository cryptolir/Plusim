/**
 * T8 — the token-refresh bound. `withTimeout` must guarantee the wrapped
 * promise ALWAYS settles, so a hung Google token endpoint can never pin a Drive
 * caller (chat, admin, reports) indefinitely. A later call after a hang starts
 * fresh — the guard self-evicts because the promise rejected.
 */
import { describe, it, expect } from "vitest";
import { withTimeout } from "./googleDrive";

describe("withTimeout (T8)", () => {
  it("rejects a hanging promise within the timeout (never pins)", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 20, "getAccessToken timed out")).rejects.toThrow(
      "getAccessToken timed out",
    );
  });

  it("resolves a promise that settles before the timeout", async () => {
    await expect(withTimeout(Promise.resolve("token"), 1000, "timed out")).resolves.toBe("token");
  });

  it("propagates the underlying rejection unchanged when it loses to no timeout", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("invalid_grant")), 1000, "timed out"),
    ).rejects.toThrow("invalid_grant");
  });

  it("a fresh call after a hang is independent (self-eviction)", async () => {
    const hang = new Promise<string>(() => {});
    await expect(withTimeout(hang, 20, "timed out")).rejects.toThrow("timed out");
    // The next call does not await the dead promise — it settles on its own.
    await expect(withTimeout(Promise.resolve("fresh"), 1000, "timed out")).resolves.toBe("fresh");
  });
});
