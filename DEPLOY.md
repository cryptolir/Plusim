# Plusim — Deployment Protocol

## Core principles

These three rules govern all work on this project. They override convenience.

1. **Git is the source of truth.** The `main` branch of `cryptolir/Plusim` is canonical. The dev server working copy and the prod deployment on Coolify must both match it. Never let them diverge.
2. **Every push to prod goes through git.** No out-of-band deploys, no editing on the prod server. Every prod release is a git commit pushed to `main` — Coolify auto-deploys from the webhook.
3. **All dev work happens on the dev server.** Edit via SSH on `204.168.223.245`, never on a local clone. The dev server has the right toolchain, env files, and database container.

## Servers

| Role | IP | Access |
|---|---|---|
| Dev / code | `204.168.223.245` | `ssh -i ~/.ssh/hetzner-openclaw root@204.168.223.245` |
| Prod / Coolify | `178.104.184.3` | Coolify dashboard: `http://178.104.184.3:8000` |

## How deploys work

**One command from the dev server deploys to prod:**

```bash
cd /root/projects/Plusim
./deploy.sh "your commit message"
```

This script:
1. Stages all changes (`git add -A`)
2. Commits with the provided message (or a timestamp if none given)
3. Pushes to `origin/main` on GitHub (`cryptolir/Plusim`)
4. Coolify auto-deploys via GitHub webhook → `https://plusim.xyz`

## Coolify app config (Plusim on 178.104.184.3)

| Field | Value |
|---|---|
| Repository | `cryptolir/Plusim` |
| Branch | `main` |
| Build command | `pnpm install --frozen-lockfile && pnpm prisma generate && pnpm prisma migrate deploy && pnpm build` |
| Start command | `pnpm start` |
| Port | `3000` |
| Domain | `https://plusim.xyz` |

## Environment variables (set in Coolify UI, never committed)

| Key | Notes |
|---|---|
| `DATABASE_URL` | Internal Coolify Postgres URL from Plusim_DB service |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API Keys |
| `CLERK_SECRET_KEY` | Clerk dashboard → API Keys |
| `AGENTGLOB_AGENT_NAME` | `onlyclaw` |

## Database migrations

Migrations run automatically during every deploy as part of the build command
(`pnpm prisma migrate deploy`). They are idempotent — safe to re-run.

To run a migration manually from the dev server:
```bash
cd /root/projects/Plusim
DATABASE_URL="<url>" pnpm prisma migrate dev --name <migration-name>
```

Then commit and push — the deploy will apply it to prod.

## Dev server local setup

Postgres (Docker):
```bash
docker start plusim-postgres-dev   # if stopped
```

Run locally:
```bash
cd /root/projects/Plusim
pnpm dev --port 3000
```

Access via SSH tunnel from local machine:
```bash
ssh -i ~/.ssh/hetzner-openclaw -L 3000:localhost:3000 root@204.168.223.245 -N
```

## Coolify webhook (auto-deploy on push)

In Coolify → Plusim → Settings → enable **Auto Deploy** and copy the
**Webhook URL**. Add it to GitHub repo → Settings → Webhooks. After that,
every `git push origin main` triggers a prod deploy automatically.

If the webhook is not yet configured, trigger a manual deploy from the
Coolify dashboard.

## Rollback

In Coolify → Plusim → Deployments → click any previous successful
deployment → **Rollback**. The old build is re-activated immediately.
