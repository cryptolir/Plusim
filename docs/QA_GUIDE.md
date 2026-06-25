# Havaya — QA Testing Guide

A plain-language checklist for testing the latest features. You can do **everything here from the
website (app.havaya.me) and the chat** — no developer tools or server access needed.

**What we're testing now:** `app.havaya.me` with the `life` agent build **`v2026.06.20.2`**.

The agent answers in **Hebrew**, so the example replies below are in Hebrew.

---

## How to read this guide

- **Do this** — the steps to follow.
- **Should happen (Pass)** — what a working app looks like.
- **Problem (Fail)** — what to report if you see it.
- A ⭐ marks the most important checks for this release.

When something fails, write down: which account you used, whether it was a **fresh chat or a
continued one**, the **exact message you typed**, a **screenshot of the agent's reply**, the time,
and the build name (`v2026.06.20.2`).

---

## What's new in this release (in plain words)

- **The app knows you by name** — on the home screen and in chat, including on your very first message.
- **The app remembers you** — facts you share stick around across different chats.
- **The app can run guided exercises** — e.g. the personal-vision / TAL method.
- **Slow answers no longer fail** — longer exercises now have more time to reply instead of giving up.
- **Faster behind the scenes** — replies are a bit quicker; nothing should look different.
- **Admin → Google Drive meetings** — browse meeting folders, summarize a transcript with a
  **preview before saving**, edit the summary method, and more.

---

## Before you start — what you'll need

- A **normal account** on `app.havaya.me` that has a **first name** filled in (the greeting uses it).
- A **brand-new account with no past chats** (to test the first message cleanly).
- An **admin account** (one that's on the admin list) with **Google Drive already connected** at
  `/admin/drive` — needed only for Section C.

---

## A. Knowing you & remembering you ⭐

### A1 — Greets you by name on the home screen
1. Sign in and land on the home screen.
2. **Should happen:** a personal hello with your name, e.g. **"שלום, <name>"**.
3. **Problem:** a generic hello, no name, or the wrong name.

### A2 — Greets you by name on your FIRST chat message ⭐
1. Open a **brand-new chat** (or refresh the app), then send your **first** message: `היי` (or `Hi`).
2. **Should happen:** the agent greets you **by name** right away, e.g. **"היי <name> 🌿"**, and keeps going.
3. **Problem:** it asks **"מה השם שלך?" / "what's your name?"** on the first message.
4. Try it again after a **page refresh** and after starting a **"new chat"** — both must greet you by name first.

### A3 — Remembers your name during the chat
1. After A2, ask: `אתה זוכר את השם שלי?` ("do you remember my name?").
2. **Should happen:** it confirms your name.
3. **Problem:** it asks again or gets it wrong.

### A4 — Remembers you in a later chat
1. In one chat, tell it something lasting about you (for example, a goal).
2. Later, start a **new** chat and ask about it.
3. **Should happen:** it recalls what you said.
4. **Problem:** no memory of it / treats you like a stranger.

### A5 — Brand-new user
1. With the brand-new account (first name filled in), open the app and start chatting.
2. **Should happen:** greeted by name.
3. **Note (report it, don't mark as fail):** an account with **no first name set** may still be
   asked its name on the first chat.

---

## B. Guided exercises (skills)

### B1 — Runs a guided method
1. Ask for a guided exercise, e.g. `בוא נעשה תרגיל חזון אישי` ("let's do a personal-vision exercise"),
   or ask for the TAL method.
2. **Should happen:** the agent **walks you through the steps** of the method (a real structure),
   not a vague one-line answer.
3. **Problem:** "I can't do that / I don't have that", an error, or a flat generic reply.

### B2 — A slow exercise still answers ⭐
1. During a longer exercise, some replies take a while (up to ~1.5 minutes). Be patient and wait.
2. **Should happen:** the answer eventually arrives.
3. **Problem:** it gives up with **"הפסקנו להמתין לתשובה"** ("we stopped waiting for a reply") or a timeout.
   (This is exactly the slow-reply case the latest fix addresses — report it if you see it.)

---

## C. Admin → Google Drive meeting transcripts (admin account only)

### C1 — Browse the meeting folders
1. Go to `/admin/drive`.
2. **Should happen:** you see the connected Drive folder's subfolders and files; the breadcrumb links
   let you move in and out of folders.
3. **Problem:** an error, an empty page, or a "connect Google Drive" screen even though Drive is connected.

### C2 — Assign a folder to a user
1. Go to `/admin` → pick a user → Drive → choose a subfolder → save.
2. **Should happen:** the assignment is still there after you reload the page.
3. **Problem:** it doesn't save / resets on reload.

### C3 — Summarize a meeting, with a PREVIEW before saving ⭐
1. Open a transcript → click **Summarize**.
2. **Should happen — the preview:** a summary appears **on screen first as a preview** (nothing is
   saved yet). It's in Hebrew and follows the TAL structure — a TITLE/DATE header plus the 6 sections:
   מצוי / רצוי / דפוסים / החלטות ופעולות / הזהות הנבחרת / צעד קטן.
3. **Edit the preview** if you want, then click **Save to folder**.
4. **Should happen — after save:** the summary is saved back into the Drive folder, and what you saved
   matches what the preview showed (including your edits).
5. **Problem:** no preview appears; the preview is empty, in English, or unstructured; you get
   `(no reply)` or a timeout; or what's saved doesn't match the preview.

### C4 — The summary-method editor (same setting on two pages) ⭐
1. Open `/admin/settings` **and** `/admin/drive` (the "Summary method (skill)" box **below** the Drive browser).
2. Change the text on **one** page, Save, then reload the **other** page.
3. **Should happen:** the same saved text shows up on both pages (it's a single shared setting).
4. Run a **new summary** and check the **preview** follows your edited method. "Load default" puts the
   built-in TAL method back.
5. **Problem:** the two pages disagree, or the preview ignores your edited method.

### C5 — Edit or delete a transcript
1. Open a file → view/edit the raw text → save. Then try **Delete**.
2. **Should happen:** your edit is kept after reload; a deleted file moves to the Drive trash and
   disappears from the list.
3. **Problem:** edits are lost, or the file is still listed after deleting.

### C6 — "Past meeting" card on the home screen
1. As a **user who has saved summaries** in their assigned folder, open the home screen.
2. **Should happen:** a **"Past meeting"** card appears; clicking it starts a chat that **knows about
   the latest meeting** (the agent refers to it).
3. **Problem:** no card even though summaries exist, or the chat has no idea about the meeting.

---

## D. Recent-chats panel ⭐ (new)

A "שיחות אחרונות" (recent chats) list now appears on the home screen, under the suggested prompts.

1. Open the home screen.
2. **Should happen:** a **"שיחות אחרונות"** list showing your **5 most recent** conversations, newest first.
   Clicking a row opens that chat.
3. The chat you're currently in is **highlighted**.
4. A chat with **new activity you haven't opened yet** shows a small **dot** at the leading (right) edge.
   Open that chat → the dot clears.
5. **Should happen:** opening a chat does **not** reshuffle the list order.
6. **Problem:** the list is missing/empty when you have chats, shows the wrong order, the dot never
   clears (or never appears for unread), or clicking a row opens the wrong chat.

## E. Quick once-over of the home screen

Open the home screen and check each part loads and works without errors:
- the suggested-prompts panel (clickable prompts),
- the owner's note,
- the latest videos,
- the bottom menu (journey / home / community).

> **Note:** the **microphone / voice input** button was **removed** from the chat composer in this
> release — it's expected to be gone. Report it only if a mic button is **still** showing.

---

## Most important checks this release

1. **A2** — greeted by name on the first message.
2. **C3** — the summary preview shows before saving, and the saved file matches it.
3. **C4** — the method editor is the same on both pages and the preview respects it.
4. **B2** — slow exercises still answer instead of timing out.
