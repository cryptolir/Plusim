# Plusim — settings control panel + Havaya→Plusim migration cleanup

> **Status:** plan — Rev 3 (Codex round 1 folded in). Feeds the `/admin/settings`
> rebuild and the finish of the Havaya→Plusim migration. Author changes on the
> designated branch, merge to `main`, Coolify auto-deploys.
>
> **Review log:** Rev 1 — initial plan. Rev 2 — ponytail minimalism pass folded
> in (§ *Ponytail cuts* below): cut the standalone merchant-dictionary CRUD UI,
> the read-only taxonomy render, the skill-status panel + smoke-test button;
> `delete` `SECTION_HINTS`; left the `havayaSummary` Drive tag string untouched
> (correctness). `net: -~300 lines` vs. Rev 1. Rev 3 — Codex round 1: **P1** —
> `report_rules` needs an agent-side consumer (`run_job.py`/SKILL.md), a manifest
> field alone is a no-op (A4 now three-part); **P2** — blank `chat_preamble` must
> preserve the `buildLinkedFolderContext` Drive-summary injection, not suppress it
> (A1 precedence made explicit).

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

**A1. Chat guidance** (`chat_preamble`). Admin textarea, injected on the first
message. **Precedence must preserve today's behavior (Codex P2)** — today
`chat/route.ts:83` sends `buildLinkedFolderContext(userId)` (the hidden
meeting-summary context) for *every* plain chat and the `past_meeting` pin,
because `SECTION_HINTS` is always empty in Plusim. So the rewrite is:
- `past_meeting` pin → `buildLinkedFolderContext` (unchanged).
- otherwise → `chat_preamble` (if set) **prepended to** `buildLinkedFolderContext`
  (if any). `chat_preamble` **augments**, never replaces, the per-user Drive
  context.
- **blank `chat_preamble` ⇒ exactly today's output** (`buildLinkedFolderContext`
  or nothing) — it must NOT suppress the Drive-summary injection.

`chat_preamble` replaces only the dead `SECTION_HINTS` branch.
**`delete:` the `SECTION_HINTS` map** (`src/lib/sectionHints.ts`) — dead config
whose keys (pricing/features/onboarding) reference pages that do not exist in
Plusim.

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

**A4. Report categorization rules** (`report_rules`). Admin textarea. **A manifest
field alone is a no-op — it needs an agent-side consumer (Codex P1).** Verified:
`run_job.py prepare` reads the manifest's `files`/`taxonomy`/`merchantDictionary`
but **never `constraints`**, and SKILL.md step 2 applies only the bundled
`reference/categorization-rules.md`. So this item is **three parts**:
1. **App** — serve `report_rules` as a manifest field (`manifest/route.ts`).
   Blank ⇒ omit it and keep the current hardcoded `constraints` block (never ship
   an empty rules block).
2. **Skill** — `run_job.py prepare` writes any manifest `report_rules` into
   `$WD/needs_judgment.json`; SKILL.md step 2 tells the model to apply the bundled
   `reference/categorization-rules.md` **plus** these admin rules (admin rules win
   on conflict). The proven static playbook is never discarded — `report_rules`
   **augments** it, so blank ⇒ today's categorization exactly.
3. **Ops (one-time)** — re-install the updated skill into onlyclaw's workspace
   (skills are not auto-synced from the repo). After that single install, future
   `report_rules` edits take effect per-job through the manifest, no re-install.

Without part 2 the setting would silently do nothing — the point of the lever is
that it actually reaches the model's judgment step.

**A5. Merchant dictionary (read-only list).** A section listing the approved
`MerchantMapping` rows (pattern → category) so the admin can *see* what the
deterministic categorizer covers, with a link to a job's detail page where they
are already editable. **No new write surface** — the `/admin/api/report-mappings`
routes + the `ReportJobDetail` editor already do add/approve/delete
(*ponytail `yagni:` — don't build a second management UI*). No taxonomy render
(*ponytail `yagni:` — `REPORT_TAXONOMY` is static config, nothing to manage*).

**A6. Agent/skill note (static).** A one-paragraph note stating that onlyclaw's
skill *files* are managed on AgentGlob (not API-editable from here), and that
this page controls the behavior levers the app delivers — chat preamble, home
content, report rules. No live status panel, no smoke-test button
(*ponytail `yagni:`/`shrink:` — real report jobs already exercise the agent*).

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
  (`googleDrive.ts:259`, a throwaway local) and the "same routine as Havaya
  summaries" comments. The **`appProperties.havayaSummary` Drive tag**
  (`googleDrive.ts:400`, `DriveBrowser.tsx:16`) is **left as-is** — live Drive
  files already carry it, and renaming the query string would make `listSummaries`
  stop finding them (correctness > cosmetics). The tag is invisible to users.

## Non-goals

- Editing onlyclaw's workspace skill files from the app (no AgentGlob API for it).
- Per-user prompt/note differences (the Option 1 path) — a single admin default only.
- Changing the agent-facing auth, the reports pipeline, or the taxonomy contents.

## Ponytail cuts (Rev 2)

Over-engineering pass (7-rung ladder; guardrails — trust boundary, data-loss,
security — never cut):

- `yagni:` standalone merchant-dictionary CRUD manager → read-only list + link
  (the `report-mappings` routes + `ReportJobDetail` editor already manage them).
- `yagni:` read-only taxonomy render (`REPORT_TAXONOMY` is static config).
- `yagni:`/`shrink:` skill-status panel + smoke-test button → a static note.
- `delete:` `SECTION_HINTS` (dead — keys reference nonexistent Plusim pages).
- **Kept:** `SETTING_KEYS` allowlist (trust boundary on the generic route),
  `report_rules`→hardcoded fallback (data integrity), the generic `appSettings`
  accessor (rung 2 reuse — fewer lines than N per-key modules).

`net: -~300 lines` vs. Rev 1.

## Risks / contingencies

- **Renaming the `havayaSummary` tag breaks `listSummaries`** for existing Drive
  files → the past-meeting feature silently loses its history. Mitigation: don't
  rename the tag string, or query both old+new. (Cosmetic vs. correctness — the
  string is invisible to users.)
- **Dropping `SECTION_HINTS`/`getUserSection`** — grep for every reference first;
  keep `getUserSection` for `app_profile` (the greeting name still uses it).
- **`report_rules` must reach the model, not just the manifest (Codex P1)** —
  the skill (`run_job.py` + SKILL.md) must consume the field or the setting is a
  no-op; the updated skill needs a one-time workspace re-install. Blank ⇒ omit
  the field and keep the hardcoded constraints (never an empty rules block).
- **Blank `chat_preamble` must not drop the Drive-summary context (Codex P2)** —
  the linked-folder injection is today's behavior for plain chats; the precedence
  augments it, never replaces it.
- **Generic settings route** — the key allowlist is the security boundary; a PUT
  to an unlisted key must 400, not write arbitrary `AppSetting` rows.

## Verification

- Unit: `appSettings` get/set + fallback; `summaryInstructions` still returns the
  new default when unset.
- Route: settings PUT admin gate (401/403) + key-allowlist rejection (400).
- Manual E2E: set each field in `/admin/settings` → observe it surface — chat
  preamble in an outbound message, prompts/note on the home hub, `report_rules`
  in the manifest JSON, summary default in the editor's "using default" state.
- **`report_rules` reaches the model (Codex P1):** `run_job.py --selftest` /
  a fixture manifest carrying `report_rules` → the value lands in
  `needs_judgment.json` and the SKILL.md judgment step references it (not just the
  manifest round-trips).
- **Chat preamble precedence (Codex P2):** a user with a linked Drive folder +
  blank `chat_preamble` still gets `buildLinkedFolderContext` on the first message;
  a set `chat_preamble` is prepended, not substituted.
- Regression: blank settings reproduce today's behavior on every surface.
