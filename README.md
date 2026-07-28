# Plusim

Plusim is a financial guidance app powered by AgentGlob and the `onlyclaw` agent.

Live app: https://plusim.xyz

## What it does

Plusim gives signed-in users a focused chat interface for financial planning
conversations, decision support, and structured guidance.

The app uses AgentGlob as the agent runtime, while Plusim owns the web UI, user
authentication, session routing, and transcript persistence.

## Stack

Next.js 16 App Router · React 19 · TypeScript · Tailwind 4 · Clerk · Prisma · Postgres · Coolify · assistant-ui

## Agent

AgentGlob agent slug: `onlyclaw`

All browser chat requests are proxied through the app's own `/api/chat` route.
The browser never calls AgentGlob directly (CORS).

Session keys are namespaced as:

```text
app:plusim:<userId>:<conversationId>
```

## Documentation

- **User guides (Hebrew):** [`docs/guides/`](./docs/guides/) — [client](./docs/guides/CLIENT_GUIDE.he.md) · [admin](./docs/guides/ADMIN_GUIDE.he.md). Keep them current with every user-facing change ([contract](./docs/guides/README.md)).
- **Technical:** [ARCHITECTURE](./ARCHITECTURE.md) · [PLAN](./PLAN.md) · [ROADMAP](./ROADMAP.md) · [DEPLOY](./DEPLOY.md) · [reports pipeline](./docs/REPORTS_PIPELINE.md) · [Drive integration](./docs/DRIVE_INTEGRATION.md)
- **Working rules for agents:** [AGENTS.md](./AGENTS.md)

## Source of truth

The canonical source repo is `cryptolir/Plusim`. All development happens on the
DevAgents server and is synced back to this repo. Production deploys are made
from GitHub `main` through Coolify.

## Development

SSH into DevAgents and work from the project path:

```bash
ssh DevAgents
cd /root/projects/Plusim
```

Install and verify:

```bash
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm typecheck
pnpm build
```

Run the dev server (a different port than other apps on the box):

```bash
pnpm dev --port 3001
```

Local preview tunnel from your laptop:

```bash
ssh -i ~/.ssh/hetzner-openclaw -L 3001:localhost:3001 root@204.168.223.245 -N
# then open http://localhost:3001
```

Dev Postgres (Docker, port 5434):

```bash
docker start plusim-postgres-dev
```

## Production

Production is hosted on Coolify.

```text
Domain:     https://plusim.xyz
Repository: cryptolir/Plusim
Branch:     main
Port:       3000
Database:   Plusim_DB
Server:     178.104.184.3 (Coolify UI on :8000)
```

Coolify build command:

```bash
pnpm install --frozen-lockfile && pnpm prisma generate && pnpm prisma migrate deploy && pnpm build
```

Coolify start command:

```bash
pnpm start
```

## Required environment variables

Set in Coolify (and in a local `.env.local` for dev) — never commit secrets.

```env
AGENTGLOB_AGENT_NAME=onlyclaw
AGENTGLOB_APP_API_KEY=
AGENTGLOB_APP_WRITE_KEY=

DATABASE_URL=

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

ADMIN_EMAILS=

OPENAI_API_KEY=
```

Optional — only if the admin Drive transcript feature is enabled:

```env
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://plusim.xyz/admin/api/drive/callback
PLUSIM_DRIVE_ROOT_FOLDER_ID=
DRIVE_TOKEN_ENCRYPTION_KEY=
DRIVE_OAUTH_STATE_SECRET=
```

## Health check

```text
https://plusim.xyz/api/health
```

Expected response:

```json
{ "ok": true, "app": "plusim" }
```

## Deployment rule

Do not edit production files directly. Every production change must flow:

```text
DevAgents -> git commit -> GitHub main -> Coolify deploy
```
