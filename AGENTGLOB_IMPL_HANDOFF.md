# AgentGlob-side implementation handoff — per-user **user-file section API**

> **Purpose:** kickoff note for a **new dev session on the AgentGlob / OpenClaw side** to build the one endpoint that unblocks Havaya home-hub Phase 2 (per-user prompts panel + owner note).
> **Authored from the Havaya side** (Havaya's half is fully built & deployed). This doc gathers the connection details, dev protocol, and a complete checklist drawn from the three source docs in this repo:
> [`AGENTGLOB_USER_FILE_API.md`](./AGENTGLOB_USER_FILE_API.md) (contract) · [`AGENTGLOB_PERUSER_GUIDANCE.md`](./AGENTGLOB_PERUSER_GUIDANCE.md) (why/how to back it) · [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) Addendum 5 (integration boundary).
> **This work is AgentGlob-side only** — it could not be done from the Havaya session because of Havaya's hard project boundary.

---

## 1. Mission
Build a per-user, app-key-scoped reader that returns a **named section** from a user's agent-workspace file, plus the section **allowlist**, an **app API key** for Havaya, and the agent-side **writer** that populates the sections. Once shipped + the key is set in Havaya's Coolify env, the prompts panel and owner note light up with **no further Havaya code change**.

## 2. Connect — host, key, repos, folders
```bash
ssh -i ~/.ssh/hetzner-openclaw root@204.168.223.245   # same dev host as Havaya
```
| Thing | Value |
|---|---|
| Dev host | `root@204.168.223.245` (key `~/.ssh/hetzner-openclaw`) |
| **Dashboard repo** (the HTTP endpoint goes here) | `cryptolir/openclaw-dashboard` → `/root/projects/openclaw-dashboard` |
| **Gateway/worker repo** (agent file access + writer) | `cryptolir/openclaw` → `/root/projects/openclaw` |
| Agent hosts (per-user files physically live here) | EU prod `root@89.167.70.46`, US standby `root@5.161.84.219` |
| `life` agent config (allowlist) | `/root/.openclaw/agents/life/openclaw.json` **on the agent host** |
| Public API base | `https://app.agentglob.com/api/public/chat/life` |
| Havaya specs (read-only, same host) | `/root/projects/Havaya_App/AGENTGLOB_*.md` |

## 3. AgentGlob dev protocol (follow exactly — differs from Havaya)
- **Package manager: `npm`** (there is `package-lock.json`; no pnpm). Do **not** use pnpm.
- **Session start:** `cd /root/projects/openclaw-dashboard && git checkout main && git pull --rebase origin main && npm install`
- **Gate before PR:** `npx tsc --noEmit` clean. **Skip `npm run lint`** (`next lint` unconfigured/interactive — pre-existing).
- **Deploy = PR → squash-merge to `main`.** GitHub Actions runs tsc + build + deploy to Cloud Run. CI triggers **only on push to `main`, not PRs**. (Not Havaya's `./deploy.sh` direct-push flow.)
- **Gateway changes** (`cryptolir/openclaw`): deploy manually via `/opt/openclaw-ops/scripts/build-and-push.sh` then `deploy.sh vYYYY.MM.DD.N`. **Never** ad-hoc `docker`.
- **New-endpoint house style:** `export const dynamic = "force-dynamic"`; auth via `authenticateRuntimeRequest`; OPTIONS via `runtimeOptionsRejection()`. Reference: `app/api/runtime/rain/build-create-market/route.ts`. Validators: `lib/rain-runtime.ts`. **Document the endpoint** in `docs/api/<area>-runtime.md` (see `rain-runtime.md`, `wallet-runtime.md`).
- **Non-stock Next.js:** read `node_modules/next/dist/docs/` before writing Next.js code (AGENTS.md rule).
- **Known issues — do NOT chase:** 4 crash-looping agents (researcher/agentav/designer/raingame, mcp-bridge EPIPE); `next lint` unconfigured; dev host has **no GCP creds** → can't fully run the chat page locally, test against the deployed gateway.

## 4. Read these first (same host, read-only)
```bash
sed -n '1,220p' /root/projects/Havaya_App/AGENTGLOB_USER_FILE_API.md     # the contract (primary)
sed -n '1,120p' /root/projects/Havaya_App/AGENTGLOB_PERUSER_GUIDANCE.md  # file-route-not-memory; what to verify
# Integration boundary: IMPLEMENTATION_PLAN.md Addendum 5
```
GitHub (private — needs repo access): `AGENTGLOB_USER_FILE_API.md`, `AGENTGLOB_PERUSER_GUIDANCE.md`, `IMPLEMENTATION_PLAN.md` in `cryptolir/app.havaya`.

## 5. Design decisions already locked (do NOT relitigate)
- ✅ **Back it with the FILE route** (`users/<user>.md`-style per-user file, sections inside) — **NOT** the memory plugin (Hindsight/Vectorize). The fields are owner-edited, displayed verbatim, must be byte-addressable; vector recall is the wrong primitive. (Guidance §0/§2.)
- ✅ **Partitioning stays app-owned.** Havaya isolates users at the app layer via `sessionKey`. **Do NOT introduce `dmScope` into the web path** — `dmScope` is for messaging-platform ingress only and is out of scope here. (Guidance §1/§5.4; Addendum 5.)
- ✅ **sessionKey format:** Havaya mints **`app:havaya:<userId>:<conversationId>`** (4-part). **Legacy conversations keep 3-part `app:<userId>:<conversationId>`.** Your userId derivation must accept **both**: `<userId>` is **index 2** (namespaced) or **index 1** (legacy). The per-user file is keyed off that `<userId>`. (API §3.)
- ✅ **Allowlisted sections (this phase):** `User_D_Prompt`, `app_note`. Marker format: `<!-- app:<name>:start -->…<!-- app:<name>:end -->`, **exactly once per file**.
- ✅ **Batch endpoint is DEFERRED** — build the single-section form only; do not build `?sections=` now.
- ⏸️ **Cross-platform identityLinks: defer** — only relevant if `life` later gets a direct messaging surface.

## 6. Where the work lands
**a. HTTP route (dashboard).** Create `app/api/public/chat/[agentName]/user-file/route.ts` — sibling of the existing `[agentName]/route.ts`.
> ⚠️ The spec's reference impl uses `[agent]`/`params.agent`; **this repo's dynamic segment is `[agentName]`/`params.agentName`** — use that.
> Implement: app-key auth (`resolveApp` → app namespace) → `400` validate `agentName`/`userId`/`section` against `^[A-Za-z0-9._:-]+$` (+ **64 KB** section cap) → allowlist check → fetch user file → marker-scoped slice → `ETag` + `304` on `If-None-Match` → headers `ETag`, `Vary: Authorization`, `Cache-Control: private, max-age=60`. Response `{agent, userId, section, content, fileUpdatedAt}` (`fileUpdatedAt` = file mtime, not section-level).
> **Security must-haves (API §4):** §4.7 **never map `userId` to a path** — hash/encode (`sha256(appId:userId)`) + path-containment check, reject `..`; §4.8 **duplicate markers → `500` + log** (never guess); **`404` not `403`** with the **same body** for not-allowlisted / unknown user / cross-app (don't leak which); read-only.

**b. Reading the per-user file (gateway).** The dashboard reaches agent containers via `gatewayRPC` / `gatewayRPCForHost` in `lib/gateway-client.ts`. **Investigation task #1:** find or add a gateway RPC that returns a named user's workspace-file content for an agent. If none exists, that's a `cryptolir/openclaw` (gateway) change + a dashboard client call.

**c. App API key.** Mint/issue Havaya a server-side app key resolvable via `resolveApp(bearer)` → app namespace. Return the value to the user (see §9). **Never in git / never to the browser.**

**d. Section allowlist.** On the `life` agent: `/root/.openclaw/agents/life/openclaw.json` (agent host) → `{ "public": { "sections": ["User_D_Prompt", "app_note"] } }`. Default empty = opt-in.

**e. The writer (agent-side).** Define *how* `User_D_Prompt` + `app_note` get written into each user's file — agent tool/skill, owner/admin command/UI, background job, first-chat-turn seeding, or direct edit (API §4.5) — using the markers, keyed by the sessionKey `userId`.

## 7. Investigate-first unknowns = the 5 questions to answer back (Guidance §6)
1. **Native per-user file scoping?** Does this OpenClaw version already keep `users/<user>.md` per sender? If yes, the read RPC is a thin wrapper.
2. **Provisioning model** — lazy (file created on first write) vs at-signup. Havaya is fine with **lazy** (degrades to empty UI on 404).
3. **Writer mechanism** (6e) — must be explicit before content can appear.
4. **Confirm** the read contract + allowlist (`User_D_Prompt`, `app_note`) is unaffected by your backing store.
5. **Issue the app API key** (→ Havaya sets `AGENTGLOB_APP_API_KEY`).

## 8. Done when (acceptance — API §7/§9)
- [ ] `GET …/life/user-file?userId=&section=User_D_Prompt` + app key → `200 {content, fileUpdatedAt}`
- [ ] no key → `401`; missing/invalid `agentName`/`userId`/`section` → `400`; section >64 KB rejected
- [ ] non-allowlisted (`SOUL`) → `404`; cross-app / unknown user → `404`; **same body for all 404s** (no existence leak)
- [ ] `userId` → **hashed/encoded** filename + path-containment check; traversal (`../../etc/passwd`) → `400/404`, never a real FS read
- [ ] duplicate section markers → `500` + operator log
- [ ] only the marked bytes returned (never whole file / other sections)
- [ ] `ETag` returned; `If-None-Match` match → `304`; `Vary: Authorization` present on `200`
- [ ] allowlist defaults empty (no change for existing agents)
- [ ] writer / provisioning mechanism documented; endpoint documented in `docs/api/…-runtime.md`
- [ ] `npx tsc --noEmit` clean; PR squash-merged to `main`

## 9. Hand back to Havaya (only 2 things)
1. **Issue the app API key** → give the user the value. Havaya sets it as `AGENTGLOB_APP_API_KEY` in the Coolify env for `app.havaya` (server-side; never browser/git). That single env var lights up the prompts panel + owner note — no Havaya code change.
2. **Answer the 5 questions** in `AGENTGLOB_PERUSER_GUIDANCE.md` §6 (incl. writer mechanism).

## 10. Boundary & don't-touch
- Work in `openclaw-dashboard` / `openclaw` only. **Do NOT edit `/root/projects/Havaya_App`** — read its specs read-only; Havaya's side is finished.
- Don't deploy via Havaya's `./deploy.sh`. Don't run ad-hoc docker. Don't chase the known crash-looping agents.

## 11. Cheat-sheet (from infra memory)
```bash
# smoke test the live agent
curl -sS -X POST 'https://app.agentglob.com/api/public/chat/life' \
  -H 'content-type: application/json' \
  --data '{"message":"Reply with exactly: smoke-ok","sessionKey":"smoke-test"}'

# gateway logs (on an agent host)
docker logs life-openclaw-gateway-1 --tail 50

# gateway auth token for an agent
python3 -c "import json; print(json.load(open('/root/.openclaw/agents/life/openclaw.json'))['gateway']['auth']['token'])"
```

> **Verify-on-arrival:** the protocol/paths above came partly from a 3-day-old infra note. The repo folders, the `[agentName]` segment, and `gateway-client.ts` were verified live on 2026-05-31; the **gateway file-read RPC** existence was **not** — that's investigation task #1 (§6b).
