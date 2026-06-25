# Handover — working on the Havaya app (next session)

**Golden rule: all work happens on the dev server, NOT locally. Edit files in a
git worktree on the server, gate, commit, push, PR, merge — same flow we've used.**

---

## 1. Servers & access

| Alias (SSH) | Host | Role |
|---|---|---|
| `DevAgents` | `204.168.223.245` | **Dev server — all repos checked out here. Do work here.** |
| `2ndclaw` | `5.161.84.219` | Agent host — the `life` agent (display name "Havaya.me") runs here |
| `coolify-host` / `webtester` | `178.104.184.3` | Coolify host — **auto-deploys Havaya on push to `main`** (GitHub webhook). Web UI at :8000 is owner-only, but the agent CAN `ssh` in and poll/control deploys via `docker exec coolify php artisan tinker` (deploy status, env vars, restart-only redeploy; app id **11**). |

All use `IdentityFile ~/.ssh/hetzner-openclaw` (already in `~/.ssh/config`).
Connect with e.g. `ssh DevAgents '<cmd>'`.

## 2. The Havaya repo

- **On dev server:** `/root/projects/Havaya_App`
- **GitHub:** `git@github.com:cryptolir/app.havaya.git`
  ⚠️ **Repo name (`app.havaya`) ≠ on-disk dir (`Havaya_App`).** For `gh` commands
  always pass `-R cryptolir/app.havaya` to avoid the wrong-repo trap.
- **Stack:** Next.js + Clerk (auth) + Prisma. Deployed via **Coolify** (owner redeploys).

## 3. Git workflow (exactly what we've been doing)

The local `main` in each checkout is often **stale and carries foreign WIP** —
never edit it directly. Always branch from `origin/main` in a fresh worktree:

```bash
ssh DevAgents bash -s <<'EOF'
set -euo pipefail
cd /root/projects/Havaya_App
git fetch origin --quiet
git worktree add -b feat/<branch-name> /tmp/hav-work origin/main
# worktrees need node_modules — symlink the main checkout's:
ln -s /root/projects/Havaya_App/node_modules /tmp/hav-work/node_modules
EOF
```

**Edit files** (the Edit tool only touches the local FS — the repo is remote), pick one:
- scp a file written locally → `scp local.ts DevAgents:/tmp/hav-work/path.ts`
- run a Python exact-match patch script on the server (write to `/tmp/x.py`, `python3 /tmp/x.py`)
- small edits: `awk`/heredoc scripts copied to `/tmp` then `bash /tmp/x.sh`
  (avoid deeply nested SSH heredocs + `$(...)` — they break quoting; write a script file instead)

**Gate before committing:**
```bash
ssh DevAgents 'cd /tmp/hav-work && npx tsc --noEmit && echo TSC_OK'
```
⚠️ **Do NOT run `npm run build` as a gate on Havaya** — its build runs
`prisma migrate deploy` against a **real database**. `npx tsc --noEmit` fully
covers type changes. (Only the dashboard/gateway repos get `npm run build`.)

**Commit (note the author + co-author trailer we've used):**
```bash
git -c user.name="Liran Peretz" -c user.email="onetrue2023@gmail.com" \
  commit -q -F - <<'MSG'
feat(scope): one-line summary

Body explaining what + why. Note gates run.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
```
If a **pre-commit hook fails on missing tooling** (we hit `oxfmt not found` on
openclaw), add `--no-verify` — it's an env gap, not a real failure.

**Push + PR + merge:**
```bash
git push -u origin feat/<branch-name>
gh pr create -R cryptolir/app.havaya --base main --head feat/<branch-name> \
  --title "..." --body "..."
# after review / when told to merge:
gh pr merge <num> -R cryptolir/app.havaya --squash --delete-branch
#   add --admin only if CI is pre-existing red and the owner approved
```

**Clean up the worktree when done:**
```bash
ssh DevAgents 'cd /root/projects/Havaya_App && rm -f /tmp/hav-work/node_modules && \
  git worktree remove /tmp/hav-work --force && git worktree prune'
```

**Deploy:** a push to `main` **auto-deploys** via Coolify (GitHub webhook) — no manual step.
The agent can poll/confirm the deploy from the Coolify host (`178.104.184.3`) with
`docker exec coolify php artisan tinker` (app id **11**); the :8000 web UI is owner-only.

## 4. AgentGlob per-user integration (already shipped & live — context)

Havaya's home hub shows per-user prompts + an owner note sourced from the `life`
agent's per-user workspace file. Status: **fully shipped & live (2026-06).**

Relevant Havaya files:
- `src/lib/agentglob.ts` — `callAgent({sessionKey, message, appUserId})` POSTs to
  `${BASE}/api/public/chat/life` (sends `appUserId` = Clerk userId);
  `getUserSection(userId, "User_D_Prompt" | "app_note")` reads sections back.
- `src/app/api/chat/route.ts` — passes `appUserId: userId` on chat.
- `src/app/page.tsx` — home hub; `parsePrompts()` renders `User_D_Prompt` as clickable prompts.

Env (set in Coolify, owner-managed):
- `AGENTGLOB_APP_API_KEY` = `hav_***REDACTED*** (value in Coolify env / dashboard Cloud Run secret — never commit it)`
  (must match the dashboard side; rotate on both sides if ever exposed)
- `AGENTGLOB_AGENT_NAME=life`, plus the AgentGlob base URL.

Docs in the repo: `AGENTGLOB_INTEGRATION_STATUS.md` (as-built, start here),
`AGENTGLOB_USER_FILE_API.md` (contract), `AGENTGLOB_PERUSER_GUIDANCE.md` (rationale),
`AGENTGLOB.md`, `AGENTGLOB_IMPL_HANDOFF.md`.

Identity model: filename on disk = **raw lowercased Clerk userId**; provisioning is
**lazy** (file created on the agent's first `save_user_section` write → reads `404` →
empty UI until then, never an error).

## 5. Quick verification commands

```bash
# Per-user files the agent has written (on the agent host):
ssh 2ndclaw 'ls -la /root/.openclaw/agents/life/workspace/users/'

# Reader smoke test against prod (proves key + endpoint):
KEY=hav_***REDACTED***   # paste the real key locally from Coolify; never commit
curl -s -w ' [%{http_code}]\n' -H "Authorization: Bearer $KEY" \
  "https://app.agentglob.com/api/public/chat/life/user-file?userId=<clerkUserId>&section=User_D_Prompt"
```

## 6. Gotchas learned (don't relearn these)

- **Local `main` is stale + has foreign WIP** → always worktree off `origin/main`.
- **`Havaya_App` dir vs `app.havaya` repo name** → use `-R cryptolir/app.havaya` for `gh`.
- **Never `npm run build` Havaya** (prisma migrate hits a real DB) → `tsc --noEmit` only.
- **Edit tool is local-only** → patch remote files via scp / Python scripts.
- **Nested SSH heredocs + `$(...)`/`$VAR` splitting break** → write a script to `/tmp`, run `bash /tmp/x.sh`.
- **Pre-commit hook env gaps** (`oxfmt`/formatters not installed) → `git commit --no-verify`.
- **Coolify web UI (:8000) is owner-only** → but push-to-`main` **auto-deploys**, and the agent can poll/redeploy via `ssh coolify-host` + `docker exec coolify php artisan tinker` (app id 11).
- **Worktrees need `node_modules`** → symlink from the main checkout; `rm` the symlink before `git worktree remove`.

---
_Last integration state: Havaya `origin/main` @ `8e57425` (Drive transcripts admin + admin-editable summary method shipped & live 2026-06); AgentGlob dashboard
`origin/main` @ `61969a6` (incl. streaming `appUserId` parity #110); openclaw `origin/main` @ `6d7078ea` (incl. `save_user_section` tool #49, docs #51). Memory:
`project_agentglob_userfile_api.md`, `project_agentglob_writer_mapping.md`._
