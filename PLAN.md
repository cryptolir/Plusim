# Havaya — Project Plan

The high-level guide for what we're building, why, and where it's going. For day-to-day backlog see [ROADMAP.md](./ROADMAP.md). For technical design see [ARCHITECTURE.md](./ARCHITECTURE.md). For shipping see [DEPLOY.md](./DEPLOY.md).

## What Havaya is

A chat-based AI life companion. Users have personal conversations with a guidance / reflection agent powered by AgentGlob (agent slug: `life`). Conversations are persistent, signed-in, and accessible at `https://app.havaya.me`.

## Why

People need on-demand access to a thoughtful conversation partner — for processing decisions, working through stuck moments, reflecting on patterns, or just thinking out loud. Existing chatbots are either generic, overloaded with productivity features, or framed as therapy / coaching services. Havaya is a single-purpose, focused space for that conversation, tuned by the `life` agent's training and prompting.

## Core principles

The three working rules in [AGENTS.md](./AGENTS.md) govern all work on this codebase:

1. **Git is the source of truth.** The `main` branch is canonical. Dev server + prod must match it.
2. **Every push to prod goes through git.** Use `./deploy.sh` — no out-of-band deploys.
3. **All dev work happens on the dev server.** Edit via SSH. No local clones.

## Scope (v1)

**In scope:**
- `/chat` page — clean, mobile-first chat UI with the `life` agent
- Clerk auth — sign-in, sign-up, signed-in user controls
- Conversation persistence — Postgres-backed transcript per user
- Section CTA pattern — links from elsewhere can seed messages and contextual hints
- Rate limiting (in-memory, 20 msg/min/user)

**Out of scope for v1** (tracked in [ROADMAP.md](./ROADMAP.md)):
- Streaming responses (blocked on AgentGlob exposing SSE on the public route)
- Message attachments
- Multi-agent picker
- Conversation history sidebar
- Persistent rate limiting (Upstash)
- Marketing / landing pages

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Clerk · Prisma 5.22 · Postgres · Coolify · [assistant-ui](https://github.com/assistant-ui/assistant-ui).

Dev server: `204.168.223.245`. Prod server: `178.104.184.3`. Live URL: `https://app.havaya.me`.

## Documentation map

- [ROADMAP.md](./ROADMAP.md) — backlog, in-dev, shipped, feature dependencies
- [ARCHITECTURE.md](./ARCHITECTURE.md) — AgentGlob API, route map, data model, design patterns
- [DEPLOY.md](./DEPLOY.md) — deployment protocol, env vars, rollback
- [AGENTS.md](./AGENTS.md) — working rules for agents (human and AI)
- [AGENTGLOB.md](./AGENTGLOB.md) — how we use AgentGlob, integration constraints, feedback to their team
- [.env.example](./.env.example) — env vars needed to run the app
