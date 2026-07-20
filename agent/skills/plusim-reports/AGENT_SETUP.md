# onlyclaw setup runbook — plusim-reports

Ops steps to wire the `onlyclaw` agent (AgentGlob dashboard) to the Plusim
reports pipeline. The skill source of truth is THIS folder in the Plusim repo;
the agent runs a copy installed in its workspace.

## 1. Install the skill (workspace skill, per-agent)

Copy this folder into the agent's workspace so it loads with highest
precedence:

```
<onlyclaw workspace>/skills/plusim-reports/
├── SKILL.md
├── scripts/  (run_job.py, parse_isracard_xlsx.py, parse_max_pdf.py,
│              build_report_xlsx.py, verify_report.py)
└── reference/ (categorization-rules.md, layout-spec.md)
```

Per AgentGlob's integration model this is a **B2-style per-agent integration**:
activation must be explicit for onlyclaw (Tools/skill picker), never
default-on for other agents.

## 2. Secrets (dashboard → workspace secrets → env)

| Env var | Value |
|---|---|
| `PLUSIM_RUNTIME_URL` | `https://plusim.xyz` |
| `PLUSIM_RUNTIME_TOKEN` | the SAME value as the app's `PLUSIM_AGENT_RUNTIME_TOKEN` (generate once: `openssl rand -base64 32`) |

The skill's `metadata.openclaw.requires.env` gates on both — without them the
skill stays inert.

## 3. Tools config for onlyclaw

Required tools (openclaw `tools` policy): `exec` (+`process`), `read`, `write`
(`group:runtime`, `group:fs`). `web_fetch` optional (scripts use python
urllib). NOT needed: `browser`, `canvas`, `nodes`, `cron`.

## 4. Python runtime deps — VENDORED into the skill (one-time)

Do NOT rely on `pip install --user`: the exec sandbox wipes `~/.local`
between calls, so user-site installs silently vanish. Instead, vendor the deps
into the skill folder itself (which persists in the workspace):

```
python3 -m pip install --target <onlyclaw workspace>/skills/plusim-reports/vendor openpyxl pypdf
```

`run_job.py` self-bootstraps `vendor/` onto `sys.path`, so a bare `python3`
runs the whole pipeline — no PYTHONPATH, no pip at job time. The `vendor/`
folder is workspace-only (gitignored here); rebuild it with the command above
after any fresh install of the skill from this repo.

## 5. App-side env (Coolify)

- `PLUSIM_AGENT_RUNTIME_TOKEN` — same secret as §2.
- `APP_BASE_URL=https://plusim.xyz`.

## 6. Smoke test

1. In the Plusim admin → Reports, upload one statement and press
   **Send to agent**; or simulate locally:

   ```
   python3 scripts/run_job.py prepare --manifest-file <local manifest> --workdir /tmp/wd
   # write /tmp/wd/judgments.json
   python3 scripts/run_job.py finalize --workdir /tmp/wd --dry-run
   ```

2. Expect the admin job page to reach `completed` with per-source
   reconciliation ✓ (agora-exact). `needs_review` means a total mismatch or a
   malformed callback — the verification panel lists the reasons.

## Security notes

- Job chat sessions are isolated (`app:plusim:report-job:<jobId>`, no
  `appUserId`) — the skill must not write user memory or per-user files.
- The skill's cleanup step deletes downloaded statements from the workspace
  after every job (they contain personal financial data).
- The runtime token only reaches `/api/agent/jobs/*` routes, which also demand
  a short-lived per-job token minted at dispatch.
