# Plan-Review Protocol (Claude ⇄ Codex)

> **Provenance:** this is a synced copy of the canonical shared protocol that lives in
> `cryptolir/openclaw-dashboard` at `docs/PLAN_REVIEW_PROTOCOL.md`. Plusim keeps its own copy so the
> `.github/workflows/` automation can reference it in-repo. The canonical version is authoritative —
> when the two diverge, re-sync from openclaw-dashboard rather than editing the process here. The
> billing/Stripe examples below are the protocol's origin story; in Plusim the trust boundaries are
> the `/api/agent/**` and `/api/chat` surfaces, admin auth/Drive-OAuth gates, and Prisma schema
> changes (see §1).

> Shared work protocol for both agents. Claude Code loads it via CLAUDE.md, Codex via AGENTS.md.
> Origin: the self-serve-billing plan loop (PR #143, #159) — Codex caught three real trust-boundary
> holes (client plan-writes, customer-vs-subscription authorization, non-null-vs-identity guard)
> **in plan documents**, before any of them could ship as webhook code. Owner directive 2026-07-06:
> make this the standing process and automate the handoffs.

---

## 1. When a plan is REQUIRED before code

Any change touching a **trust boundary**:

- Billing: webhook authorization, plan writes, Stripe binding, spend/limit enforcement
- Auth: sign-in flows, session/role logic, admin gates
- Public unauthenticated surfaces (`/api/public/**`, webhooks)
- Data migrations or schema changes
- Infra/deploy configuration

Routine UI, copy, docs, and additive low-risk CRUD do **not** need a plan PR — use the normal
release pipeline directly.

## 2. The loop

```
plan branch (docs/plans/active/<topic>.md, file-anchored, off fresh main)
    → /ponytail pass on the plan (strip over-engineering BEFORE handoff)
        → PR with explicit review asks (name the invariants to attack)
            → Codex adversarial review
                → changes requested? → Claude revises as Rev N on the same branch → re-review
                → approved? → merge plan PR → Claude implements EXACTLY the plan
                    → implementation PR (carries the plan's test list)
                        → same adversarial review on the CODE
                            → squash-merge → CI auto-deploys
```

Rules:

- **Ponytail the plan before the first Codex handoff.** Run `/ponytail` (the `ponytail-review`
  skill) on the draft plan **before** opening the PR — cut speculative scope, reinvented stdlib,
  and abstractions with one caller, so Codex reviews a lean plan on its correctness, not its bloat.
  Over-engineering caught here is a deleted paragraph; caught after code, it's a rewrite. The
  ponytail pass is the author's job (Claude), one line in the PR body confirming it ran.
- **Plans are file-anchored.** Quote the real code being changed (read it first). Plans written
  from memory are where authorization holes hide.
- **Every review round = a new Rev** (header line + resolution notes in the doc + a PR reply).
  Never silently rewrite reviewed text.
- **Every caught hole becomes a named test case** in the plan's test section, and the
  implementation PR must contain those tests. A review's value is only banked as a test.
- **Approved plan ≠ done.** The plan→code gap (wrong field per event type, a guard on the wrong
  branch, two guards cancelling out) is where correct designs still ship broken. The
  implementation PR gets the same scrutiny — explicitly re-verify field extraction and guard
  interactions against the live API's actual shapes, not the plan's description of them.

## 3. Act vs. ask (decision policy — owner-set, 2026-07-06)

After a Codex review lands on a plan PR, the acting agent proceeds **autonomously**:

| Review outcome | Action — no permission needed |
|---|---|
| Changes requested | Revise the plan on the same branch, push, reply, re-request review |
| Approved, standard implementation | Merge the plan PR; implement exactly as written via the release pipeline (branch → typecheck + tests + build → PR → squash-merge → CI auto-deploy) |

**Stop and ask the owner ONLY when:**

1. Implementation must **deviate from the approved plan** (discovered mid-build).
2. **Production risk beyond the standard pipeline**: manual prod data mutations, schema/data
   migrations, secret or infra/DNS changes, rollbacks, anything irreversible.
3. **Major user-flow change** (signup / login / checkout / pricing UX shape) that the approved
   plan does **not** explicitly specify. If the plan specifies it, the plan approval IS the
   authorization.

## 4. Trust-boundary review checklist

What the three caught bugs generalize to — reviewers attack these; authors pre-check them:

- **Authorization key**: every check compares the *exact bound identity* (this workspace's
  subscription), never a proxy (customer-ever-existed, same-owner, non-null).
- **Non-null ≠ identity**: "a thing exists" is not authorization; "this event is about THE bound
  thing" is.
- **Field extraction per event type**: the same fact lives in different fields per message type
  (Stripe lifecycle events: `event.data.object.id`; checkout sessions: `object.subscription`).
  Wrong field silently rejects everything or accepts everything.
- **Guard composition**: new guards must compose with existing ones (idempotency, ordering),
  not cancel them.
- **Fail closed**: unknown price/plan/event → ack + loud log + no write; never a default tier.
- **Pure + tested**: trust-boundary decisions are pure functions (no SDK/Firestore) under
  `node:test`; route handlers stay thin glue.

## 5. Automation (GitHub Actions)

- **`plan-review-request.yml`** — a PR touching `docs/plans/**` (opened / ready-for-review) gets
  a `plan-review` label and, if the `CODEX_REVIEW_PAT` repo secret is set, an auto-comment
  mentioning `@codex review` with the review asks pointer. **The mention must be posted by a
  GitHub identity connected to a Codex/ChatGPT account** — Codex bounces any mention from
  `github-actions[bot]` with "create a Codex account and connect to github" regardless of repo
  connector settings (confirmed on PRs #170/#172/#173/#174; every review that ever actually fired
  came from a human posting `@codex review` via `gh pr comment`). That's why the workflow needs a
  PAT for a real Codex-connected account (e.g. `cryptolir`) in `CODEX_REVIEW_PAT` — without it, the
  workflow only applies the label and posts a comment telling you to request the review yourself.
- **`claude.yml`** — triggers on **(a)** any `@claude` mention in a comment/review, and **(b)** a
  review submitted by the Codex GitHub app (`chatgpt-codex-connector[bot]`) on a **plan PR** — one
  carrying the `plan-review` label. The app writes its findings as **inline review comments** and
  does **not** emit a verdict line, so Claude reads the inline comments and treats actionable
  findings as `changes-requested`, an empty/👍 review as `approved`, then acts per §3 (CLAUDE.md
  auto-loaded). `pull_request_review` has no `paths` filter, so the label (applied by
  `plan-review-request.yml` to PRs touching `docs/plans/**`) is what scopes trigger (b) to plan PRs;
  a Codex review on any other PR falls to the `@claude` fallback below. The action runs in
  **automation mode** (a `prompt` input) so it acts as soon as the job fires — without it the action
  waits for a literal `@claude` in the event and silently no-ops on a Codex app review (which has
  none). Billed to a **Claude subscription** via the `CLAUDE_CODE_OAUTH_TOKEN` repo secret
  (`claude setup-token`), not the pay-as-you-go API key.
- **Manual path** — the cloud run is optional. From any logged-in Claude session (local or the dev
  server) you can act on a Codex review directly ("handle the Codex review on PR #N"); it uses that
  session's subscription and needs no token, secret, or runner.
- **Codex handoff line (human/CLI Codex only)** — a Codex session driven through AGENTS.md ends its
  review with, on its own line: `@claude verdict: approved` or
  `@claude verdict: changes-requested — <one-line summary>`. The Codex **app** doesn't do this
  (hence trigger (b) above). Manual fallback for either: comment `@claude act on the codex review above`.
- **Loop safety**: runs are serialized per PR (`concurrency` group); the Claude action never
  responds to its own comments; the `plan-review-request.yml` auto-comment carries no `@claude`
  mention; and a **circuit-breaker** stops Claude from auto-folding past the 4th review round on one
  PR — repeated non-convergence escalates to the owner instead of looping.
- **Reading review status — check ALL THREE comment streams.** Codex posts its verdict as a PR
  **review** (`pulls/<n>/reviews`) with findings as **inline review comments** (`pulls/<n>/comments`);
  clean human/CLI verdicts land as top-level **issue comments** (`issues/<n>/comments`).
  `gh pr view --json comments` returns ONLY the last stream, so it shows Codex as ABSENT even after
  it reviewed — this mis-diagnosis happened twice (2026-07-10, 2026-07-21 PR #221). Merge all three,
  chronologically:

  ```bash
  gh api repos/OWNER/REPO/issues/N/comments   # top-level comments (clean verdicts)
  gh api repos/OWNER/REPO/pulls/N/reviews     # review submissions (Codex app verdict shell)
  gh api repos/OWNER/REPO/pulls/N/comments    # inline review comments (the actual findings)
  ```

  (Operators with the `gh prc` alias installed: `gh prc N OWNER/REPO` does this in one call.)
- **A SKIPPED `claude` check on a non-plan PR is BY DESIGN, not a broken trigger.** The
  auto-verdict path (trigger (b) above) is scoped to PRs carrying the `plan-review` label; on
  code/chore PRs the workflow run exists but its job `if` evaluates false → conclusion `skipped`.
  Use the manual `@claude` fallback there instead of debugging the automation.

### Running it yourself (local machine or dev server)

The cloud action is optional — any Claude Code session logged into the subscription can act on a
Codex review directly. On a headless box (dev server), authenticate once with a token instead of
the interactive browser login:

```bash
npm i -g @anthropic-ai/claude-code            # if not installed
claude setup-token                            # approve once via the printed URL → prints a token
echo 'export CLAUDE_CODE_OAUTH_TOKEN="<paste-token>"' >> ~/.bashrc && source ~/.bashrc
gh auth status                                # gh must be logged in too (for PR comments/pushes)
```

Then run `claude` and say: **"handle the Codex review on PR #N."** Notes:

To start a **new** plan the same way, [`docs/plan-review-launcher.html`](./plan-review-launcher.html)
(open locally in a browser) builds the launch command + kickoff prompt for a topic/model/machine —
copy-paste, it doesn't execute anything itself.

- The token is saved under the **running user's** home (`~/.bashrc`) — set it up as the same user
  that will run `claude` (root's token only loads for root shells). It's per-shell, not per-folder:
  `cd` anywhere and it stays set.
- Same token *type* as the CI secret (`CLAUDE_CODE_OAUTH_TOKEN`) — the action reads it as a repo
  secret, the CLI as an env var. Use a **separate** token per environment so each is revocable alone.
- Never commit the token or put it in a repo file — shell profile or a systemd `Environment=` line only.

## 6. Origin / provenance

- Billing plan loop: `docs/plans/self-serve-billing-plan.md` (Rev 3.1, PRs #136/#143) — reviewer
  caught the first-checkout binding contradiction pre-code.
- Comp-plan loop: `docs/plans/comp-plan-admin-ui.md` (Rev 3, PR #159) — reviewer caught
  customer-vs-subscription authorization, then non-null-vs-identity + per-event-type field
  extraction. All three encoded as `decideBinding` test cases.
