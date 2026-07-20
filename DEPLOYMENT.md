# Plusim — Deployment Plan & As-Built Record

Plusim is the Havaya app pattern re-deployed as a financial-guidance chat app on
the AgentGlob agent `onlyclaw`. This file is the plan that was executed and the
as-built record of the live deployment.

> **Historical record.** This documents the one-time Havaya→Plusim migration. For
> the ongoing deploy protocol and env vars, see [DEPLOY.md](./DEPLOY.md).

## Plan (template → new app)

1. Clone `cryptolir/Plusim` on the DevAgents server; seed it from the Havaya
   reference codebase (`rsync`, excluding `.git`/`node_modules`/`.next`/env).
2. Rebrand Havaya → Plusim: `APP_NAMESPACE="plusim"`, `AGENTGLOB_AGENT_NAME=onlyclaw`,
   `app.havaya.me` → `plusim.xyz`, product copy → financial guidance (no regulated
   "investment advice" claims), rename runtime hook, drop Havaya-only
   journey/community/video/Instagram surface, add public `/api/health`.
3. Build + verify on DevAgents (typecheck, lint, `next build`, runtime smoke).
4. Push to `main` (source of truth for Coolify).
5. Coolify: create the app from `cryptolir/Plusim` (GitHub App source), a
   `Plusim_DB` Postgres service, env vars, deploy.
6. Namecheap DNS: A `@` and `www` → 178.104.184.3 (remove parking records).
7. Verify production (HTTPS, health, agent, auth gate), update README.

## As-built

| Item | Value |
|---|---|
| Repo | `cryptolir/Plusim` (`main`) |
| Dev | DevAgents `/root/projects/Plusim` (`pnpm dev --port 3001`, DB `plusim-postgres-dev` :5434) |
| Agent | `onlyclaw` — `https://app.agentglob.com/api/public/chat/onlyclaw` |
| Session key | `app:plusim:<userId>:<conversationId>` |
| Host | Coolify @ 178.104.184.3, project "Vcode - Hosting" / production |
| App | nixpacks, port 3000, `NIXPACKS_NODE_VERSION=20` |
| Build | `pnpm install --frozen-lockfile && pnpm prisma generate && pnpm prisma migrate deploy && pnpm build` |
| Start | `pnpm start` |
| DB | `Plusim_DB` (postgres:16-alpine) |
| Domain | `https://plusim.xyz`, `https://www.plusim.xyz` (Let's Encrypt) |
| Auth | Clerk dev instance `brave-hawk-16.clerk.accounts.dev` |

## Build gotcha (important for future clones)

Do **not** commit a `pnpm-workspace.yaml`. pnpm 11 on the dev box auto-generates a
malformed one (`allowBuilds:` placeholders, no `packages:` field) that breaks the
pnpm-9 Nixpacks build with `ERROR packages field missing or empty`. The build-script
allowance already lives in `package.json` → `pnpm.onlyBuiltDependencies`.

## Outstanding

- `CLERK_SECRET_KEY` in Coolify is a placeholder. Sign-in completes only after the
  real `sk_test_…` from the Plusim Clerk dashboard is set in Coolify env + redeploy.
