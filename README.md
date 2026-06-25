# Plusim
A financial advisor app based on Agent Glob tech 
# Plusim Deployment Agent Instructions

## Mission

Plan and execute the deployment of **Plusim**, a new client app based on the Havaya app pattern.

The new app must:

* Use the AgentGlob agent slug: `onlyclaw`
* Use `cryptolir/Plusim` as the source of truth
* Run from the custom domain `plusim.xyz`
* Be deployed through Coolify on the production server
* Be developed only from the DevAgents server
* Be synced back to the `cryptolir/Plusim` GitHub repo
* Have a README that matches the deployed Plusim app after deployment is complete

Do not edit `cryptolir/app.havaya` except to read it as the reference implementation.

---

## 0. Non-negotiable working rules

1. `cryptolir/Plusim` is the canonical repo for this project.
2. All development must happen on the DevAgents server.
3. Do not edit a local laptop clone.
4. Do not edit files directly on the Coolify production server.
5. Do not put secrets in git.
6. Every production deployment must be reproducible from a commit on `main`.
7. If a deployment state cannot be traced back to GitHub `main`, fix the repo, not the server.
8. Keep Havaya and Plusim fully separated. Never write Plusim changes into `/root/projects/Havaya_App`.

Preferred DevAgents access:

```bash
ssh DevAgents
```

Fallback if the alias is not available:

```bash
ssh -i ~/.ssh/hetzner-openclaw root@204.168.223.245
```

Production/Coolify server:

```text
178.104.184.3
Coolify UI: http://178.104.184.3:8000
```

---

## 1. Create the DevAgents working copy

On DevAgents:

```bash
mkdir -p /root/projects
cd /root/projects

git clone git@github.com:cryptolir/Plusim.git Plusim
git clone --depth 1 git@github.com:cryptolir/app.havaya.git _reference_app_havaya

cd /root/projects/Plusim
git checkout -b setup-plusim-deployment
```

If `Plusim` only contains `README.md` and `LICENSE`, copy the Havaya codebase into Plusim as the starting point:

```bash
cd /root/projects

rsync -av \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.env.production' \
  --exclude='*.log' \
  _reference_app_havaya/ Plusim/
```

Then:

```bash
cd /root/projects/Plusim
git status
```

Confirm that the git remote is `cryptolir/Plusim`, not `cryptolir/app.havaya`.

```bash
git remote -v
```

Expected:

```text
origin  git@github.com:cryptolir/Plusim.git
```

---

## 2. Adapt the app from Havaya to Plusim

Perform a careful rebrand and configuration migration.

### Required replacements

Update product/app references:

```text
Havaya        -> Plusim
havaya        -> plusim
app.havaya.me -> plusim.xyz
app.havaya    -> Plusim
havaya-app    -> plusim-app
Havaya_DB     -> Plusim_DB
havaya-postgres-dev -> plusim-postgres-dev
```

Do not blindly replace every lowercase `havaya` if it appears in historical migration names or comments where changing it could break deployed continuity. For the new Plusim app, code-level namespace values should be changed.

### Required AgentGlob changes

In `src/lib/agentglob.ts`, set:

```ts
export const APP_NAMESPACE = "plusim";
```

The generated session key must become:

```text
app:plusim:<userId>:<conversationId>
```

In `.env.example`, set:

```env
AGENTGLOB_AGENT_NAME=onlyclaw
```

All AgentGlob calls must continue to use the env var, not a hard-coded slug.

Expected public chat endpoint:

```text
https://app.agentglob.com/api/public/chat/onlyclaw
```

### Product copy

Replace Havaya “life companion” copy with Plusim-specific copy.

Use this positioning unless the client has provided better wording:

```text
Plusim is a financial guidance app powered by the AgentGlob agent `onlyclaw`. It gives signed-in users a focused chat interface for financial planning conversations, decision support, and structured guidance.
```

Avoid regulated claims such as:

```text
guaranteed returns
licensed financial advisor
investment recommendations
risk-free advice
```

Use “financial guidance” or “financial planning support” unless the client has confirmed regulated advisory status.

---

## 3. Confirm the `onlyclaw` AgentGlob setup

The AgentGlob agent setup page is already open in the local browser:

```text
https://app.agentglob.com/dashboard/openclaw-main/agents/UpVLQYKK41jQYgXDkhJC
```

Check the following:

* Agent slug/name is `onlyclaw`
* Public chat endpoint is enabled
* Display name, icon, and description are suitable for Plusim
* If per-user workspace-file reads are needed, generate or confirm `AGENTGLOB_APP_API_KEY`
* If admin raw user-file writes are needed, generate or confirm `AGENTGLOB_APP_WRITE_KEY`

Run smoke tests from DevAgents:

```bash
curl -sS -X POST 'https://app.agentglob.com/api/public/chat/onlyclaw' \
  -H 'content-type: application/json' \
  --data '{"message":"Reply with exactly: smoke-ok","sessionKey":"app:plusim:smoke:user"}'
```

Expected reply should contain:

```text
smoke-ok
```

Metadata test:

```bash
curl -sS 'https://app.agentglob.com/api/public/chat/onlyclaw'
```

Confirm the response has usable metadata such as display name, emoji/icon, and description.

---

## 4. Prepare the Plusim dev database

Use a separate dev Postgres container so Plusim does not collide with Havaya.

```bash
docker run --name plusim-postgres-dev \
  -e POSTGRES_USER=plusim \
  -e POSTGRES_PASSWORD=plusim_dev_pass \
  -e POSTGRES_DB=plusim \
  -p 5433:5432 \
  -d postgres:16
```

Create `.env.local` on DevAgents only:

```env
AGENTGLOB_AGENT_NAME=onlyclaw
AGENTGLOB_APP_API_KEY=
AGENTGLOB_APP_WRITE_KEY=

DATABASE_URL=postgresql://plusim:plusim_dev_pass@localhost:5433/plusim

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

ADMIN_EMAILS=

NEXT_PUBLIC_INSTAGRAM_URL=

GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://plusim.xyz/admin/api/drive/callback
PLUSIM_DRIVE_ROOT_FOLDER_ID=
DRIVE_TOKEN_ENCRYPTION_KEY=
DRIVE_OAUTH_STATE_SECRET=

OPENAI_API_KEY=
```

If the Drive integration is kept, rename the old Havaya-specific drive env var everywhere:

```text
HAVAYA_DRIVE_ROOT_FOLDER_ID -> PLUSIM_DRIVE_ROOT_FOLDER_ID
```

If Drive is not needed for Plusim v1, hide or disable the admin Drive UI and remove Drive setup from the required deployment checklist.

---

## 5. Add a health endpoint

Create this endpoint if it does not already exist:

```text
src/app/api/health/route.ts
```

Content:

```ts
export async function GET() {
  return Response.json({
    ok: true,
    app: "plusim",
    ts: new Date().toISOString(),
  });
}
```

This gives the deployment protocol a stable URL to check:

```text
/api/health
```

---

## 6. Install, build, and verify on DevAgents

From `/root/projects/Plusim`:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm prisma migrate dev --name initial_plusim
pnpm lint
pnpm build
```

If there is no explicit typecheck script, add this to `package.json`:

```json
"typecheck": "tsc --noEmit"
```

Then run:

```bash
pnpm typecheck
```

Start dev server on a different port than Havaya:

```bash
pnpm dev --port 3001
```

Local tunnel from laptop:

```bash
ssh -i ~/.ssh/hetzner-openclaw -L 3001:localhost:3001 root@204.168.223.245 -N
```

Then open:

```text
http://localhost:3001
```

Verify:

* Signed-out landing page says Plusim
* Sign-in works
* Chat sends to `onlyclaw`
* Conversation persists in Postgres
* Session key namespace is `app:plusim`
* `/api/chat/agent-info` returns `onlyclaw` metadata
* `/api/health` returns `{ ok: true, app: "plusim" }`
* No visible Havaya branding remains unless intentionally documented as historical origin

---

## 7. Push to GitHub

From `/root/projects/Plusim`:

```bash
git status
git add -A
git commit -m "feat: initialize Plusim app deployment"
git push origin setup-plusim-deployment
```

After review, merge into `main`.

If using direct merge on DevAgents:

```bash
git checkout main
git pull origin main
git merge --ff-only setup-plusim-deployment
git push origin main
```

After this point, `cryptolir/Plusim` `main` is the source of truth for Coolify.

---

## 8. Set up Coolify

Use the Coolify page already open in the local browser:

```text
http://178.104.184.3:8000/project/d10ismlhe2bbod8rxl8jflp8/environment/gn70ovswyrsc9ykj43tw1z8p
```

Create a new project/resource for the app.

### Coolify project/resource values

```text
Project name: Plusim
App/resource name: Plusim
Repository: cryptolir/Plusim
Branch: main
Build pack: Nixpacks / Next.js
Static site: disabled
Port exposes: 3000
Domain: https://plusim.xyz,https://www.plusim.xyz
Force HTTPS: enabled
Auto Deploy: enabled
```

### Build/start commands

Use the same deployment style as Havaya:

```text
Build command:
pnpm install --frozen-lockfile && pnpm prisma generate && pnpm prisma migrate deploy && pnpm build

Start command:
pnpm start

Port:
3000
```

If Coolify separates install/build/start fields, use:

```text
Install command:
pnpm install --frozen-lockfile

Build command:
pnpm prisma generate && pnpm prisma migrate deploy && pnpm build

Start command:
pnpm start
```

### Coolify database

Create a Postgres service in the same Coolify environment:

```text
Service name: Plusim_DB
Database: plusim
User: plusim
```

Copy the internal database URL from Coolify and set it as:

```env
DATABASE_URL=<internal Coolify Postgres URL>
```

### Coolify environment variables

Set these in Coolify, not in git:

```env
AGENTGLOB_AGENT_NAME=onlyclaw
AGENTGLOB_APP_API_KEY=
AGENTGLOB_APP_WRITE_KEY=

DATABASE_URL=

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

ADMIN_EMAILS=

NEXT_PUBLIC_INSTAGRAM_URL=

GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://plusim.xyz/admin/api/drive/callback
PLUSIM_DRIVE_ROOT_FOLDER_ID=
DRIVE_TOKEN_ENCRYPTION_KEY=
DRIVE_OAUTH_STATE_SECRET=

OPENAI_API_KEY=
```

Use Build + Runtime for values required during `next build` or `prisma migrate deploy`.

Use Runtime-only for secrets that are not required during build.

For `NEXT_PUBLIC_*` values, use Build + Runtime because Next.js embeds public env vars during build.

---

## 9. Set Namecheap DNS

Use the Namecheap account already open in the local browser.

Domain:

```text
plusim.xyz
```

Go to:

```text
Domain List -> Manage -> Advanced DNS -> Host Records
```

Add or update:

```text
Type: A Record
Host: @
Value: 178.104.184.3
TTL: Automatic

Type: A Record
Host: www
Value: 178.104.184.3
TTL: Automatic
```

Remove conflicting records for `@` or `www`, especially:

* URL Redirect Record
* Masked Redirect
* Old A Record
* Old CNAME Record

Save changes.

---

## 10. Deploy and verify production

Trigger deployment in Coolify after `main` is pushed.

Watch the Coolify deployment logs for:

* Install success
* Prisma generate success
* Prisma migrate deploy success
* Next.js build success
* Container starts on port `3000`
* HTTPS certificate issued for `plusim.xyz`

From DevAgents, verify DNS:

```bash
dig +short plusim.xyz
dig +short www.plusim.xyz
```

Expected:

```text
178.104.184.3
```

Verify HTTPS:

```bash
curl -I https://plusim.xyz
curl -sS https://plusim.xyz/api/health
```

Expected health response:

```json
{
  "ok": true,
  "app": "plusim"
}
```

Verify the app manually:

* Open `https://plusim.xyz`
* Sign in
* Send a chat message
* Confirm the reply comes from `onlyclaw`
* Refresh and confirm transcript persistence
* Confirm no browser console CORS errors
* Confirm Coolify logs show no repeated crashes
* Confirm database has Conversation and Message rows
* Confirm `/api/chat/agent-info` loads metadata
* Confirm `www.plusim.xyz` works or redirects cleanly

---

## 11. Update README after successful deployment

After production is live and verified, replace `README.md` with:

````md
# Plusim

Plusim is a financial guidance app powered by AgentGlob and the `onlyclaw` agent.

Live app: https://plusim.xyz

## What it does

Plusim gives signed-in users a focused chat interface for financial planning conversations, decision support, and structured guidance.

The app uses AgentGlob as the agent runtime, while Plusim owns the web UI, user authentication, session routing, and transcript persistence.

## Stack

Next.js 16 App Router · React 19 · TypeScript · Tailwind 4 · Clerk · Prisma · Postgres · Coolify · assistant-ui

## Agent

AgentGlob agent slug:

```text
onlyclaw
````

All browser chat requests are proxied through the app’s own `/api/chat` route. The browser must not call AgentGlob directly.

Session keys are namespaced as:

```text
app:plusim:<userId>:<conversationId>
```

## Source of truth

The canonical source repo is:

```text
cryptolir/Plusim
```

All development happens on the DevAgents server and is synced back to this repo.

Production deploys are made from GitHub `main` through Coolify.

## Development

SSH into DevAgents:

```bash
ssh DevAgents
```

Project path:

```bash
cd /root/projects/Plusim
```

Install and verify:

```bash
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm lint
pnpm typecheck
pnpm build
```

Run dev server:

```bash
pnpm dev --port 3001
```

Local preview tunnel:

```bash
ssh -i ~/.ssh/hetzner-openclaw -L 3001:localhost:3001 root@204.168.223.245 -N
```

Then open:

```text
http://localhost:3001
```

## Production

Production is hosted on Coolify.

```text
Domain: https://plusim.xyz
Repository: cryptolir/Plusim
Branch: main
Port: 3000
Database: Plusim_DB
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

Optional, if Drive/admin transcript features are enabled:

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
{
  "ok": true,
  "app": "plusim"
}
```

## Deployment rule

Do not edit production files directly.

Every production change must be:

```text
DevAgents -> git commit -> GitHub main -> Coolify deploy
```

````

Commit the README update:

```bash
git add README.md
git commit -m "docs: update Plusim README after deployment"
git push origin main
````

---

## 12. Definition of done

The deployment is done only when all of these are true:

* `cryptolir/Plusim` contains the full Plusim app code
* `main` is the source of truth
* Coolify deploys from `cryptolir/Plusim` `main`
* `https://plusim.xyz` loads successfully
* `https://plusim.xyz/api/health` returns `ok: true`
* Namecheap DNS points `@` and `www` to `178.104.184.3`
* The app uses `AGENTGLOB_AGENT_NAME=onlyclaw`
* Session keys use the `app:plusim` namespace
* Chat replies come from `onlyclaw`
* Clerk login works
* Postgres transcript persistence works
* No Havaya production domain or Havaya agent slug remains in runtime config
* README reflects the deployed Plusim app
* No secrets were committed to git
