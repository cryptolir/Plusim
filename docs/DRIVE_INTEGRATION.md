# Google Drive Integration — Setup & Runbook

The admin meeting-transcripts feature: browse a shared Drive folder, assign a subfolder per user, summarize transcripts with the `life` agent (saved back to Drive), and a home **"Past meeting"** prompt that resumes chat grounded in the latest summary.

Architecture overview lives in [ARCHITECTURE.md](../ARCHITECTURE.md#google-drive-integration-admin-meeting-transcripts). This doc is the operator setup + runbook.

## 1. Auth model & scope

- **OAuth 2.0 as the OWNER** — one admin connects their Google account once; the app reads/writes Drive as that account. No service account (avoids the service-account storage-quota problem when writing summaries).
- **Scope: `https://www.googleapis.com/auth/drive`** (full). Required because the app must browse a folder it did **not** create *and* write summary files into it. The narrower `drive.file` only sees app-created files, so it cannot list existing transcripts — disqualified.
- `auth/drive` is a Google **restricted** scope. To avoid restricted-scope verification (CASA security assessment) and the Testing-mode 7-day refresh-token expiry, set the **OAuth consent screen to Internal** under a Google Workspace. (Resolved: Workspace `liran@alty.com` → Internal.)

## 2. Google Cloud Console (one-time)

1. Pick/create a GCP project owned by the Workspace.
2. **APIs & Services → Library → enable "Google Drive API".**
3. **OAuth consent screen** → User type **Internal** → app name, support email. Add scope `https://www.googleapis.com/auth/drive` (plus `openid`, `.../auth/userinfo.email` to record which account connected).
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   - Authorized redirect URIs (add both):
     - `https://plusim.xyz/admin/api/drive/callback`
     - `http://localhost:3000/admin/api/drive/callback`
5. Copy the **Client ID** and **Client secret** into the env vars below.
6. Make sure the transcripts root folder (`PLUSIM_DRIVE_ROOT_FOLDER_ID`) is owned by — or shared into — the Workspace account that will connect.

## 3. Environment variables

All server-only (never `NEXT_PUBLIC_`). In `.env.local` for dev, **Coolify** service env for prod.

| Var | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | from the OAuth client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | from the OAuth client |
| `GOOGLE_OAUTH_REDIRECT_URI` | prod `https://plusim.xyz/admin/api/drive/callback` · dev `http://localhost:3000/admin/api/drive/callback` (must exactly match a console redirect URI) |
| `PLUSIM_DRIVE_ROOT_FOLDER_ID` | `<Plusim transcripts folder id>` (prod; set in Coolify — create a Plusim folder, share into the connecting Workspace account) — must be owned by / shared into the connecting account, else writes 403 |
| `DRIVE_TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` (32-byte base64) — AES-256-GCM for the refresh token at rest |
| `DRIVE_OAUTH_STATE_SECRET` | `openssl rand -base64 32` — HMAC secret for the OAuth `state` token |

Generate the two secrets fresh per environment; don't reuse the dev value in prod.

## 4. Connect / reconnect runbook

1. Sign in to `/admin` with an `ADMIN_EMAILS` account → open **Drive**.
2. Click **Connect Google Drive** → Google consent (the connecting account becomes the Drive owner the app acts as).
3. On success you land back on `/admin/drive?connected=1`; the refresh token is stored encrypted in `AppSetting["drive_oauth"]`.
4. **Reconnect** any time via the "reconnect" link (or the Connect button). The flow always uses `access_type=offline` + `prompt=consent`, so a fresh refresh token is returned every time.
5. If the token is revoked/expired, Drive calls fail with `invalid_grant`; the app clears the stored token and the page shows the connect state again. With an **Internal** consent screen the refresh token does **not** expire on a schedule (Testing mode would expire it after 7 days).

## 5. Contracts & internals

- **Summary marker** — created summaries carry Drive `appProperties`: `havayaSummary="true"`, `meetingDate`, `meetingTitle`, `sourceFileId`. Detection/idempotency query on these (survives file rename), not on filenames.
- **Root containment** — every caller-supplied `fileId`/`folderId` goes through `assertEntryUnderRoot()` (walks `parents` up to `PLUSIM_DRIVE_ROOT_FOLDER_ID`) before any read/write. The owner token can reach the whole Drive, so this guard is mandatory, not optional.
- **Summarize trigger** — `POST /admin/api/drive/summarize` reads the transcript (Google Doc → export `text/plain`; `text/*` → `alt=media`; other types rejected), truncates past ~24k chars (logged), and calls `callAgent()` with session `app:havaya:admin-summary:<uuid>`. A **fresh uuid every call** means a re-summarize never inherits the prior attempt's agent memory; `admin-summary` sits at sessionKey split-index-2 and **no `appUserId`** is sent, so no real user's per-user file is touched. The prompt embeds the **summary method** (see next bullet) as a `=== METHOD ===` block and **forbids the agent from using any tools or memory** (no graphiti `add_memory` — otherwise it exceeds the gateway timeout → `(no reply)`); it's asked to lead with `TITLE:` / `DATE:` lines (parsed for the filename, else the source filename + Drive `createdTime` are used).
- **Summary method (admin-editable)** — the method/structure applied to the transcript is stored in `AppSetting.summary_instructions` (plaintext) and editable from the admin UI in **two places, same setting**: `/admin/settings` and a "Summary method (skill)" field below the browser on `/admin/drive`. `getSummaryInstructions()` (`src/lib/summaryInstructions.ts`) returns the stored value, or the built-in **TAL method** (`DEFAULT_SUMMARY_INSTRUCTIONS`) when blank. It is an **embedded copy**, not read live from the agent's `skills/` — the per-user-workspace sandbox blocks app sessions from reading shared skills, so the method is inlined into the prompt.
- **"Past meeting"** — `buildPastMeetingHint(userId)` fetches the latest summary from the user's assigned folder and injects it as the invisible first-turn preamble in `/api/chat` (dynamic, unlike the static `SECTION_HINTS`). The transcript never appears in the chat UI or the stored `Message.content`.

## 6. Security notes

- Admin pages are Clerk-gated by the `(dash)` layout; admin API routes self-auth (a `drive`-scoped or per-user save token, with a live admin Clerk session as fallback). The OAuth callback is middleware-public and rests on the signed `state` token (the OAuth `code` is single-use at Google, defeating replay).
- The refresh token is encrypted at rest with a dedicated key (`DRIVE_TOKEN_ENCRYPTION_KEY`), separate from `CLERK_SECRET_KEY`.
- Full `drive` scope is broad but acceptable here: a single owner account, admin-only access, Internal consent screen.

Sibling admin feature: [ADMIN_SECTION_PLAN.md](./ADMIN_SECTION_PLAN.md).
