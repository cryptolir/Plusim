# Interface-scoped agent instructions (app vs Telegram `AGENTS.md`)

> **Status:** Backlog / proposed (not started). **Where it's implemented:** the
> `life` agent + `openclaw` gateway side — **not** Havaya app code. It lives on
> this roadmap because it changes how the app-facing agent behaves. Companion
> server-side handover: `HANDOVER_SSH_FROM_MAC.md` (on the dev server) and the
> operator's `HANDOVER_DEV_SERVER.md` §10.

## Problem / motivation

The `life` agent is expected to behave differently in the **Havaya web app** (TAL
coaching, strict privacy / no workspace enumeration, `save_user_section` profile
fields) versus **Telegram and other interfaces** (freeform assistant, group notes,
projects keyed by `telegram_user_id`). Today a single `AGENTS.md` on the agent host
carries both, branching in-prose ("when the chat comes from an app user…"). As
app-specific behavior grows, the conditionals risk becoming unwieldy and the model
may misapply a Telegram-oriented rule to an app user (or vice-versa).

## Feasibility (verified against the openclaw codebase, 2026-06-15)

- `AGENTS.md` (and `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `BOOTSTRAP.md`) are loaded
  by a hardcoded list in `openclaw/src/agents/workspace.ts` (`loadWorkspaceBootstrapFiles`,
  ~line 417) and assembled into the system prompt by `buildAgentSystemPrompt`
  (`src/agents/system-prompt.ts`). There is **no native** "different `AGENTS.md`
  per interface."
- **But** there is a purpose-built **`agent:bootstrap` internal hook** that runs
  *before* prompt assembly, receives `ctx.sessionKey`, and can **mutate the
  bootstrap-file list**. A bundled hook (`bootstrap-extra-files`) already uses it.
  So interface-conditional instruction files are achievable **with a hook, no
  gateway code change** — the same hook family already in use (`life-access-scope`,
  `life-memory-scope`).
- The interface is encoded in the `sessionKey`: app = contains `:app:`
  (`agent:<id>:app:havaya:<userId>:<conv>`), Telegram = contains `:telegram:`.

## Options considered

| Option | Cost | Notes |
|---|---|---|
| **Interim — sharpen the single file** | Trivial (one live edit) | Keep one `AGENTS.md`; add explicit *"Applies to: app only / all interfaces"* headers. Recommended **now**, while divergence is small (~35 of ~132 lines are app-specific and already fenced). |
| **Two full files** | Medium | Highest drift risk: ~80% of the file (memory protocol, projects, temp, group chats) is shared and would be duplicated → the stale-doc problem. **Not recommended.** |
| **Base + overlay** (recommended split) | Medium | One shared base `AGENTS.md` + an `AGENTS.app.md` overlay appended for app sessions via a versioned `agent:bootstrap` hook. Gets the separation without duplicating the shared majority. **Recommended when divergence grows.** |

## Important caveats

- **Clarity, not enforcement.** The hard app/Telegram differences (no enumeration,
  per-user memory scoping) are enforced by the `life-access-scope` /
  `life-memory-scope` hooks regardless of which `AGENTS.md` loads. The split is about
  instruction clarity, not security.
- **Don't add another un-versioned moving part.** `AGENTS.md` is hand-edited on the
  agent host (not in git) and `life-access-scope` is currently host-only. The new
  hook (and the instruction files) **must** be committed to `openclaw` to avoid
  compounding that gap.
- **Detection must be explicit.** App ⇒ `:app:`; Telegram ⇒ `:telegram:`; everything
  else (CLI, cron, subagents, future channels) ⇒ **base only**. Do *not* treat
  "not Telegram" as "app."

## Recommended plan — base + overlay

### Files
- `AGENTS.md` (shared base, always loaded) — remove the two app-only sections; keep
  memory protocol, projects, temp, group chats, user memory. One line noting that
  interface-specific rules are appended per session.
- `AGENTS.app.md` (overlay, app sessions only) — the `App Profile Sections` block +
  the `App-user file access` privacy boundary (room to grow with app-only flow).
- *(Optional)* `AGENTS.telegram.md` — only if Telegram-only rules emerge later.
- `agent-instructions-scope` hook (`agent:bootstrap`) — reads `sessionKey`, appends
  the matching overlay to `bootstrapFiles`.

### Detection logic (mirror the existing hooks)
```
if   sessionKey matches /:app:/        → append AGENTS.app.md
elif sessionKey matches /:telegram:/   → append AGENTS.telegram.md (if present)
else                                   → base only        // cron / CLI / subagent / other
```
Reuse the exact `:app:` test from `life-access-scope/index.js` so all hooks classify
sessions identically. Fail **open** to base-only on any error (never block the prompt).

### Locations
- Hook source (**versioned**): `openclaw/ops/graphiti-life/extensions/agent-instructions-scope/`
  (`index.js`, `openclaw.plugin.json`, `package.json`) — alongside `life-memory-scope`.
- Deployed copy: `2ndclaw:/root/.openclaw/agents/life/extensions/agent-instructions-scope/`
  + registration in `…/agents/life/openclaw.json`.
- Instruction files: `2ndclaw:…/life/workspace/{AGENTS.md, AGENTS.app.md}` (back up
  `AGENTS.md` first); mirror the canonical text into `openclaw/ops/graphiti-life/`.

### Deploy & rollback
- **No image rebuild** — hooks are host files + an `openclaw.json` registration. Copy
  files, restart the `life` container (`docker compose -p life … up -d openclaw-gateway`).
- Keep `AGENTS.md.bak.<date>` + `openclaw.json.bak.pre-instr-scope`; rollback = restore
  them, remove the hook dir, restart.
- Per deploy protocol: commit the hook + instruction files to `openclaw` (PR) and note
  it in `openclaw` `STATUS.md` / `docs/ops`.

### Verification
1. Hook returns the app overlay for `agent:x:app:havaya:u:c`, the Telegram overlay for
   `agent:x:telegram:direct:u`, base-only for `agent:x:cron:…`.
2. App path (live): "show me the files" still refuses; `save_user_section` guidance
   still applies; prompts still generate.
3. Telegram path (live): app-only sections absent; group/project rules intact.
4. Negative: cron/subagent → base only, no overlay leakage.
5. `docker logs life-openclaw-gateway-1` shows the hook registered, no prompt-build errors.

## Decision pending
Start with the **interim single-file sharpening** now, and adopt **base + overlay**
when app-specific behavior diverges enough to justify the extra moving part.
