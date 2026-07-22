/**
 * T6 (A2) — the client fetch timeout must outlast the server's agent ceiling
 * by at least the un-abortable pre/post-agent margin, and the margin must cover
 * the bounded context build. Guards the shared constants against a future edit
 * that reintroduces the "saved reply shown as error" race.
 */
import { describe, it, expect } from "vitest";
import {
  AGENT_TIMEOUT_MS,
  CHAT_CLIENT_TIMEOUT_MS,
  CHAT_PREPROCESS_MARGIN_MS,
  CONTEXT_TIMEOUT_MS,
  TOKEN_REFRESH_TIMEOUT_MS,
} from "./chatTimeouts";

describe("chat timeout invariants (T6)", () => {
  it("client waits strictly longer than the server agent ceiling", () => {
    expect(CHAT_CLIENT_TIMEOUT_MS).toBeGreaterThan(AGENT_TIMEOUT_MS);
  });

  it("client margin over the ceiling is at least the declared preprocessing margin", () => {
    expect(CHAT_CLIENT_TIMEOUT_MS - AGENT_TIMEOUT_MS).toBeGreaterThanOrEqual(CHAT_PREPROCESS_MARGIN_MS);
  });

  it("preprocessing margin covers at least the bounded context build", () => {
    expect(CHAT_PREPROCESS_MARGIN_MS).toBeGreaterThanOrEqual(CONTEXT_TIMEOUT_MS);
  });

  it("token refresh timeout is positive and well under the agent ceiling", () => {
    expect(TOKEN_REFRESH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TOKEN_REFRESH_TIMEOUT_MS).toBeLessThan(AGENT_TIMEOUT_MS);
  });
});
