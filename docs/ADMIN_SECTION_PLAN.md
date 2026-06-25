# Havaya Admin Section — Implementation Plan (rev. after Codex review)

## Context

Havaya (`app.havaya.me`, repo `cryptolir/app.havaya`, on-disk `Havaya_App`) needs an **admin
section** so an operator can see who is using the app and curate each user's per-user
content (the clickable prompts shown right of the chat, plus the owner note). Today there is
**no admin surface**, and the per-user file is **read-only** to the app: `getUserSection()` in
`src/lib/agentglob.ts` only reads sections; the only writer is the `life` agent's
`save_user_section` tool (gateway `oc-gw-build`). The product requirement is for the admin to
**edit the real per-user file in the agent workspace** (not an app-side copy) so app + agent
stay in sync.

Desired outcome (from the 4 requirements):
1. Hardcoded-style admin login (start: `Admin1` / `Admin123`).
2. Admin dashboard = one table of users: **name · last usage · chat count · link to user file**.
3. Admin opens a user file, **edits and saves** it.
4. After save, that user's home hub **refreshes with the new predefined prompts** (right of chat).

This revision folds in Codex's review (separate write key, ETag/If-Match concurrency,
prod-auth fail-closed, app-owned-file boundary, atomic remote write, audit logs, marker
validation, IP+username login limiter).

## Decisions (locked)

- **Source of truth = the real `users/<userId>.md` in the `life` workspace** (not an app copy).
- **Whole-file raw text editing** by the admin.
- Admin creds **`Admin1` / `Admin123` are dev-only defaults**; prod must be env-driven and fail closed.

## Architecture (confirmed in code)

- Per-user file: `users/<userId>.md` in the `life` agent workspace (US host `2ndclaw`),
  filename = **lowercased Clerk userId**. Sections are HTML-comment markers
  (`<!-- app:User_D_Prompt:start -->…<!-- app:User_D_Prompt:end -->`).
- Read today: `openclaw-dashboard` route `…/api/public/chat/[agentName]/user-file?userId=&section=`
  (app-key auth, section-allowlisted, returns `{content, fileUpdatedAt}` + ETag/304). Core logic in
  `openclaw-dashboard/src/lib/user-file-core.ts`. App wrapper: `getUserSection()` (`src/lib/agentglob.ts`).
- Write today: only `oc-gw-build/src/agents/tools/save-user-section.ts` (`upsertSection`,
  allowlist `["User_D_Prompt","app_note"]`, server-resolved `appUserId`). **No app HTTP write.**
- Chat stats: Prisma `Conversation(userId, updatedAt)` + `Message` (`prisma/schema.prisma`,
  `src/lib/db.ts`). User names/emails: Clerk `clerkClient` (`@clerk/nextjs/server`).
- Prompts right of chat already ship: `parsePrompts(User_D_Prompt)` → `PromptsPanel` on the home hub.

## Safety boundary (Codex blocker #2 — resolved)

`users/<userId>.md` is defined as **app-owned, human-readable content** (curated sections only).
Per `agentglob/docs/life-per-user-memory-plan.md` §7, the agent's **private** memory is slated for
**Graphiti**, *not* this file. Therefore raw whole-file admin read/write is acceptable **today**.
**Document this boundary** in `AGENTGLOB_USER_FILE_API.md`. ⚠️ If the agent ever writes private
memory exports into this same file, raw admin access must be revisited (split to a dedicated
app-owned file, or revert to section-scoped editing).

---

## Phase 0 — AgentGlob raw read/write endpoint  ⚠️ linchpin, `openclaw-dashboard`, ships first

New raw sub-route `…/api/public/chat/[agentName]/user-file/raw` reusing the existing
app-key auth, app-namespace scoping, and `SAFE_USERID` filename derivation in
`src/lib/user-file-core.ts`:

- **GET raw** `?userId=` → `{ content, etag, exists, fileUpdatedAt }`.
  - `exists: false` + `content: ""` when the file is absent (Codex: distinguish "not created yet").
  - `etag` = strong hash of file bytes; support `If-None-Match` → 304.
- **PUT raw** `?userId=` body `{ content }` → overwrite the file.
  - **Requires `If-Match: <etag>`** (or `previousEtag` in body). Mismatch → **409 Conflict**
    (don't clobber agent edits made during chat). Absent file: require `If-Match: "*"`-style create intent.
  - **Separate write credential**: accept only `AGENTGLOB_APP_WRITE_KEY` (NOT the read key) on PUT.
  - **Size limits**: reject request body and resulting file > **64 KB** → 413.
  - **Marker validation (hard, not soft)**: parse allowlisted sections; **block** duplicate or
    malformed start/end pairs (mirror `upsertSection`'s fail-closed logic) → 422, **unless** an
    explicit `?force=1` is passed (force path is audit-logged).
  - **Atomic remote write**: write temp file → verify size → `rename` over target → optional `.bak`
    backup of prior content. **Use SFTP, not shell heredocs** for arbitrary raw text.
- **Audit log** (both GET-raw and PUT-raw): admin identity (passed through from app), `userId` **hash**,
  old/new etag, byte size, timestamp, force-flag. **Never log file content.**
- **Tests**: route tests with **mocked SSH/SFTP** — create/missing/exists, ETag 304, If-Match 409,
  oversize 413, malformed markers 422, force override, write-key required.
- **Contract docs**: update `AGENTGLOB_USER_FILE_API.md` (§4.5 write path) +
  `openclaw-dashboard/docs/peruser-user-file-plan.md` with raw endpoints, ETag rules, write key, audit.

> Verify against `user-file-core.ts` exactly how the read path reaches `users/<userId>.md`
> (Codex indicates SSH/SFTP to the US host); the write must use the **same transport**, atomically.

## Phase 1 — Admin auth (`Havaya_App`)

- New `src/lib/adminAuth.ts`:
  - Creds from env: `ADMIN_USERNAME` (default `Admin1` in dev), **`ADMIN_PASSWORD_HASH`** (bcrypt/scrypt;
    preferred over plaintext). **Prod fail-closed**: if `NODE_ENV==='production'` and the env is unset,
    refuse all admin auth (no `Admin123` default in prod).
  - Constant-time comparison; sign/verify a short-lived **httpOnly, SameSite=Lax** cookie
    (`admin_session`) via HMAC with `ADMIN_SESSION_SECRET`.
- New **login rate limiter keyed by `IP + username`** (Codex #6) — the existing `rateLimit(userId)`
  in `src/lib/ratelimit.ts` is unsuitable (no user yet). Add a sibling limiter there.
- `src/app/admin/login/page.tsx` + route handler → set cookie on success.
- `src/app/admin/layout.tsx` (server) verifies the cookie → else `redirect('/admin/login')`.
- `src/app/admin/logout/route.ts` clears the cookie. Independent of Clerk; **no `middleware.ts`**.

## Phase 2 — Admin dashboard (`/admin`)

- `src/app/admin/page.tsx` (server). Merge:
  - Clerk `clerkClient.users.getUserList({ limit })` → name, email, userId (paginate; v1 first ~200, note cap).
  - Prisma `conversation.groupBy({ by:['userId'], _count, _max:{ updatedAt } })` → chat count + last usage.
- Render one table: **User name · Last usage · Chat count · User file** (link → `/admin/users/[userId]/file`).
  Sort by last usage desc.

## Phase 3 — User-file editor (`/admin/users/[userId]/file`)

- New `src/lib/agentglob.ts` helpers:
  - `getUserFileRaw(userId)` → `{ content, etag, exists }` (GET raw, read key).
  - `saveUserFileRaw(userId, content, ifMatch, opts?)` → PUT raw with **`AGENTGLOB_APP_WRITE_KEY`** +
    `If-Match`; surfaces 409/413/422.
- `page.tsx`: server-load raw content; show user name/email, a raw `<textarea>`, the current `etag`
  (hidden), and a Save button. Empty-state when `exists:false`.
- Save → `src/app/admin/api/users/[userId]/file/route.ts` (admin-cookie guarded) → `saveUserFileRaw`
  with the loaded `etag`. On **409** show a clear "file changed since you opened it — reload" conflict.
  Offer an explicit "force save" that re-fetches latest etag and re-submits with `?force=1` (audit-logged).

## Phase 4 — Prompt refresh (req 4)

- Tag the read: `getUserSection` fetch gets `next: { tags: ['user-file:'+userId], revalidate: 60 }`.
- After a successful admin save, call `revalidateTag('user-file:'+userId)` so that user's home hub
  shows the updated prompts on next load. **Note:** agent-side chat writes still rely on the 60 s
  `revalidate` (they don't call back into Havaya); live in-session refresh is out of scope.

---

## Critical files

**openclaw-dashboard (Phase 0):** `src/lib/user-file-core.ts` (raw read/write, etag, atomic SFTP,
markers, audit); new `src/app/api/public/chat/[agentName]/user-file/raw/route.ts`; auth helper
(add write-key check); `AGENTGLOB_USER_FILE_API.md`, `docs/peruser-user-file-plan.md`; route tests.

**Havaya_App (Phases 1–4):** `src/lib/agentglob.ts` (raw helpers + cache tag); new `src/lib/adminAuth.ts`;
`src/lib/ratelimit.ts` (IP+username limiter); `src/app/admin/{layout,login,logout,page}.tsx`,
`src/app/admin/users/[userId]/file/page.tsx`, `src/app/admin/api/users/[userId]/file/route.ts`;
`.env.example` (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, `AGENTGLOB_APP_WRITE_KEY`).

## Verification (end-to-end)

- **Phase 0**: `npm test` (mocked SSH). Then live `curl` with the write key: GET new user → `exists:false`;
  PUT (create) → 200; GET → content + etag; PUT stale `If-Match` → **409**; >64 KB body → **413**;
  malformed markers → **422**; `?force=1` overrides + audit line written (no content); read key on PUT → **401**.
- **Havaya**: wrong creds → rejected + rate-limited (IP+username); prod env unset → admin disabled
  (fail-closed). `/admin` table shows name/last usage/chat count. Open editor → edit `User_D_Prompt`
  → Save → load that user's home hub → **prompts refreshed right of chat** (revalidateTag). Concurrency:
  change the file out-of-band, then admin Save with stale etag → **conflict surfaced**, force-save works.
- Gates: app side `npx tsc --noEmit` + `eslint`; dashboard side `tsc` + its tests. **Never** `npm run build`
  on Havaya (runs `prisma migrate deploy`).

## Delivery & order

1. **Commit this plan to git** with the Codex code-review instructions below (after plan approval / exit
   plan mode). Target: `Havaya_App/docs/ADMIN_SECTION_PLAN.md` (primary) — mirror the Phase-0 portion into
   `openclaw-dashboard` if reviewed there.
2. **Phase 0** in `openclaw-dashboard` (raw GET/PUT, atomic SFTP, tests) → PR → its deploy. *Blocks Save.*
3. **Phases 1–3** in `Havaya_App` (admin auth + dashboard + editor) → PR.
4. **Phase 4** wiring + full smoke test.
- ⚠️ `app.havaya` prod deploy is currently **stale** (open favicon-deploy issue) — admin won't appear in
  prod until that's resolved.

## Code-review instructions for Codex

**Repos / branches to review (in order):**
1. `openclaw-dashboard` — branch `feat/user-file-raw-rw`. Focus: the raw `route.ts` + `user-file-core.ts`
   changes. **Security-critical** — review: app-key vs **write-key** separation; `SAFE_USERID` filename
   derivation (path traversal); **ETag/If-Match** correctness (no lost updates); **atomic SFTP** write
   (temp→verify→rename, no shell injection of raw content); 64 KB caps; marker fail-closed; audit logs
   never contain content; confirm raw access doesn't expose agent-private data (app-owned boundary).
2. `cryptolir/app.havaya` — branch `feat/admin-section`. Focus: admin cookie auth (HMAC, httpOnly,
   constant-time, **prod fail-closed**, no plaintext default in prod); IP+username login limiter;
   `/admin/*` route guarding; the save route enforcing If-Match + write key; `revalidateTag` correctness;
   no app/write key leakage to the client.

**How to review:** `git fetch && git checkout <branch>`; read the critical files above; run the route
tests (`npm test`) in `openclaw-dashboard`; `npx tsc --noEmit` + `eslint` in `app.havaya`. Post findings
as PR review comments grouped Blockers / Should-fix / Nits. Do **not** run `npm run build` in `app.havaya`.
