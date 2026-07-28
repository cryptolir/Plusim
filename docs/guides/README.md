# User guides (Hebrew)

End-user documentation for Plusim, in Hebrew (RTL) to match the app's UI.

| Guide | Audience | Covers |
|---|---|---|
| [CLIENT_GUIDE.he.md](./CLIENT_GUIDE.he.md) | Clients (signed-in users) | Signing in, the home hub + chat, the `/report` section (month tables, xlsx, Google Sheet), privacy, FAQ |
| [ADMIN_GUIDE.he.md](./ADMIN_GUIDE.he.md) | Admins (`ADMIN_EMAILS`) | Users + Drive folder assignment, meeting transcripts, the full report workflow (upload → send → review → publish), the settings control panel, troubleshooting |

These are **operational** guides — what a person clicks and sees. Technical
design lives in [`docs/REPORTS_PIPELINE.md`](../REPORTS_PIPELINE.md),
[`docs/DRIVE_INTEGRATION.md`](../DRIVE_INTEGRATION.md),
[`ARCHITECTURE.md`](../../ARCHITECTURE.md), and [`DEPLOY.md`](../../DEPLOY.md).

## Keeping them current (maintenance contract)

The guides are versioned with the code **so they ship together**. Treat them as
part of the definition of done:

> **Any change to a user-facing surface must update the matching guide in the
> same PR.** If a PR changes what a user sees or clicks and the guide isn't
> touched, the PR is incomplete.

What counts as user-facing:

| Change | Update |
|---|---|
| New/renamed page, nav item, or button label | Both guides (whichever the surface belongs to) |
| New setting in `/admin/settings` | `ADMIN_GUIDE.he.md` — the settings table |
| Change to the report workflow (statuses, publish rules, verification) | `ADMIN_GUIDE.he.md` — section 3 |
| Change to `/report`, the home hub, or the chat UX | `CLIENT_GUIDE.he.md` |
| New client-visible feature | `CLIENT_GUIDE.he.md` + a ROADMAP "Shipped" entry |
| Agent behavior a person must reason about (e.g. categorization rules) | `ADMIN_GUIDE.he.md` |

Also:

- **Hebrew, RTL.** Wrap content in `<div dir="rtl">`; keep code/paths/env names LTR.
- **Mirror the real UI.** Quote the actual on-screen Hebrew labels (e.g. **שליחה לסוכן**,
  **פרסום למשתמש**) so the guide matches what the user sees. When a label changes
  in the code, change it here.
- **Bump the "עודכן לאחרונה" date** at the top of any guide you edit.
- **No secrets, no PII** — no tokens, env values, or real client/statement data.
