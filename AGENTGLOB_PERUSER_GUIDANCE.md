# AgentGlob — per-user persistence guidance (one agent, many users)

> **Audience:** the AgentGlob / OpenClaw side, implementing the per-user file API that Havaya consumes.
> **Status:** guidance / rationale. The concrete endpoint contract is in [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md) — this doc explains **how to back it** and **why**, so the implementation lands on the right primitive instead of an over-built one.
> **Scope boundary:** everything here is an **AgentGlob-side** decision. Havaya only consumes the read endpoint and is already built to degrade to empty UI until it ships.
> **Revised 2026-05-31** after Codex review: added the **writer/provisioning** question (§4, §6) and cross-links to the hardened contract (`AGENTGLOB_USER_FILE_API.md` §4.5/§4.7/§4.8).

---

## 0. TL;DR

- Havaya is **already "one agent, many users"** — but it isolates users at the **app layer** (Clerk auth + `sessionKey`), not via the agent's `dmScope`. **Keep it that way.** Do not route Havaya web traffic through `dmScope`.
- The real need is the **per-user persistence layer**: where do per-user app fields (`User_D_Prompt`, `app_note`) live, and how does the app read them.
- Of OpenClaw's two per-user stores, back this with the **file route** (`users/<user>.md`-style per-user file), **not** the **memory plugin** (vector recall). The fields are owner-edited, displayed verbatim, and must be addressable — that is a file, not a fuzzy memory bank.
- **Verify whether native per-user file scoping already exists** on your OpenClaw version. If it does, the Havaya endpoint becomes a thin read over existing storage instead of net-new plumbing.

---

## 1. The reframe: two concerns the "multi-user agent" pattern conflates

The "one agent vs. one-agent-per-user" guidance circulating for OpenClaw is mostly about a **chat-platform ingress** — a human DMs the agent on Telegram/Slack and the *agent* must figure out who they are and not bleed context between people. That bundles two separate problems:

| Concern | What solves it | Where Havaya stands |
|---|---|---|
| **A. Conversation isolation** — User A's history never leaks into User B's context | `dmScope` (per-channel-peer) — for messaging-platform ingress | **Already solved at the app layer.** Havaya mints `sessionKey = app:havaya:<userId>:<conversationId>` per Clerk user; two users can never share a session. |
| **B. Per-user persistent facts** — knowledge/fields that survive session resets and differ per user | A deliberate per-user store (file **or** memory plugin) | **This is the open work.** It's what the per-user file API backs. |

**Implication:** `dmScope` is solving a problem Havaya does not have on the web path. Havaya is the front door and owns partitioning explicitly and auditably. The only thing AgentGlob needs to build for Havaya is **concern B** — the per-user persistence + a scoped read endpoint.

> `dmScope: per-channel-peer` becomes relevant only **if** the `life` agent later gets a *direct* messaging surface (users DM it on Telegram/Slack alongside the app). Until then it is out of scope for this integration.

---

## 2. Which store backs the per-user fields — file vs. memory plugin

OpenClaw offers two native routes for per-user persistence. They are **not** interchangeable for this use case.

### ✅ File route — use this

A per-user file in the agent workspace (e.g. `users/<user>.md`), scoped by sender/app identity, with `SOUL.md` / `AGENTS.md` / skills staying shared. The app fields live as delimited sections inside it (see marker format in [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md) §1).

Why it fits the Havaya fields:

- **Deterministic & addressable** — "give me exactly the `User_D_Prompt` section" returns the same bytes every time.
- **Owner-editable** — the agent (or its owner) writes the 5 prompts / the note; the app renders them verbatim.
- **Cheap to read** — a section slice + ETag; no inference, no vector search.

### ❌ Memory plugin (Hindsight / Vectorize) — wrong tool here

Per-user memory banks (recommended bank key like `["provider","user"]`) are for **what the agent learns about a user** — fuzzy, retrieval-ranked recall. They are **not** addressable: you can't reliably ask for "the exact 5 prompts the owner wrote." Using them to serve app-displayed content would be unpredictable and unversioned.

> The memory plugin is the right tool **later**, for a different feature (agent recalling user history), not for the prompts/note the app shows.

**Decision to encode in the implementation:** back `User_D_Prompt` and `app_note` with the **file route**.

---

## 3. Verify before building: is native per-user file scoping available?

As of early 2026, file-based per-user scoping (`users/<user>.md` written/injected by sender identity) was reported as a **requested feature**, not confirmed built-in on every OpenClaw version.

- **If it IS native** on your version → the Havaya `user-file` endpoint is a **thin read** over storage the runtime already maintains. Lowest cost.
- **If it is NOT native** → implement the per-user file + section store as specced in `AGENTGLOB_USER_FILE_API.md`. Havaya's consumer (`getUserSection`) is **identical either way** — this choice is invisible to the app.

Please confirm which case applies; it changes only AgentGlob's build cost, not the contract.

---

## 4. Identity & onboarding (the one real design choice)

- **Identity key:** the per-user file MUST be keyed by the **same `userId`** that appears in `sessionKey = app:havaya:<userId>:<conversationId>` (Clerk `userId`, the component **after** the `havaya` namespace; legacy keys are 3-part). The API and the agent must agree on identity, scoped by the issued app key (see auth model in the contract doc §3).
- **Provisioning — please decide and tell us:** when does a Havaya user's per-user file first exist?
  - **Lazy** — created on first agent write (e.g. first time the agent populates `User_D_Prompt`). Simplest; until then the read returns `404` → app shows empty state.
  - **At signup** — Havaya signals "new user" and AgentGlob provisions the file. Cleaner UX (content can be seeded), more coupling.
  - **Recommendation:** start **lazy** — Havaya already degrades gracefully on `404`, so nothing blocks on provisioning.
- **Writer mechanism — also decide:** *how* the sections get written (agent tool/skill, owner/admin edit, background job, first-turn seeding, or direct edit). The read API is read-only; the writer is separate and must be explicit. Spec stub: [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md) §4.5.
- **Cross-platform identity** (`identityLinks`) — not needed now; only relevant if the same human reaches `life` through both the app and a messaging platform and you want continuity. Defer.

---

## 5. What this means for the existing contract

No change to [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md). This guidance just constrains the **backing implementation** behind it:

1. Back the sections with the **file route**, not the memory plugin.
2. Check for **native per-user file scoping** first; reuse it if present.
3. Keep the **section allowlist** (`User_D_Prompt`, `app_note`) and the app-key scoping exactly as the contract specs — those guard against leaking `SOUL.md` / `MEMORY.md` / secrets.
4. Keep partitioning **app-owned** (sessionKey); do not introduce `dmScope` into the web path.

---

## 6. Questions to confirm back to Havaya

1. Does your OpenClaw version have **native per-user file scoping** (`users/<user>.md`)? If yes, will the endpoint read it directly?
2. **Provisioning model** — lazy (on first write) or at-signup? (Havaya is fine with lazy.)
3. **Writer mechanism** — what *exactly* writes `User_D_Prompt` / `app_note` into each user's file: an agent tool/skill, an owner/admin command or UI, a background job, first-chat-turn seeding, or a direct file edit? (Phase 2 can't show content until this is explicit — see [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md) §4.5.)
4. Confirm the **read contract + allowlist** (`User_D_Prompt`, `app_note`) from `AGENTGLOB_USER_FILE_API.md` is unaffected by whichever backing store you choose.
5. Issue the **app API key** (`AGENTGLOB_APP_API_KEY`) so Havaya can set it in Coolify.

---

## Appendix — source notes (OpenClaw multi-user pattern)

Condensed from research into OpenClaw's "one agent, many users" guidance; recorded here so the rationale travels with the repo:

- **`dmScope`** partitions conversations per user: `main` (shared), `per-peer`, `per-channel-peer` (recommended for multi-user messaging ingress), `per-account`. Isolates *conversation history* only.
- **Sessions ≠ persistent memory.** `USER.md` and long-term memory stay **shared** across senders by default; per-user *facts* need a deliberate store.
- **Two persistence routes:** (a) **file-based** scoped injection (`users/<user>.md`; shared `SOUL.md`/`AGENTS.md`/skills) — reported as a requested feature, verify per version; (b) **memory plugin** (Hindsight/Vectorize) with per-user bank keys like `["provider","user"]`.
- **One agent beats one-agent-per-user at scale:** no workspace duplication, no per-agent auth/binding per user; budget ~2 GB RAM per agent (memory is the bottleneck before CPU). A separate agent is justified for a client-facing surface needing its own memory / kill switch / cost attribution — not for per-user fields inside one app.
- **Engagement flow:** first contact should create the per-user record; use `identityLinks` for cross-platform continuity; gate with `dmPolicy: allowlist`; tune compaction as user count grows.
