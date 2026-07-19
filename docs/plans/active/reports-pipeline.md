# Plan: statement-categorization pipeline (admin upload → onlyclaw → client report)

**Rev 1** · author: Claude · status: awaiting Codex review
Ponytail pass: run manually (ponytail-review skill not available in this session) —
cut a speculative batch-manifest endpoint, a separate cron sweeper, and a
per-transaction audit-log table; none has a caller in Phase 1.

## Context

Productizes the manual workflow proven this session (5 real statements → 109
categorized transactions, reconciled to the agora). Admin uploads card
statements, the `onlyclaw` AgentGlob agent categorizes them, the target user
sees the report in `/report`.

Trust boundaries touched (⇒ this plan is required per PLAN_REVIEW_PROTOCOL §1):
a **public unauthenticated surface** `/api/agent/**`, a **schema migration**,
and **Drive containment** (owner token can reach the owner's whole Drive).

**Note for the reviewer:** a pre-protocol implementation already exists on
`claude/transaction-categorization-1hxbts` (PR #4). It stored raw statements as
Postgres `bytea`. This plan supersedes that with the owner's directive below;
the implementation PR will be reconciled to this plan after approval. Review
the plan, not PR #4.

## Owner directive folded into this rev

Raw statement files must live in the **client's Google Drive folder**, reusing
the exact Havaya meeting-summary routine — not Postgres `bytea`. Each client is
already assignable a folder; the report Sheet already lands there on publish, so
the client's folder holds both the raw inputs and the output.

## Current code (file-anchored — read before changing)

- `src/lib/googleDrive.ts` — owner-OAuth Drive client. `assertEntryUnderRoot(id)`
  (walks `parents` to `DRIVE_ROOT_FOLDER_ID`, throws `DriveOutsideRootError`)
  gates every read/write; `createTextFile()` / `uploadXlsxAsSpreadsheet()` write
  via multipart with `appProperties`; `getFileText()` reads. There is **no
  binary read/download or raw binary upload helper yet** — added here.
- `prisma/schema.prisma` — `UserDriveFolder { userId @unique, folderId }` maps a
  Clerk user to a subfolder of the root.
- `src/app/admin/api/users/[userId]/drive/route.ts` — assigns that folder;
  containment-checks `folderId` with `assertEntryUnderRoot` before upsert.
- `src/app/admin/api/drive/save-summary/route.ts` — the pattern to copy: the
  write's **parent folder is re-derived server-side** (`entry.parents[0]`), so
  the client cannot redirect the write; tagged with `appProperties`.
- `src/proxy.ts` — Clerk middleware; `/admin/api(**)` is middleware-public and
  self-authorizes. `/api/agent/**` will join it (server-to-server).

## Design

### Storage (the change): raw statements in the client's Drive folder

- On upload, the app writes each statement into the user's assigned
  `UserDriveFolder.folderId` via a new `uploadBinaryFile()` helper (raw media
  upload, original mime preserved — no Google-Docs conversion), tagged
  `appProperties { plusimStatement:"true", plusimJobId }`. Parent folder comes
  from the **DB row, not the request**.
- Precondition: the target user **must already have an assigned folder**. No
  folder ⇒ upload refused with an actionable error (assign one first, exactly
  like Havaya). Drive not connected ⇒ same 409 as save-summary.
- `StatementFile` stores `driveFileId` (+ filename, mime, size, sha256,
  sourceLabel) — **no `bytes` column**. Derived data (`ReportTransaction`, the
  generated xlsx `ReportArtifact`, `MerchantMapping`) stays in Postgres; only
  the **raw inputs** move to Drive, matching the directive.

### Data model (Prisma migration)

`ReportJob`, `StatementFile` (with `driveFileId`, no bytes), `ReportArtifact`
(xlsx, app-generated), `ReportTransaction` (amounts as **agorot Int**),
`MerchantMapping`. Additive; no backfill (no prod rows).

### Flow

```
/admin/reports: pick user (must have a Drive folder) → upload statements
  → write each to the user's Drive folder (containment-checked) → StatementFile{driveFileId}
  → POST /admin/api/reports/:id/run → mint per-job token → callAgent()
       session app:plusim:report-job:<id>, NO appUserId, ≤3000-char manifest msg
  → onlyclaw (plusim-reports skill): GET manifest + GET each file (streamed from Drive)
       → python parse/dedup/categorize → model judges only the unknown-merchant tail
       → build xlsx → verify to the agora → POST result
  → app re-verifies INDEPENDENTLY → completed | needs_review
  → admin reviews uncategorized + approves mappings → Publish
       → export xlsx as a Google Sheet into the SAME user folder (appProperties)
  → /report: published reports as RTL month tables + xlsx download + Sheet link
```

### Agent-facing routes (`/api/agent/jobs/[jobId]/…`, middleware-public)

- `manifest` — files (with per-file fetch URLs), taxonomy, approved merchant
  dictionary, callback URL, constraints.
- `files/[fileId]` — **streams bytes from Drive**. Resolves the `StatementFile`
  by `(id, jobId)` from the DB, then `assertEntryUnderRoot(driveFileId)` before
  streaming. The agent never supplies a Drive id.
- `result` — parse + **independent re-verification** (`src/lib/reportResult.ts`),
  then `completed` | `needs_review`.

Auth (`src/lib/agentRuntimeAuth.ts`): static bearer `PLUSIM_AGENT_RUNTIME_TOKEN`
(≡ agent-side `PLUSIM_RUNTIME_TOKEN`) **and** a random 32-byte per-job token,
sha256-stored on `ReportJob` with a 24h TTL, minted at dispatch. Publish clears
the token so late callbacks can't mutate a published report.

### Dispatch, verification, client surface

- Dispatch tolerates chat timeouts (the AgentGlob run continues after a client
  abort; the callback completes the job). Isolated session, no `appUserId` (no
  per-user memory writes — the Drive-summarize lesson).
- Re-verification recomputes per-source sums to the agora, validates category
  names against the taxonomy, month-vs-date, and dedup identity; any failure ⇒
  `needs_review` with diagnostics. Agent math is never trusted.
- `/report` (Clerk) shows **published** reports only; xlsx download is
  ownership-checked (only the job's target user).

## Trust-boundary review asks — attack these (PLAN_REVIEW_PROTOCOL §4)

1. **Drive read confinement (new).** In `files/[fileId]`, can a valid runtime
   token + per-job token be steered to read a Drive file outside the user's
   folder — e.g. a `driveFileId` written by a compromised prior callback, or a
   `StatementFile` row cross-linked to another job? Confirm the fileId is
   DB-bound to the job **and** `assertEntryUnderRoot` re-runs at read time.
2. **Drive write confinement.** On upload, is the parent folder ever taken from
   the request rather than `UserDriveFolder` (redirect to an arbitrary folder)?
   What happens when the user has no folder, or the folderId is stale/deleted?
3. **Authorization key, not a proxy.** The per-job token gates one job — verify
   it can't be replayed across jobs, survive publish, or pass after TTL; and
   that `jobId` in the path is the identity, not merely "a valid token exists".
4. **Fail closed on ingestion.** A result with a per-source total mismatch, an
   unknown category, a duplicate dedupKey, or a non-xlsx payload must land
   `needs_review` and never publish silently. Confirm no path treats an
   agent-declared `status:"ok"` as authority over the app's own recompute.
5. **Guard composition.** Does the new `/api/agent(**)` public matcher widen
   anything beyond these token-gated routes? Does publish's token-clear race a
   late in-flight callback?
6. **PII.** Raw statements are personal financial data. Confirm: no `bytes` at
   rest in Postgres; the skill deletes downloaded files post-job; job sessions
   write no memory; real statements never enter git.

## Test list (every ask → a test; the implementation PR must carry these)

- `files/[fileId]`: fileId not belonging to jobId → 404; `driveFileId` failing
  `assertEntryUnderRoot` → 403; happy path streams the bytes. (ask 1)
- upload: user with no `UserDriveFolder` → refused; parent folder always the DB
  folderId (request-supplied folder ignored); Drive not connected → 409. (ask 2)
- `authorizeAgentJobRequest`: wrong token → 401; wrong/expired per-job token →
  404; token from job A used on job B → 404; published job (token cleared) →
  404. (asks 3, 5)
- `verifyAgentResult`: total mismatch, unknown category, duplicate dedupKey,
  date-outside-month each → `needs_review`; `status:"ok"` with a mismatch still
  → `needs_review`. (ask 4)
- client `download`: non-owner → 404; non-published job → 404. (ask 3)
- pipeline regression: the 5-statement baseline reproduces 109 txns / month
  totals ₪918.26 · ₪2,422.50 · ₪8,914.48 · ₪2,446.85 / 11 uncategorized, every
  per-source sum agora-exact (fixtures sanitized; real files out of git). (ask 6)

## Plan → code notes (re-verify against live shapes, not this doc)

- Drive media upload: confirm the multipart `uploadType=multipart` with the raw
  original mime returns the file id and that `parents:[folderId]` places it (not
  in the owner root). Re-read `createTextFile` for the exact boundary format.
- Streaming from Drive: use `alt=media` on `files/get`; verify Google Docs mimes
  are rejected (statements are xlsx/pdf only).
- Migration: `prisma migrate diff` from main's schema; applied via the existing
  `prisma migrate deploy` start step — no manual prod migration (§3 stop-and-ask
  if that changes).
