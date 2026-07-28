<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

# Plusim — Core working principles

These rules apply to any agent (human or AI) working on this codebase. They override convenience.

## 0. Hard boundary: stay inside this project

**Only ever read or edit files that belong to Plusim** — the repo working copy at `/root/projects/Plusim` on the dev server, and this project's own config (e.g. its `CLAUDE.md` / `AGENTS.md`).

Never touch files in any other project or directory — not on the dev server, not on a local machine, not in a sibling repo — even if they look related (e.g. a separate `agentglob` directory with its own `AGENTS.md`). Other projects have their own context files; editing them to sync or match Plusim is a mistake that silently destroys their content.

If you think a change belongs in another project, **stop and ask the user** — do not act across the boundary on your own.

## 1. Git is the source of truth

The `main` branch of `cryptolir/Plusim` on GitHub is the canonical state of this project. The dev server working copy at `/root/projects/Plusim` and the prod deployment on Coolify must both match it. Never let them diverge.

If you cannot reproduce a prod state from a git commit on `main`, it is a bug — fix it by committing the divergence, not by ignoring it.

## 2. Every push to prod goes through git

There are no out-of-band deploys. To ship anything to `https://plusim.xyz`, you commit and push to `main`. Coolify auto-deploys from there via the GitHub webhook.

Use the helper:
```bash
cd /root/projects/Plusim
./deploy.sh "commit message"
```
It stages, commits, and pushes in one step. Never SSH into the prod server to edit files in place — that breaks rule 1.

## 3. All dev work happens on the dev server

The dev server (`ssh -i ~/.ssh/hetzner-openclaw root@204.168.223.245`, project at `/root/projects/Plusim`) has the right Node version, pnpm, Postgres container (`plusim-postgres-dev`), and `.env` / `.env.local` files. Do not edit a local clone — your local environment will desync from git and from prod.

If you need to view or test changes from your laptop, SSH-tunnel into the dev server (`ssh -i ~/.ssh/hetzner-openclaw -L 3000:localhost:3000 root@204.168.223.245 -N`) — do not pull the repo down.

## 4. User-facing changes update the Hebrew guides

The end-user documentation lives in [`docs/guides/`](./docs/guides/) — one guide for clients, one for admins, both in Hebrew (RTL), versioned with the code so they ship together.

**If a change alters what a person sees or clicks, update the matching guide in the same PR.** A new page, a renamed button, a new setting in `/admin/settings`, a change to the report workflow or the `/report` view — all of it belongs in the guide before the PR is done. Quote the app's real Hebrew labels, and bump the "עודכן לאחרונה" date.

Full contract (what counts as user-facing, style rules): [`docs/guides/README.md`](./docs/guides/README.md).

---

## Infrastructure reference

### Servers

| Role | Host | Notes |
|---|---|---|
| **Dev server** | `root@204.168.223.245` | All coding, `pnpm dev`, migrations |
| **Prod server** | `root@178.104.184.3` | Coolify at :8000 — never edit files here directly |

SSH key for both: `~/.ssh/hetzner-openclaw`

### SSH access

```bash
# Dev server
ssh -i ~/.ssh/hetzner-openclaw root@204.168.223.245

# Local preview tunnel (dev server → localhost:3000)
ssh -i ~/.ssh/hetzner-openclaw -L 3000:localhost:3000 root@204.168.223.245 -N
```

### Project paths (dev server)

```
/root/projects/Plusim/    ← working copy (git remote = cryptolir/Plusim)
```

### Database (dev)

- Container: `plusim-postgres-dev`
- DSN: `postgresql://plusim:plusim_dev_pass@localhost:5434/plusim`
- Set in `.env` and `.env.local` (both gitignored)

Run migrations:
```bash
cd /root/projects/Plusim
pnpm prisma migrate dev
```

### Coolify (prod)

- Dashboard: `http://178.104.184.3:8000`
- App service: **Plusim** → deploys from GitHub `main` via webhook
- DB service: **Plusim_DB** → Postgres (env var `DATABASE_URL` set in Coolify UI, never in git)
- Live URL: `https://plusim.xyz`

### AgentGlob

- Agent slug: `onlyclaw`
- Public chat endpoint: `https://app.agentglob.com/api/public/chat/onlyclaw`
- All requests must be proxied through `/api/chat` — browser must never call AgentGlob directly (CORS)

Smoke test:
```bash
curl -sS -X POST 'https://app.agentglob.com/api/public/chat/onlyclaw' \
  -H 'content-type: application/json' \
  --data '{"message":"Reply with exactly: smoke-ok","sessionKey":"smoke-test"}'
```

### Dev server quick commands

```bash
# Start dev server
cd /root/projects/Plusim && pnpm dev --port 3000

# Check what's on port 3000
lsof -i :3000

# Run Prisma Studio
cd /root/projects/Plusim && pnpm prisma studio --port 5555

# Ship to prod
cd /root/projects/Plusim && ./deploy.sh "your message"
```

---

See `DEPLOY.md` for the full deployment protocol.
