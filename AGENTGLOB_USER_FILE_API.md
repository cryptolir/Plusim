# AgentGlob — per-user workspace-file **section** API (handoff spec)

> **✅ SHIPPED & LIVE (2026-06-01).** This handoff spec is now implemented on the AgentGlob side and consumed by Havaya. Current as-built state + answered questions: [AGENTGLOB_INTEGRATION_STATUS.md](./AGENTGLOB_INTEGRATION_STATUS.md).

> Instructions for the AgentGlob / OpenClaw side to implement the endpoint Havaya needs.
> Havaya already consumes this (server-side) and degrades to empty UI until it ships.
> Companion summary: [AGENTGLOB.md](./AGENTGLOB.md) §4.12 · rationale & store choice: [AGENTGLOB_PERUSER_GUIDANCE.md](./AGENTGLOB_PERUSER_GUIDANCE.md).

> **Revision note (2026-05-31, after Codex review):** added safe storage-key rule (§4.7), `Vary: Authorization` (§2), duplicate-marker fail-closed (§4.8), clarified app-**namespace** semantics (§3), renamed `updatedAt` → `fileUpdatedAt` (§2), `{agent}` validation in the reference impl (§5), **deferred** the optional batch (§2), namespaced `sessionKey` recommendation (§3), and a **write / provisioning** section (§4.5).

## Goal

Let an integrating app read **named sections** from a **per-user** agent workspace file, scoped by an **app API key + userId** — so the agent hands structured data to the app (e.g. 5 suggested prompts, a per-user note) with no app redeploy and no public exposure.

**Flow this powers (Havaya):** app reads the user's `User_D_Prompt` section → renders the 5 prompts as links on the home page → user clicks one → the prompt text is injected into the chat → the agent responds.

## 1. Per-user file + section markers

Each app-user has a per-user file in the agent workspace, keyed by the **same `userId`** that appears in the chat `sessionKey` (see §3 for the recommended namespaced form). App-shared data lives in delimited sections inside that file:

```
<!-- app:User_D_Prompt:start -->
What's weighing on me today?
Help me reflect on a decision
…up to 5 lines…
<!-- app:User_D_Prompt:end -->

<!-- app:app_note:start -->
Welcome back — your focus for the week.
<!-- app:app_note:end -->
```

HTML-comment markers are invisible in rendered markdown and unambiguous to parse. Any future field = a new `app:<name>` section. A given section's markers must appear **exactly once** per file (see §4.8).

## 2. Endpoint

```
GET /api/public/chat/{agent}/user-file?userId={appUserId}&section={name}
Authorization: Bearer {APP_API_KEY}
```

**200**
```json
{
  "agent": "life",
  "userId": "user_2abc…",
  "section": "User_D_Prompt",
  "content": "…inner text of the section…",
  "fileUpdatedAt": "2026-05-20T06:53:34.000Z"
}
```

> `fileUpdatedAt` is the **file's** last-modified time (per-user file mtime), not section-level — AgentGlob does not track per-section timestamps. Named so the consumer doesn't assume section-level granularity.

| Status | When |
|---|---|
| `401` | missing / invalid app key |
| `400` | missing / invalid `agent`, `userId`, or `section` |
| `404` | section not allowlisted, or no such user / section — **same body for all** (don't reveal which) |
| `304` | `If-None-Match` matches `ETag` |
| `500` | section markers found **more than once** in the file (ambiguous — fail closed, see §4.8) |

Response headers: `ETag`, `Vary: Authorization`, `Cache-Control: private, max-age=60`.
(`Vary: Authorization` even with `private` — different app keys may resolve different content for the same URL; keep shared caches/proxies honest.)

**Optional batch — DEFERRED, not in Phase 2.** A `?sections=User_D_Prompt,app_note` form (returning `{ "sections": { … } }`) was considered but is **out of scope for now**: it adds combined-ETag and partial-null semantics Phase 2 doesn't need. Ship the single-section form first; revisit batch only if round-trip count becomes a real problem.

## 3. Auth & identity (app **namespace**, not user-registry membership)

- **App API key** — AgentGlob issues Havaya one server-side secret (`Authorization: Bearer …`). It **selects an app namespace**: a key for app *X* can only ever resolve per-user files stored under *X*'s namespace. Never shipped to the browser; the app calls this server-side.
- **userId** — the app's own user id (Clerk `userId` for Havaya), the **same value** embedded in the `sessionKey`. It is resolved **within** the app's namespace.
- **No cross-app registry is implied.** AgentGlob need not maintain a Clerk user registry or validate "membership." The enforceable rule is purely namespacing: a `userId` from another app simply has **no file under this app's namespace** → `404`. (Phrased this way to avoid implying a membership check that doesn't exist.)

**sessionKey — namespaced form (implemented).** Havaya now mints `sessionKey = app:havaya:<userId>:<conversationId>` — app-namespaced to avoid cross-app collisions if this pattern is reused. The agent must derive `<userId>` as the component **after** the `havaya` namespace (split on `:` → index 2) and key each per-user file off it. **Existing-conversation impact:** the key is minted once at creation and stored on `Conversation.sessionKey`, so conversations created **before** this change keep their original 3-part `app:<userId>:<conversationId>` key (continuity preserved). The agent side must therefore accept **both** forms: 4-part (namespaced, `<userId>` at index 2) and legacy 3-part (`<userId>` at index 1).

## 4. Security (mandatory)

1. **App-namespaced** — a key only resolves files under its own app namespace → else `404` (see §3).
2. **Section allowlist** per agent (default empty); only listed `app:<name>` sections are served.
3. **Read-only** in this version.
4. **Marker-scoped** — return only the bytes between that section's start/end markers; never the whole file, never other sections.
5. **Validate** `agent` / `userId` / `section` against `^[A-Za-z0-9._:-]+$`; cap section size (~64 KB).
6. **Don't leak existence** — `404` (not `403`) for not-allowlisted / not-found.
7. **Safe storage key — never map `userId` to a path directly.** `userId` may contain `.` and `:` (allowed by §4.5 for query validation), which is unsafe as a filename/path component. **Hash or percent-encode** it into the on-disk name — e.g. `file = <appNamespaceDir>/<sha256(appId + ":" + userId)>.md` — and after resolving, **enforce a path-containment check** that the resolved path stays inside the app's per-user directory. Reject any `..` / traversal. (Regex validation alone is not a path-safety guarantee.)
8. **Duplicate markers → fail closed.** If a section's `start`/`end` markers appear **more than once** in the file, do **not** guess (first match / last match): return **`500`** and log for the operator. Ambiguous content must never be silently served.

## 4.5 Write / provisioning path (AgentGlob must define)

This endpoint is **read-only**. Phase 2 is not fully unblockable until the **writer** is specified — i.e. *how* `User_D_Prompt` and `app_note` get into each user's per-user file. Please pick and document one (or more):

- **Agent tool/skill** — the `life` agent writes the section via a workspace-write tool.
- **Owner/admin command or UI** — the agent owner edits sections for a user.
- **Background job** — periodic population.
- **First-chat-turn seeding** — created lazily on the user's first interaction.
- **Direct file edit** — operator-managed.

Tie this to the **provisioning model** (lazy on first write vs. at-signup) discussed in [AGENTGLOB_PERUSER_GUIDANCE.md](./AGENTGLOB_PERUSER_GUIDANCE.md) §4. Havaya degrades gracefully on `404`, so **lazy** is acceptable and nothing blocks on provisioning — but the writer mechanism must be explicit before content can appear.

## 5. Reference implementation (TypeScript / Next route handler)

```ts
// app/api/public/chat/[agent]/user-file/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { resolveApp, getUserFile, getSectionAllowlist } from "@/lib/appsAndAgents"; // your internals

const SAFE = /^[A-Za-z0-9._:-]+$/;

export async function GET(req: NextRequest, { params }: { params: { agent: string } }) {
  const auth = req.headers.get("authorization") ?? "";
  const app = await resolveApp(auth.startsWith("Bearer ") ? auth.slice(7) : ""); // null if invalid
  if (!app) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const u = new URL(req.url);
  const userId = u.searchParams.get("userId") ?? "";
  const section = u.searchParams.get("section") ?? "";
  // validate the agent param too, not only userId/section
  if (!SAFE.test(params.agent) || !SAFE.test(userId) || !SAFE.test(section))
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const allow = await getSectionAllowlist(params.agent); // string[]
  if (!allow.includes(section))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  // getUserFile MUST: scope to app.id's namespace, hash userId → safe filename,
  // and path-containment-check the resolved path (see §4.7). Returns null if none.
  const file = await getUserFile(app.id, params.agent, userId);
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });

  const start = `<!-- app:${section}:start -->`;
  const end = `<!-- app:${section}:end -->`;
  const i = file.content.indexOf(start);
  const j = file.content.indexOf(end, i + start.length);
  if (i === -1 || j === -1) return NextResponse.json({ error: "not found" }, { status: 404 });
  // duplicate markers → ambiguous → fail closed (§4.8)
  if (file.content.indexOf(start, i + start.length) !== -1 ||
      file.content.indexOf(end, j + end.length) !== -1) {
    console.error(`duplicate markers for app:${section} in ${params.agent}/${userId}`);
    return NextResponse.json({ error: "ambiguous section" }, { status: 500 });
  }
  const content = file.content.slice(i + start.length, j).trim();

  const etag = `"${crypto.createHash("sha1").update(content).digest("hex")}"`;
  if (req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304 });

  return NextResponse.json(
    { agent: params.agent, userId, section, content, fileUpdatedAt: file.updatedAt },
    { headers: { ETag: etag, Vary: "Authorization", "Cache-Control": "private, max-age=60" } },
  );
}
```

`getUserFile(appId, agent, userId)` must enforce app-namespace scope, derive a **safe filename** from `userId` (§4.7), and locate the per-user file the agent maintains (keyed by the same `userId` as in the sessionKey).

## 6. Allowlist config (per agent, in openclaw.json / settings)

```json
{ "public": { "sections": ["User_D_Prompt", "app_note"] } }
```

Default empty → opt-in; no behavior change for existing agents.

## 7. Acceptance tests

```bash
KEY=hav_xxx   # the app key issued to Havaya
B=https://app.agentglob.com/api/public/chat/life/user-file

# allowlisted section for a real user → 200
curl -s -H "Authorization: Bearer $KEY" "$B?userId=user_2abc&section=User_D_Prompt" | jq .

# no key → 401
curl -s -o /dev/null -w "%{http_code}\n" "$B?userId=user_2abc&section=User_D_Prompt"                 # 401

# non-allowlisted section → 404 (must not leak)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $KEY" "$B?userId=user_2abc&section=SOUL"        # 404

# another app's / unknown user → 404
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $KEY" "$B?userId=not_mine&section=User_D_Prompt" # 404

# path-traversal attempt in userId → 400 (rejected by §4.5 regex; never reaches the filesystem)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $KEY" "$B?userId=../../etc/passwd&section=User_D_Prompt" # 400

# duplicated section markers in the file → 500 (fail closed, §4.8) — set up a fixture user to verify
```

## 8. What Havaya needs from you

1. **Issue an app API key** for Havaya (server-side secret) → we set it as `AGENTGLOB_APP_API_KEY`.
2. **Allowlist** sections `User_D_Prompt` and `app_note` on the `life` agent.
3. Ensure the agent **writes** those sections into each user's per-user file (the **writer mechanism** in §4.5), keyed by the `userId` from the `sessionKey` (agree on the namespaced form in §3), using the marker format in §1.
4. **Confirm** the four guidance questions in [AGENTGLOB_PERUSER_GUIDANCE.md](./AGENTGLOB_PERUSER_GUIDANCE.md) §6 **+ the writer/provisioning mechanism** (§4.5 here).

## 9. Definition of done

- [ ] `GET …/user-file?userId=&section=User_D_Prompt` with the app key → 200 `{content, fileUpdatedAt}`
- [ ] No key → 401; non-allowlisted section (`SOUL`) → 404; cross-app / unknown user → 404
- [ ] `userId` mapped to a **hashed/encoded** filename with a path-containment check; traversal attempts → 400/404, never a filesystem read (§4.7)
- [ ] Duplicate section markers → 500 + operator log (§4.8)
- [ ] Only the marked section's bytes are returned (never the whole file)
- [ ] `Vary: Authorization` present on 200
- [ ] Allowlist defaults empty (no change for existing agents)
- [ ] Writer / provisioning mechanism documented (§4.5)

## How Havaya consumes it

Server-side, in [`src/lib/agentglob.ts`](./src/lib/agentglob.ts):

```ts
getUserSection(userId, "User_D_Prompt")  // → string | null
getUserSection(userId, "app_note")       // → string | null
```

The home hub (`src/app/page.tsx`) passes the Clerk `userId`; `parsePrompts()` turns the `User_D_Prompt` text into the 5 clickable prompts. Until this endpoint ships and `AGENTGLOB_APP_API_KEY` is set, both calls return `null` and those sections render empty — no errors.
