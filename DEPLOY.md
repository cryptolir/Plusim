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
| `ADMIN_EMAILS` | Comma-separated Clerk emails granted `/admin` access |

### Statement-categorization pipeline (docs/REPORTS_PIPELINE.md)

| Key | Notes |
|---|---|
| `PLUSIM_AGENT_RUNTIME_TOKEN` | Static bearer for `/api/agent/*`. Generate `openssl rand -base64 32`; set the **same** value in the AgentGlob workspace secret `PLUSIM_RUNTIME_TOKEN` |
| `APP_BASE_URL` | `https://plusim.xyz` — used in manifest/file/callback links handed to the agent |

Raw statements are stored in each client's Google Drive folder, so the Drive
vars below are **required** for this feature (not just the meeting-transcripts
admin):

| Key | Notes |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud OAuth client (owner consent) |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://plusim.xyz/admin/api/drive/callback` |
| `PLUSIM_DRIVE_ROOT_FOLDER_ID` | The shared Drive root that contains every client subfolder |
| `DRIVE_TOKEN_ENCRYPTION_KEY` / `DRIVE_OAUTH_STATE_SECRET` | `openssl rand -base64 32` each |

## Report-dispatch worker (second Coolify service, same repo)

Report jobs are dispatched by a dedicated worker
(docs/plans/reports-scaling-stage1-2.md). Create it as a **second Coolify
service** from the same repo:

| Field | Value |
|---|---|
| Repository / Branch | `cryptolir/Plusim` / `main` (same as the web app) |
| Build command | `pnpm install --frozen-lockfile && pnpm prisma generate` |
| `NIXPACKS_NODE_VERSION` | **`22`** — required, not cosmetic: pg-boss needs node >=22.12.0, the build fails on 20 |
| Start command | `pnpm worker` |
| Replicas | `1` (dispatch concurrency 1 — do NOT raise before the Stage 2 gate) |
| Memory limit | 256 MB is plenty (it only holds HTTP calls) |
| Port / Domain | none — the worker serves no HTTP |

**The worker does NOT inherit the web service's environment.** Provision
exactly (asserted at boot — a missing var kills the worker at startup, naming it):

| Key | Notes |
|---|---|
| `DATABASE_URL` | Same Plusim_DB URL as the web app (pg-boss owns a `pgboss` schema in it) |
| `AGENTGLOB_AGENT_NAME` | `onlyclaw` |
| `APP_BASE_URL` | `https://plusim.xyz` — manifest links handed to the agent |
| `AGENTGLOB_APP_API_KEY` | Optional **today only** (warn-only): AgentGlob has not issued it yet, so `callAgent` sends it only when set. See the promotion note below. |

> **Follow-up — promote the app key to required (Codex round 10, F34).** AgentGlob's app-identity rollout is `accept → send → require` and is currently at *send*. The moment it starts **enforcing**, a worker booted without `AGENTGLOB_APP_API_KEY` will send every `callAgent` unauthenticated and exhaust the retries on every report dispatch — with no boot-time signal, because the assertion is warn-only. When AgentGlob issues the key, do both in one change: provision it on the web **and** worker services, and move it from `OPTIONAL_WORKER_ENV` to `REQUIRED_WORKER_ENV` in `src/worker/env.ts`. Requiring it before the key exists would make `assertWorkerEnv()` throw at startup in every environment, so the worker would not boot at all.

Deploy gate: after the first deploy, confirm the service log shows
`[worker] report-dispatch worker started` — and that a run pressed in
`/admin/reports` moves הועלה → נשלח לסוכן → בעיבוד.

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
