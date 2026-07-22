# Plusim — Admin-defined report categories (DB-backed, global taxonomy extension)

> **Status:** Draft — **Rev 3** (Codex round-2 folded). Nothing implemented yet.
>
> **Process** (self-contained — the canonical plan-review protocol lives in
> `docs/PLAN_REVIEW_PROTOCOL.md`; AGENTS.md rule 0 forbids following cross-repo pointers, so the
> rules are summarized here): plan PR → adversarial Codex review → each review round becomes a new
> Rev on this branch with resolution notes (never silently rewrite reviewed text) → every caught
> hole becomes a named test the implementation PR must carry → once approved, implement exactly the
> plan; deviations go back to the owner.
>
> **Why a plan is required (PLAN_REVIEW_PROTOCOL §1):** this change touches two trust boundaries —
> the `/api/agent/**` manifest surface (the taxonomy the agent is handed) and a **Prisma schema
> migration** (a new table). The category taxonomy is also the shared contract that lets "app and
> agent never disagree on category names" (`src/config/reportTaxonomy.ts:6-9`); widening it is
> exactly the kind of invariant a reviewer should attack before code.
>
> **Review asks (attack these):**
> 1. **Agent↔app agreement.** Is there ANY interleaving where the agent is handed a leaf in its
>    manifest that the app later rejects at result-verification (→ false FATAL, unpublishable job)?
>    The whole design hinges on the merged valid-leaf set being identical on both sides.
> 2. **Guard composition.** Seven sites validate a category today (enumerated in Context 2). Does the
>    plan convert *every* one to the merged set, with none left on the base-only `isTaxonomyLeaf`?
> 3. **Fail closed.** An unknown category (in neither base nor DB) must still be FATAL / rejected,
>    and the pure verifier's default valid set must stay base-only (strict) so a route that forgets
>    to pass the merged set errs toward rejection, never acceptance.
>
> **Review log:**
> - Rev 1 — authored from a file-anchored read of every taxonomy consumer (Context 2). Manual
>   ponytail pass ran before handoff (see "Ponytail cuts"); I don't have the `/ponytail` skill in
>   this environment, so the minimalism pass was done by hand and its cuts are listed explicitly.
> - Rev 2 — Codex review round 1 (PR #20), two **P2**s folded:
>   - **line 161 — merged-set derivation.** `mergedLeafSet` computed `base ∪ raw extra names` while the
>     manifest used the section-*filtered* `mergeTaxonomy`; a `ReportCategory` row with an invalid
>     `section` (bad seed/migration, or a create-route bug before a DB CHECK constraint exists) would be
>     dropped from the manifest but kept in the verifier/admin valid set — breaking manifest↔verify
>     equality and failing open for admin assignment on a leaf the agent was never shown. Resolved: A2
>     now derives `mergedLeafSet` from the leaves of the **same** `mergeTaxonomy`, so both sides filter
>     identically; banked as `test_mergedLeafSet_derives_from_merged_taxonomy` + an invalid-section case
>     added to `test_manifest_and_verification_share_valid_set`.
>   - **line 296 — invariant test too narrow.** `test_no_consumer_left_on_base_only_check` only banned
>     bare `isTaxonomyLeaf`, so the UI/report consumers (sites 6–7) could silently stay base-only
>     (`TAXONOMY_LEAVES` / `REPORT_TAXONOMY`) — a DB category assignable + verified yet missing from the
>     picker/report, with the test still green. Resolved: the invariant now also asserts sites 6–7 by
>     behavior — `test_assign_picker_includes_db_category` + `test_report_page_renders_db_category`.
> - Rev 3 — Codex review round 2 (PR #20), one **P2** folded:
>   - **line 315 — result-callback route glue untested.** The invariants pinned the manifest route and
>     the pure verifier, but nothing pinned the one piece of glue that matters: the result callback
>     actually passing the merged set. With `validLeaves` *defaulting* to base, an implementer writing
>     `verifyAgentResult(result)` / `parseAgentResult(body)` would silently fall back to base-only — a
>     DB leaf the agent legitimately used (from the manifest) becomes a **false FATAL** and DB-leaf
>     proposed mappings are dropped — while every listed test stays green. Resolved two ways: (a) the
>     `validLeaves` param is now **required** (no default), so a forgotten pass is a `pnpm typecheck`
>     build error rather than a silent false-FATAL (Decision 4, B1); (b) a mocked route test —
>     `test_result_callback_verifies_against_merged_set` — seeds a `ReportCategory`, POSTs a DB-leaf
>     transaction + DB-leaf proposed mapping, and asserts the stored `verification.fatal === false` and
>     the mapping survived.

## Context

What exists today, read from the code (not memory):

1. **The taxonomy is one hard-coded constant.** `src/config/reportTaxonomy.ts` exports
   `REPORT_TAXONOMY` (10 sections, each with Hebrew leaf names, :16-85), the flattened
   `TAXONOMY_LEAVES` (:88), a private `LEAF_SET` (:90), and `isTaxonomyLeaf(name)` (:93-95). Its
   header comment is the design contract: the constant "is serialized into every agent job
   manifest — the manifest copy is what the agent actually uses, so app and agent can never disagree
   on category names" (:6-9). **That invariant is the thing this plan must preserve while widening
   the set.**
2. **Seven sites consume the taxonomy** (grep `isTaxonomyLeaf|TAXONOMY_LEAVES|REPORT_TAXONOMY` over
   `src/`). Any category an admin adds must be honored at every one, or the gates disagree:

   | # | Site | Use today | Kind |
   |---|---|---|---|
   | 1 | `src/lib/reportResult.ts:116` | `parseAgentResult` drops a proposed merchant→category mapping whose category isn't a leaf | pure fn |
   | 2 | `src/lib/reportResult.ts:159` | `verifyAgentResult` flags a categorized txn with an unknown leaf → pushes a problem → **FATAL** | pure fn |
   | 3 | `src/app/admin/api/reports/[jobId]/transactions/[txId]/route.ts:28` | admin assigns a category to an uncategorized row; non-leaf → `400 "unknown category"` | route |
   | 4 | `src/app/admin/api/report-mappings/[id]/route.ts:26` | admin approves/edits a merchant→category mapping; non-leaf → `400` | route |
   | 5 | `src/app/api/agent/jobs/[jobId]/manifest/route.ts:49` | serializes `REPORT_TAXONOMY` into the agent manifest | `/api/agent/**` |
   | 6 | `src/components/admin/ReportJobDetail.tsx:333` | the `<select>` in the "הקצאת קטגוריות" review UI lists `TAXONOMY_LEAVES` | client UI |
   | 7 | `src/app/report/page.tsx:132` (+ bucketing at :84) | the client report page renders section→leaf rows and buckets published spend by leaf | server comp |

3. **Categories flow to the agent only through the manifest.** The `onlyclaw` skill reads
   `manifest["taxonomy"]` generically — `leaves = {leaf for sec in manifest["taxonomy"] for leaf in
   sec["leaves"]}` (`agent/skills/plusim-reports/scripts/run_job.py:251,299`) and
   `build_workbook(manifest["taxonomy"], …)` (:321). It never hard-codes leaf names. **So a category
   added to the manifest taxonomy flows through the deterministic categorizer, the workbook Main /
   analysis / distribution sheets, and the agent-side verifier with ZERO agent-file change and NO
   workspace re-install.** (`AGENT_SETUP.md §7` re-install is not triggered by this plan.)
4. **The two verifiers are twins.** App-side `verifyAgentResult` (`reportResult.ts:154-218`) and
   agent-side `verify` (`scripts/verify_report.py:16-60`) run the same four checks; the app one is a
   **pure, synchronous, unit-tested** function (`src/lib/reportResult.test.ts`). Agent-side validates
   against the manifest leaves; app-side validates against `LEAF_SET` (the base constant). Today they
   agree because both ultimately derive from the same constant. **Widen one without the other and a
   DB-only leaf becomes an "unknown category" FATAL — the exact bug we must not ship.**
5. **Admin category edits do NOT re-run verification.** The assign route (site 3) updates the
   `ReportTransaction` row only; `job.verification.fatal` is frozen from the agent callback. So an
   admin assigning a (DB) category to an uncategorized row can never *create* a FATAL — it only
   resolves reviewable rows. (This also means this feature does **not** unblock a job that is already
   FATAL for another reason — see Non-goals.)
6. **The publish guard reads only the stored `fatal` flag.**
   `src/app/admin/api/reports/[jobId]/publish/route.ts:34-44` — unaffected by category edits.
7. **Admin reports routes share one auth helper.** `authorizeReportsRequest`
   (`src/lib/reportsAdminAuth.ts:13-23`) — save-token-or-Clerk-admin; the new endpoint reuses it
   verbatim, like every sibling under `src/app/admin/api/reports/**`.
8. **Existing DB style to mirror.** `MerchantMapping` (`prisma/schema.prisma:142-152`) is the closest
   precedent: `@unique` natural key, `source`/`createdAt`/`updatedAt`, `@@index`. The new table
   mirrors it.

**Goal:** let an admin add a new **Hebrew** category from the "הקצאת קטגוריות" review UI, and have
that category be a first-class taxonomy leaf **everywhere** — the assign picker, the agent manifest,
result verification, the merchant-mapping approval, and the client report page — persisted globally
so it applies to this job and every future one, **without breaking the app↔agent agreement invariant
or the fail-closed verifier.**

### Decisions (proposed defaults — reviewers, attack these)

1. **One merged set, computed from base ∪ DB, used at every consumer.** The base constant stays; a
   new `ReportCategory` table holds admin additions. A thin server helper merges them. **No consumer
   is left on the base-only check** (Context 2 table → all seven move).
2. **Add-only in v1 (no edit / delete / deactivate).** This is the key simplifier: because rows are
   only ever *added*, the DB set the manifest sees (at manifest-fetch) is always a **subset** of the
   set verification sees (at the later callback) — the agent can never hold a leaf the app lacks, so
   **Review-ask 1 is closed by construction, with no per-job taxonomy snapshot needed.** Renaming or
   retiring a category is a separate plan (it reintroduces the skew question). A typo category is
   therefore permanent in v1 — accepted trade-off for a tiny admin surface (see Risks).
3. **A new category attaches to an existing base section.** `section` is required and must be one of
   `REPORT_TAXONOMY`'s section names (a Hebrew `<select>` in the UI). This keeps the manifest taxonomy
   well-formed (no invented sections) so the workbook's `Main` / `ניתוח תוצאות` / `התפלגות ההוצאות`
   sheets and `/report`'s section rows place it correctly. No custom sections in v1.
4. **The verifier stays pure; the route is thin glue — and the wiring is compiler-enforced.**
   `verifyAgentResult` and the proposed-mapping filter in `parseAgentResult` take a **required**
   `validLeaves: Set<string>` parameter (no default). The result callback route computes the merged set
   (one `await getValidLeafSet()`) and passes it to both. Requiring the param rather than defaulting to
   base is deliberate: a route that forgets to pass it is a **`pnpm typecheck` build error**, not a
   silent base-only fallback that turns a legit DB leaf into a false FATAL (Codex round-2, line 315).
   The pure fns never touch the DB; the route is the only glue that reads it. (PLAN_REVIEW_PROTOCOL §4
   "pure + tested".)
5. **The "add category" control lives once in the section header**, not per-row: an
   `➕ הוספת קטגוריה` button in the "ללא סיווג — הקצאת קטגוריות" section opens an inline Hebrew form
   (name input + section `<select>` + `הוספה`); on success the new leaf appears in every row's
   dropdown. Global action → single control (avoids N duplicated per-row forms).
6. **All new UI copy is Hebrew** (per the owner's message): `הוספת קטגוריה`, `שם קטגוריה חדשה`,
   `שיוך למדור`, `הוספה`, `ביטול`, and error text `קטגוריה כבר קיימת` / `שם קטגוריה לא תקין`.

## Hard boundary

Per `AGENTS.md` rule 0: only files inside the Plusim repo change. No agent-workspace edits — and none
are needed (Context 3): the skill consumes the manifest taxonomy generically, so no `agent/skills/**`
change and no `AGENT_SETUP.md §7` re-install is part of this plan.

## What already exists — reuse, do not rebuild

| Existing | Reuse for |
|---|---|
| `REPORT_TAXONOMY`, `TAXONOMY_LEAVES`, `LEAF_SET`, `isTaxonomyLeaf` (`reportTaxonomy.ts`) | stay as the **base**; the merge layer wraps them — the constant is not deleted |
| `MerchantMapping` model shape (`schema.prisma:142-152`) | the `ReportCategory` model mirrors it (unique key, timestamps, index) |
| `authorizeReportsRequest` (`reportsAdminAuth.ts`) | admin auth for the new `POST /admin/api/report-categories`, unchanged |
| `ReportJobDetail` poll + `action()` + `load()` (`ReportJobDetail.tsx:76-116`) | the add-category POST reuses `action()`, then `load()` refetches the merged leaf list |
| the agent skill's generic `manifest["taxonomy"]` consumption (`run_job.py`) | new categories reach the categorizer + workbook with no skill change |
| `src/lib/reportResult.test.ts` harness (`tx()`/`result()` builders) | new verifier tests extend it |

## Plan

### Phase A — data + taxonomy merge layer

- **A1. Prisma model + migration** (`prisma/schema.prisma`, new
  `prisma/migrations/<ts>_report_category/migration.sql`). Additive table only:

  ```prisma
  // Admin-defined category leaves that EXTEND the base REPORT_TAXONOMY constant.
  // Merged into the taxonomy at every consumer (agent manifest, result
  // verification, admin category validation, the assign picker, the client
  // report page) so app and agent still agree on the full leaf set. Add-only in
  // v1 — see docs/plans/report-custom-categories.md.
  model ReportCategory {
    id        String   @id @default(cuid())
    name      String   @unique // Hebrew leaf name; must not collide with a base leaf
    section   String            // one of REPORT_TAXONOMY's section names
    createdBy String            // admin email
    createdAt DateTime @default(now())
  }
  ```
  (Schema migration = owner sign-off before the implementation PR ships — PLAN_REVIEW_PROTOCOL §3.2.)
- **A2. Pure merge helpers** in `src/config/reportTaxonomy.ts` (keep it dependency-free / no DB):
  - `SECTION_NAMES: string[]` — `REPORT_TAXONOMY.map(s => s.section)`; the allowed `section` values.
  - `mergeTaxonomy(base, extra: {name: string; section: string}[]): TaxonomySection[]` — clone base,
    append each extra leaf to its matching section's `leaves` (dedup; an extra whose section isn't in
    base is dropped defensively — create-time validation already forbids it). Pure, order-stable.
  - `mergedLeafSet(extra): Set<string>` — the flattened leaves of `mergeTaxonomy(REPORT_TAXONOMY, extra)`
    (**not** `TAXONOMY_LEAVES ∪ raw extra names`). Deriving it from the **same section-filtered merge**
    the manifest uses is what makes the manifest set and the verifier/validation set provably identical:
    an invalid-`section` row dropped from the manifest is dropped from the valid set too, so the two can
    never diverge and the admin routes can't fail open on a leaf the agent was never shown. (Codex
    round-1 P2, line 161.)
- **A3. DB-backed accessors** in a new `src/lib/reportCategories.ts` (async; the only place that
  reads the table): `listExtraCategories()` → `db.reportCategory.findMany({orderBy:{createdAt:'asc'}})`;
  `getMergedTaxonomy()` → `mergeTaxonomy(REPORT_TAXONOMY, await listExtraCategories())`;
  `getValidLeafSet()` → `mergedLeafSet(await listExtraCategories())`. Routes/components call these;
  purity stays in A2.

### Phase B — enforce the merged set at all seven consumers

- **B1. Verifier (sites 1–2, `src/lib/reportResult.ts`).** Add a **required** param:
  `verifyAgentResult(result, validLeaves: Set<string>)` and
  `parseAgentResult(body, validLeaves: Set<string>)`; replace the two `isTaxonomyLeaf(...)` calls
  (:116, :159) with `validLeaves.has(...)`. Pure. **No default** — every caller must pass a set, so the
  result route (B2) can't silently fall back to base (Codex round-2). Existing `reportResult.test.ts`
  callers are updated to pass an explicit set (clearer per-test intent anyway).
- **B2. Result callback route** (`src/app/api/agent/jobs/[jobId]/result/route.ts:45-47`). Compute
  `const validLeaves = await getValidLeafSet();` once, pass to both `parseAgentResult` and
  `verifyAgentResult`. This is the single place the merged set enters verification — read at callback
  time, so ⊇ whatever the manifest served earlier (Decision 2). This glue is the trust boundary: the
  required param (B1) makes omission a build error, and `test_result_callback_verifies_against_merged_set`
  (Verification) proves the *right* set is passed — a DB-leaf result verifies non-fatal end to end.
- **B3. Manifest route (site 5, `…/manifest/route.ts:49`).** `taxonomy: REPORT_TAXONOMY` →
  `taxonomy: await getMergedTaxonomy()`. `/api/agent/**` change — the agent now receives base ∪ DB.
- **B4. Admin category-validation routes (sites 3–4).** Replace `isTaxonomyLeaf(category)` with a
  membership test against the merged set — `(await getValidLeafSet()).has(category)` — in
  `transactions/[txId]/route.ts:28` and `report-mappings/[id]/route.ts:26`. Same `400` on miss.
- **B5. Assign picker (site 6, `ReportJobDetail.tsx`).** Stop importing the static `TAXONOMY_LEAVES`
  for the options; instead render from a merged, section-grouped list the **job-detail GET** now
  returns (B7). Add the Decision-5 `➕ הוספת קטגוריה` form (Hebrew) that POSTs to the new endpoint via
  the existing `action()` helper, then `load()`.
- **B6. Client report page (site 7, `report/page.tsx`).** Replace `REPORT_TAXONOMY` (:132) with
  `await getMergedTaxonomy()` so DB-category rows render and the by-leaf bucketing (:84) doesn't drop
  DB-category spend. Server component — direct `await` is fine.
- **B7. Job-detail GET** (`src/app/admin/api/reports/[jobId]/route.ts`) returns
  `categoryLeaves: string[]` (merged, section order) so the client `<select>` needs no separate fetch.

### Phase C — the create endpoint, tests, docs

- **C1. `POST /admin/api/report-categories`** (new `route.ts`). `authorizeReportsRequest` →
  parse `{name, section}` → validate: `name` a non-empty **trimmed, NFKC-normalized** string within a
  length cap (e.g. ≤ 60); `section ∈ SECTION_NAMES`; **not** already a base leaf
  (`!isTaxonomyLeaf(name)`) and **not** an existing DB row. Fail closed: bad shape → `400`
  (`שם קטגוריה לא תקין` / bad section), collision → `409` (`קטגוריה כבר קיימת`). Create with
  `createdBy: auth.actor`; return the row. (Also expose `GET` on this route to list categories, for
  reuse — optional; the UI relies on B7, so GET is only added if a second caller appears. Ponytail:
  omitted in v1.)
- **C2. Tests** (the named holes below; vitest + the existing `reportResult.test.ts` harness).
- **C3. Docs.** `docs/REPORTS_PIPELINE.md`: note the taxonomy is base-constant ∪ `ReportCategory`
  (add-only), merged at manifest/verification/UI so app↔agent still agree; add `ReportCategory` +
  `report-categories` to the file map. `src/config/reportTaxonomy.ts` header comment updated to say
  the manifest copy is base ∪ active DB categories.

## Non-goals

- **Editing / renaming / deleting / deactivating** categories (add-only v1 — Decision 2). A follow-up
  plan handles retirement and must re-answer the app↔agent skew question a delete reopens.
- **Custom sections** — a new category joins an existing base section (Decision 3).
- **Per-user or per-job categories** — the table is global, like `MerchantMapping`.
- **Unblocking already-FATAL jobs** — assigning categories never clears `verification.fatal`
  (Context 5); a job red for a total mismatch / duplicate / bad date stays blocked. That is the
  screenshot's separate problem, out of scope here.
- **Re-categorizing the stored xlsx** — admin category edits update `ReportTransaction` rows and the
  native `/report` view, not the agent-built workbook bytes (pre-existing behavior; unchanged).
- **Agent skill / workbook code changes** — none needed (Context 3).

## Ponytail cuts (Rev 1)

- **yagni:** per-job taxonomy **snapshot** column on `ReportJob` — cut. Add-only (Decision 2) makes
  the manifest set a subset of the verification set, so a snapshot buys nothing.
- **yagni:** `active`/soft-delete flag + delete/deactivate endpoints — cut. Removes the entire
  dispatch↔callback skew race class; retirement is a separate plan.
- **yagni:** custom sections / section CRUD — cut (Decision 3).
- **yagni:** standalone `GET /admin/api/report-categories` list route — cut; job-detail returns the
  merged leaves (B7).
- **yagni:** per-row "add category" affordance — cut for one section-level control (Decision 5).
- **shrink:** no new async taxonomy module for the *pure* merge — `mergeTaxonomy`/`mergedLeafSet` live
  beside the constant (A2); only DB reads go in `reportCategories.ts` (A3).
- **Kept deliberately:** the `validLeaves` **parameter** on the pure verifier (B1). It looks like
  churn, but it's what keeps `verifyAgentResult` pure and unit-testable while the valid set becomes
  dynamic — the alternative (DB read inside the verifier) breaks PLAN_REVIEW_PROTOCOL §4.

## Risks / contingencies

- **Guard-composition (the big one).** If any single site stays base-only while others use the merged
  set, a DB leaf passes one gate and fails another — a false FATAL (agent produced it, app rejects), an
  un-assignable leaf (picker offers it, assign route `400`s), or a leaf that verifies but never renders
  in the picker/report. Note the base-only tell differs by consumer: validation sites (1–5) use
  `isTaxonomyLeaf`; the UI/report sites (6–7) use the `TAXONOMY_LEAVES` / `REPORT_TAXONOMY` **constants**,
  which a grep for `isTaxonomyLeaf` would miss (Codex round-1). Mitigation: the Context-2 table
  enumerates all seven, and `test_no_consumer_left_on_base_only_check` covers 1–5 by source assertion
  **and** 6–7 by behavior (picker + report render a DB leaf).
- **App↔agent skew.** Closed by Decision 2 (add-only ⇒ manifest set ⊆ verification set). Reviewer
  ask 1 is explicitly to find a counter-interleaving; if one exists, the fallback is the snapshot
  column we cut.
- **Fail-open / false-FATAL regression.** The merged-set arg is **required** (no default), so a route
  that omits it fails `pnpm typecheck` rather than silently falling back to base (which would turn a
  legit DB leaf into a false FATAL). `test_result_callback_verifies_against_merged_set` pins the route
  glue end to end. (Codex round-2.)
- **Name hygiene / collision.** Trim + NFKC-normalize; reject base-leaf shadows and duplicates
  (`@unique` + pre-check). Prevents a near-duplicate Hebrew leaf that splits spend across two rows.
- **Prod migration.** Additive `CREATE TABLE`, safe under `prisma migrate deploy` (README build
  command), but it is a schema migration → owner sign-off before the implementation ships (§3.2).
- **`/report` fidelity.** A DB category with a valid base section renders under it; the section
  constraint (Decision 3) is what guarantees placement — hence enforced at create, not just trusted.

## Verification (named tests the implementation PR must carry)

Pure taxonomy (`src/config/reportTaxonomy.test.ts`, new):

- `test_mergeTaxonomy_appends_to_matching_section` — a `{name:"X", section:"שונות"}` extra appears at
  the end of `שונות`'s leaves; every other section is byte-identical to base; order stable.
- `test_mergeTaxonomy_drops_unknown_section` — an extra whose section isn't a base section is dropped
  (defensive; create-time validation already forbids it).
- `test_mergedLeafSet_is_base_union_db` — set = base leaves ∪ extra names, deduped.

Verifier (`src/lib/reportResult.test.ts`, extended):

- `test_verify_accepts_db_category_when_in_valid_set` — a txn with a DB leaf + `validLeaves`
  containing it → **not** FATAL. (Core: no false FATAL for an added category.)
- `test_verify_unknown_category_still_fatal` — a leaf in neither base nor the passed set → FATAL
  (fail-closed preserved).
- `test_verify_requires_explicit_valid_set` — `verifyAgentResult` / `parseAgentResult` take the valid
  set as a **required** arg (no default): a DB-only leaf is FATAL / dropped when the passed set excludes
  it, accepted when it includes it. (The old base-only default is gone — omission is a typecheck error,
  not a runtime fallback; Codex round-2.)

Routes (mocked `db` + auth, per the existing route tests):

- `test_result_callback_verifies_against_merged_set` — **the trust-boundary glue test** (Codex
  round-2). Seed a `ReportCategory` leaf; POST an agent result whose transaction *and* a proposed
  mapping use that DB leaf; assert the stored `verification.fatal === false` (no false FATAL) and the
  proposed `MerchantMapping` was created (not dropped by `parseAgentResult`). Proves B2 passes the
  merged set — not base — through the real route.
- `test_assign_accepts_db_category` / `test_assign_rejects_unknown` — assign route (site 3) `200` for
  a category present in `ReportCategory`, `400` for an absent one.
- `test_mapping_approve_accepts_db_category` — mapping route (site 4) `200` for a DB leaf.
- `test_create_category_rejects_base_leaf_collision` — POST `name` == an existing base leaf → `409`
  (no shadow).
- `test_create_category_rejects_unknown_section` — POST `section ∉ SECTION_NAMES` → `400`.
- `test_create_category_rejects_duplicate` — POST an existing DB name → `409`.
- `test_create_category_trims_and_bounds_name` — surrounding whitespace trimmed; empty/whitespace-only
  and over-cap → `400`.

Invariant (the review asks, banked as tests):

- `test_manifest_and_verification_share_valid_set` — over the same `ReportCategory` rows, the manifest
  route's serialized taxonomy leaves (site 5) equal `getValidLeafSet()` (the set B2 feeds
  verification), **including a row with an invalid `section`**: that row is absent from BOTH (both derive
  from the one filtered `mergeTaxonomy`, per A2), so the sets stay identical even on malformed data.
  Review-ask 1 as an executable check. (Codex round-1 P2, line 161.)
- `test_mergedLeafSet_derives_from_merged_taxonomy` — a `{name, section:"__nonexistent__"}` extra is in
  neither `mergeTaxonomy`'s leaves nor `mergedLeafSet`; a valid-section extra is in both. Pins the
  single-source derivation directly, independent of the route wiring.
- `test_no_consumer_left_on_base_only_check` — the guard-composition invariant across **all seven**
  sites, not only the `isTaxonomyLeaf` ones. Two parts: **(a)** no category-*validation* site (1–5)
  calls bare `isTaxonomyLeaf` for runtime membership except the documented strict default in
  `reportResult.ts` and the base-leaf-collision check in the create route (source-level assertion);
  **(b)** the UI/report consumers (6–7) render from the merged source — asserted by **behavior, not
  grep**, since they use the constants `TAXONOMY_LEAVES` / `REPORT_TAXONOMY` rather than
  `isTaxonomyLeaf`: `test_assign_picker_includes_db_category` (the job-detail GET's `categoryLeaves`
  and the rendered `<select>` contain a DB leaf) and `test_report_page_renders_db_category` (`/report`
  section rows / by-leaf bucketing include a published DB-leaf txn). A static base-only import for the
  category list would fail these. Review-ask 2 as an executable check. (Codex round-1 P2, line 296.)

Manual (dev server, after owner-approved migration): add a Hebrew category in the review UI → it
appears in the assign dropdown → assign it to an uncategorized row → dispatch a fresh job → confirm
the category is in `/api/agent/jobs/:id/manifest` and that a returned txn using it verifies **without**
a FATAL → publish → confirm it renders on `/report`.

## Trust-boundary checklist (PLAN_REVIEW_PROTOCOL §4)

- **Authorization key:** the create endpoint reuses `authorizeReportsRequest` (exact same admin gate
  as every sibling reports route) — no new auth surface.
- **Fail closed:** unknown category → FATAL / `400`; pure verifier defaults to the base set;
  create rejects bad section / collision / empty.
- **Field extraction per type:** the merged set is built one way (`mergedLeafSet`) and consumed
  identically at manifest and verification — no per-path divergence.
- **Guard composition:** all seven consumers move to the merged set together; two invariant tests pin
  it.
- **Pure + tested:** `mergeTaxonomy` / `mergedLeafSet` / `verifyAgentResult` / `parseAgentResult` stay
  pure and unit-tested; DB reads isolated in `reportCategories.ts`; routes are thin glue.
