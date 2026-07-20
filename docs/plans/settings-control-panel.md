# Plusim — settings control panel + Havaya→Plusim migration cleanup

> **Status:** plan (under review). Feeds the `/admin/settings` rebuild and the
> finish of the Havaya→Plusim migration. Author changes on the designated branch,
> merge to `main`, Coolify auto-deploys.

## Context

The Plusim app was seeded from the **Havaya** codebase (a life-coaching chat app
running on the AgentGlob agent `life`, at `app.havaya.me`). The shell was
rebranded — app name, colors, agent slug `onlyclaw`, domain `plusim.xyz`, the
statement-categorization pipeline added — but three layers still carry Havaya
content:

1. **`/admin/settings`** contains exactly one control: the *"Summary
   instructions"* editor whose built-in default is the **TAL coaching method**
   (`מצוי/רצוי/דפוסים/זהות נבחרת`, `src/lib/summaryInstructions.ts`). The same
   editor is duplicated at the bottom of `/admin/drive`.
2. **`ROADMAP.md`** is titled *"Havaya — Roadmap"* and mostly describes
   `life`-agent features (`havayaRuntime`, `app.havaya.me` TLS, the
   `@talcrolltraining` YouTube section, a `/journey` page that does not exist in
   Plusim).
3. The **home hub** pulls its prompts panel + owner note from **AgentGlob
   per-user files** (`getUserSection(userId, "User_D_Prompt" | "app_note")`,
   `src/app/page.tsx:44`) — a `life`-era mechanism that returns empty in Plusim
   because onlyclaw does not run the `save_user_section` tool and the app key is
   unset. The panels render silently blank.

**Goal:** make `/admin/settings` a real Plusim control panel where prompts and
agent behavior are managed *from the app* (not the AgentGlob dashboard), and
finish the migration cleanup.

### Decisions confirmed with the user

- **(1a)** Keep the meeting-summary feature, but replace the TAL default with a
  **financial-meeting summary method**; the editor survives as one section of the
  rebuilt settings page.
- **(2 → Option 2)** Move the home-hub prompts + owner note into the app's own
  **`AppSetting`** store, admin-managed, replacing the AgentGlob per-user-file
  dependency. Single admin-set values apply to all users (no per-user prompts —
  that capability exists only on paper today).

## Hard boundary

Per `AGENTS.md` rule 0, this work touches **only** the Plusim repo. Onlyclaw's
workspace persona and its installed skill *files* live on AgentGlob and are **not
API-editable from Plusim** — so "manage skills from the app" means managing the
behavior levers the app already delivers on every request (chat preamble, job
manifest), **not** editing `SKILL.md`. That limit is stated plainly in the UI.

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| `AppSetting` key/value table + `summaryInstructions.ts` get/set/default pattern | The template for every new setting |
| `SummaryInstructionsEditor` client component + `/admin/api/settings/summary-instructions` PUT + `mintSaveToken`/`authorizeDriveRequest` | The template for save flows |
| `requireAdmin()` server gate on the settings page | Gate the rebuilt page unchanged |
| `REPORT_TAXONOMY` config; `MerchantMapping` model + `/admin/api/report-mappings/[id]` routes | The dictionary/taxonomy sections read these |
| `manifest/route.ts` assembling agent-facing config | Reads `report_rules` from settings |
| `chat/route.ts` first-message preamble slot (`src/app/api/chat/route.ts:80`) | Reads `chat_preamble` from settings |

## Plan

### Phase A — `/admin/settings` becomes the Plusim control panel

**A0. Generalize the settings accessor.** Add `src/lib/appSettings.ts` with
`getSetting(key): Promise<string | null>` and `setSetting(key, value)` over
`AppSetting`, plus a typed `SETTING_KEYS` allowlist. `summaryInstructions.ts`
keeps its public API but delegates to it (no behavior change). One generic PUT
`/admin/api/settings/[key]/route.ts` (key must be in the allowlist) replaces the
per-setting route; the existing `summary-instructions` route is removed once the
editor points at the generic one. Reuse `authorizeDriveRequest` for auth
verbatim (it is the app's admin-save gate, not Drive-specific).

**A1. Chat guidance** (`chat_preamble`). Admin textarea. Injected as the
first-message preamble for plain conversations, replacing the hardcoded
`SECTION_HINTS` (whose keys — pricing/features/onboarding — reference pages that
do not exist in Plusim). `chat/route.ts:86` reads the setting; blank → no
preamble (today's behavior for unknown contexts). The linked-folder meeting
context path (`buildLinkedFolderContext`) is unchanged.

**A2. Home prompts** (`home_prompts`, newline-separated) **+ owner note**
(`home_note`, markdown). `page.tsx` reads these two from the DB instead of the two
`getUserSection` calls. `parsePrompts` already turns text into the prompt array;
point it at the setting. Blank → the panels render empty exactly as today (no
regression). The `app_profile` name seed path is **kept** (it is the greeting
name, unrelated to prompts).

**A3. Meeting summary method** (`summary_instructions`). The existing editor, one
section of the page. Its default becomes the financial method (Phase B). Remove
the **duplicate** editor block from `/admin/drive` and link to `/admin/settings`
instead (single source of truth; same setting key).

**A4. Report categorization rules** (`report_rules`). Admin textarea whose text
is served in the job manifest `constraints` block (`manifest/route.ts:47`), so
categorization tuning happens in-app and takes effect on the next job. **Blank →
the current hardcoded constraints object is used as the fallback** (no regression,
never ship an empty rules block to the agent).

**A5. Merchant dictionary + taxonomy (read/light-write).** A section listing
`MerchantMapping` rows (pattern → category, approved flag) with add/approve/delete
via the **existing** `/admin/api/report-mappings` routes, plus a **read-only**
render of `REPORT_TAXONOMY`. This surfaces at settings level what today is only
reachable inside a single job's detail page.

**A6. Agent/skill status (read-only).** A panel stating the repo skill version
(`agent/skills/plusim-reports/`), the required env prerequisites, and a **"smoke
test"** button that POSTs a trivial message to the agent and shows the reply — the
honest substitute for "manage skills," with a one-line note that skill *files*
are edited on AgentGlob, not here.

### Phase B — financial summary default (decision 1a)

Replace the `DEFAULT_SUMMARY_INSTRUCTIONS` body in `summaryInstructions.ts` with
a **financial-meeting** summary method (proposed structure: current financial
picture → goals/constraints raised → decisions & action items with owners →
risks/open questions → one concrete next step; Hebrew output, facts vs.
interpretation separated). Review whether the invisible past-meeting context
injection (`pastMeeting.ts` — "weave the understanding in naturally, reply in
Hebrew") should be reworded away from its coaching phrasing; propose a neutral
rewrite, keep the mechanism.

### Phase C — migration cleanup

- **`deploy.sh`** — fix the post-push success line (`app.havaya.me` →
  `plusim.xyz`). (One line; real user-visible bug.)
- **`ROADMAP.md`** — rewrite for Plusim: retitle, drop Havaya-only entries
  (`havayaRuntime`, `app.havaya.me` TLS, YouTube/`@talcrolltraining`, `/journey`),
  re-describe the genuinely-inherited features in Plusim terms, re-scope the
  backlog.
- **Docs** — `HANDOVER_HAVAYA_SESSION.md` documents the *other* repo's servers and
  paths (`/root/projects/Havaya_App`, the `life` agent host); it invites a
  cross-project-boundary mistake and is **deleted**. Havaya working docs
  (`IMPLEMENTATION_PLAN.md`, `docs/ADMIN_SECTION_PLAN.md`, `docs/QA_GUIDE.md`,
  `docs/RECENT_CHATS_PANEL_PLAN.md`, `AGENTGLOB_*.md`) move to `docs/archive/`
  with a one-line "historical — Havaya era" header. `PLAN.md` / `ARCHITECTURE.md`
  rewritten for Plusim (ARCHITECTURE's mechanics are still accurate — mostly
  find/replace + a reports section). `docs/DRIVE_INTEGRATION.md` "life" → onlyclaw.
- **Code cosmetics** — rename the `havaya_` multipart boundary
  (`googleDrive.ts:259`) and the "same routine as Havaya summaries" comments.
  The **`appProperties.havayaSummary` Drive tag** (`googleDrive.ts:400`,
  `DriveBrowser.tsx:16`) is **only** renamed after confirming no summary files in
  the live Drive carry the old tag — otherwise `listSummaries` stops finding them.
  Safer default: leave the tag string, rename only comments/vars. Decide in review.

## Non-goals

- Editing onlyclaw's workspace skill files from the app (no AgentGlob API for it).
- Per-user prompt/note differences (the Option 1 path) — a single admin default only.
- Changing the agent-facing auth, the reports pipeline, or the taxonomy contents.

## Risks / contingencies

- **Renaming the `havayaSummary` tag breaks `listSummaries`** for existing Drive
  files → the past-meeting feature silently loses its history. Mitigation: don't
  rename the tag string, or query both old+new. (Cosmetic vs. correctness — the
  string is invisible to users.)
- **Dropping `SECTION_HINTS`/`getUserSection`** — grep for every reference first;
  keep `getUserSection` for `app_profile` (the greeting name still uses it).
- **`report_rules` in the manifest** — always fall back to the hardcoded
  constraints when the setting is blank; never send the agent an empty rules block.
- **Generic settings route** — the key allowlist is the security boundary; a PUT
  to an unlisted key must 400, not write arbitrary `AppSetting` rows.

## Verification

- Unit: `appSettings` get/set + fallback; `summaryInstructions` still returns the
  new default when unset.
- Route: settings PUT admin gate (401/403) + key-allowlist rejection (400).
- Manual E2E: set each field in `/admin/settings` → observe it surface — chat
  preamble in an outbound message, prompts/note on the home hub, `report_rules`
  in the manifest JSON, summary default in the editor's "using default" state.
- Regression: blank settings reproduce today's behavior on every surface.
