/**
 * Shared timeout constants for the chat send path.
 *
 * CONST-ONLY — no imports, no runtime code — so both the `"use client"` runtime
 * (`plusimRuntime.ts`) and the server route (`/api/chat`) can import it without
 * pulling server code into the client bundle or letting the two sides drift.
 *
 * A2 invariant: the client fetch must wait at least as long as the server's
 * agent ceiling PLUS the un-abortable preprocessing on BOTH sides of the agent
 * call (pre-agent: Clerk auth + Prisma writes + the ≤2.5s context build;
 * post-agent: assistant-message create + bookkeeping + response flush). If the
 * client aborts first, a reply produced near the ceiling is thrown away before
 * its JSON lands — the "saved reply shown as error" race. See docs/plans/chat-latency.md.
 *
 * The numbers below are the plan's documented defaults. Retune from Phase 0's
 * `chat_latency` logs (high percentiles of `dbBeforeAgentMs` + `dbAfterAgentMs`)
 * if the real tails grow — widen CHAT_PREPROCESS_MARGIN_MS, not the invariant.
 */

/** Server-side AgentGlob call ceiling (ms). */
export const AGENT_TIMEOUT_MS = 90_000;

/**
 * Slack the client adds on top of the agent ceiling to cover un-abortable
 * pre- + post-agent work. Must be ≥ CONTEXT_TIMEOUT_MS plus the measured
 * auth/DB/flush tail.
 */
export const CHAT_PREPROCESS_MARGIN_MS = 5_000;

/** Client-side fetch abort ceiling (ms). MUST exceed the server ceiling by the margin. */
export const CHAT_CLIENT_TIMEOUT_MS = AGENT_TIMEOUT_MS + CHAT_PREPROCESS_MARGIN_MS;

/** Outer deadline bounding the first-turn Drive context build (ms). */
export const CONTEXT_TIMEOUT_MS = 2_500;

/**
 * Hard timeout on a Google OAuth token refresh (ms) so the refresh promise
 * ALWAYS settles — a hung token endpoint otherwise pins every Drive caller
 * unbounded. On expiry the refresh rejects; callers degrade (chat → null
 * context via the outer race; admin → a bounded error).
 */
export const TOKEN_REFRESH_TIMEOUT_MS = 4_000;
