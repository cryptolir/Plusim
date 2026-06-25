# AgentGlob per-user integration — status (as-built)

> **Status:** ✅ SHIPPED & LIVE (2026-06-01). This is the current state of the
> AgentGlob per-user file integration that powers the home-hub prompts panel and
> owner note. The original handoff spec is
> [AGENTGLOB_USER_FILE_API.md](./AGENTGLOB_USER_FILE_API.md); rationale is
> [AGENTGLOB_PERUSER_GUIDANCE.md](./AGENTGLOB_PERUSER_GUIDANCE.md). This doc
> supersedes the open questions in those (they are now answered, below).

## End-to-end flow

```
Havaya home page ──(server-side, Bearer AGENTGLOB_APP_API_KEY)──▶
  GET /api/public/chat/life/user-file?userId=<clerkUserId>&section=User_D_Prompt
     └─ AgentGlob dashboard reads workspace/users/<clerkUserId>.md over SSH,
        returns the marked section → parsePrompts() → 5 clickable prompts.

Havaya chat ──(POST, body.appUserId = clerk userId)──▶ AgentGlob dashboard
  └─ forwards appUserId into gateway chat.send → persisted on the session
     └─ the `life` agent calls save_user_section("User_D_Prompt" | "app_note")
        which writes workspace/users/<clerkUserId>.md  (the same file read above).
```

## What's built (all merged to main, deployed)

| Side | Repo | Change | PR |
|---|---|---|---|
| Consumer | `app.havaya` | `getUserSection()` reads sections; `callAgent`/chat route send `appUserId` | #3 |
| Reader | `openclaw-dashboard` | `GET …/user-file` endpoint (`lib/user-file-core.ts` + route) | #107 |
| Passthrough | `openclaw-dashboard` | `appUserId` forwarded into gateway `chat.send` | #108 |
| Writer | `openclaw` (gateway) | `save_user_section` tool + `appUserId` on `chat.send`/session | #49 |

## Havaya consumption (this repo)

Server-side, in [`src/lib/agentglob.ts`](./src/lib/agentglob.ts):

```ts
getUserSection(userId, "User_D_Prompt")  // → string | null  (raw section text)
getUserSection(userId, "app_note")       // → string | null  (owner note)
callAgent({ sessionKey, message, appUserId: userId })  // sends Clerk userId
```

The home hub (`src/app/page.tsx`) passes the Clerk `userId`. `parsePrompts()`
— defined in [`src/lib/agentContent.ts`](./src/lib/agentContent.ts), **not** in
`agentglob.ts` (which is only the HTTP client) — splits the raw `User_D_Prompt`
text into clickable prompts: one per line, leading markdown markers stripped,
capped at 5. `app_note` is **not** parsed — it is rendered as-is markdown by
`OwnerNote`. Both reads return `null` (empty state, no error) until the agent
has written that user's file.

## Answers to the previously-open questions

- **Writer mechanism:** an **agent tool** — `save_user_section` on the `life`
  agent. The agent decides when to write (after it knows enough to suggest
  useful prompts); the write is an upsert into `workspace/users/<userId>.md`.
- **Identity:** the **Clerk `userId`**, sent as `appUserId` on chat, persisted on
  the gateway session, resolved server-side by the writer — the agent never
  passes an id. On disk the filename is the **raw lowercased `userId`**; reader
  and writer lowercase identically.
- **Provisioning:** **lazy** — file created on the agent's first write; until then
  reads `404` → empty UI.
- **Allowlist:** `User_D_Prompt`, `app_note` (only these two are readable AND
  writable). **As of 2026-06, only `User_D_Prompt` is populated in production** —
  `app_note` is wired end-to-end and writable, but no live user file carries one
  yet (the agent simply hasn't written it).
- **sessionKey:** Havaya mints `app:havaya:<userId>:<conversationId>`; identity
  for the file is `appUserId` carried explicitly on chat (not parsed from the
  key), so legacy 3-part keys are unaffected.

## Operator handback (Havaya / Coolify)

Set in Havaya's Coolify env, then redeploy Havaya:

```
AGENTGLOB_APP_API_KEY=<issued by AgentGlob; must match the dashboard side>
```

Already set and verified on the AgentGlob dashboard side. Until it is set here,
`getUserSection` returns `null` and the panels render empty (no error).

## Prod verification (2026-06-01)

`no key → 401` · `valid key + missing file → 404` · `non-allowlisted → 404` ·
`wrong key → 401`. Writer live in `life` image `v2026.06.01.1`; agent guidance
present in the `life` `workspace/AGENTS.md` (**App Profile Sections**).
