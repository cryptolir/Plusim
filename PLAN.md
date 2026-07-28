# Plusim — Project Plan

The high-level guide for what we're building, why, and where it's going. For day-to-day backlog see [ROADMAP.md](./ROADMAP.md). For technical design see [ARCHITECTURE.md](./ARCHITECTURE.md). For shipping see [DEPLOY.md](./DEPLOY.md).

## What Plusim is

A financial-guidance app. Signed-in users have a focused chat with a financial planning / decision-support agent powered by AgentGlob (agent slug: `onlyclaw`), at `https://plusim.xyz`. Beyond chat, an admin can upload a client's credit-card statements and have the agent categorize them into a household budget report the client views in-app.

Conversations are persistent and signed-in. Plusim owns the web UI, auth, session routing, and transcript persistence; AgentGlob runs the agent.

## Why

People planning their finances need on-demand, practical guidance and a clear view of where their money goes. Plusim pairs a focused conversation with a concrete deliverable — a categorized, reconciled statement report — without the user touching a spreadsheet. It gives guidance, not regulated investment advice.

## Core principles

The three working rules in [AGENTS.md](./AGENTS.md) govern all work on this codebase:

1. **Git is the source of truth.** The `main` branch is canonical. Dev server + prod must match it.
2. **Every push to prod goes through git.** Use `./deploy.sh` — no out-of-band deploys.
3. **All dev work happens on the dev server.** Edit via SSH. No local clones.

## Scope

**Shipped (see [ROADMAP.md](./ROADMAP.md) for the full list):**
- Chat with the `onlyclaw` agent (home hub + full-screen `/chat`), Clerk auth, Postgres-backed transcripts
- Home hub — embedded chat + admin-managed prompts panel + owner note + recent chats
- Admin Google Drive meeting-transcripts + per-user folder assignment
- Statement-categorization pipeline (admin upload → agent → client `/report`)
- Admin settings control panel (`/admin/settings`) — agent behavior levers managed from the app

**Out of scope for now:** streaming responses (blocked on AgentGlob SSE), message attachments, multi-agent picker, persistent rate limiting.

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Clerk · Prisma · Postgres · Coolify · [assistant-ui](https://github.com/assistant-ui/assistant-ui).

Dev server: `204.168.223.245`. Prod (Coolify): `178.104.184.3`. Live URL: `https://plusim.xyz`.

## Documentation map

- [ROADMAP.md](./ROADMAP.md) — backlog, in-dev, shipped
- [ARCHITECTURE.md](./ARCHITECTURE.md) — AgentGlob API, route map, data model, design patterns
- [DEPLOY.md](./DEPLOY.md) — deployment protocol, env vars, rollback
- [AGENTS.md](./AGENTS.md) — working rules for agents (human and AI)
- [docs/guides/](./docs/guides/) — **Hebrew user guides** (client + admin); keep them current with every user-facing change
- [docs/REPORTS_PIPELINE.md](./docs/REPORTS_PIPELINE.md) — the statement-categorization pipeline
- [docs/DRIVE_INTEGRATION.md](./docs/DRIVE_INTEGRATION.md) — the admin Drive integration
- [docs/archive/](./docs/archive/) — historical Havaya-era planning docs
- [.env.example](./.env.example) — env vars needed to run the app
