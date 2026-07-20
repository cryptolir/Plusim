# Recent-chats panel ("שיחות אחרונות") — design plan

**Status:** ✅ **Implemented & shipped to prod** (app.havaya.me) — PR #26, merged `f494388` on 2026-06-20 (incl. both codex review rounds + the empty-placeholder prune side fix). This is the as-built design record.

**Codex review `4536690630` — resolved (v2), folded into the sections below:**
1. **`Conversation.updatedAt` is not auto-bumped on `Message` create** (verified in `route.ts`: the `conversation.update` runs only on the first message, to set the title). Continued chats would keep their first-message timestamp → stale ordering. Fix: explicitly touch `updatedAt` on **every** message (§5).
2. **Empty wrapper → blank desktop column.** Both panels can render `null`; the shared `lg:w-72` wrapper would still reserve 288px. Fix: render the wrapper only when it has content (§3).
3. **Existing conversations need a backfill decision.** A new `ConversationView` table means every pre-existing chat has no view row → all show as unread on first load. Fix: backfill `lastViewedAt = updatedAt` in the migration so old chats start "read" (§1).
4. **Dot slot needs a fixed placeholder** so rows with/without a dot stay aligned. Fix: an always-rendered `size-2` leading slot, dot inside it conditionally (§4).

## Context

The home hub (`app.havaya.me`) currently has a right-hand column with a single section, **"רעיונות לשיחה"** (conversation-idea prompts). Users have no way to see or jump back into their previous conversations from the home page — chats are only reachable by a direct `/chat?cid=` URL. We're adding a ChatGPT-style **recent-conversations list** directly **under** that section: a bold title, single-line rows for the **5 most recent** chats, the active chat highlighted with a soft rounded gray background, and a **"new activity" dot** on chats updated since the user last viewed them. It must read correctly in Hebrew/RTL.

Stack: Next.js 16 (app router) + TS + Tailwind v4 + Clerk + Prisma (Postgres). Deploy = push `main` → Coolify auto-build; `prisma migrate deploy` runs on container start.

## Locked decisions

- **Title:** `שיחות אחרונות` (bold).
- **Unread dot:** **database-backed** (persistent across devices, server-rendered) — new `ConversationView.lastViewedAt`.
- **Dot:** blue (`bg-blue-500`; emerald `bg-primary` is the on-brand alternative — one-line swap), placed at the **leading/start edge** (right in RTL).
- **Cap:** top **5** by `updatedAt` desc.
- **Click:** navigate to the existing full-height chat page `/chat?cid=<id>` (reuses its hydration path; simpler/robust than loading into the small home Thread).
- **Selected row:** the conversation whose id equals the home Thread's active `conversationId` (from the runtime); none highlighted on a fresh load.
- **Placement:** a shared right-column wrapper holding `PromptsPanel` (top) + the new panel (below), inside the existing `HomeHub` layout.

## Changes (by file)

### 1. Schema + migration — `prisma/schema.prisma`
Add a 1:1 view-tracking table (a separate table avoids Prisma's `@updatedAt` auto-bump on `Conversation`, so marking-viewed never reorders the recency list):
```prisma
model Conversation {
  // …existing fields…
  view ConversationView?
}

model ConversationView {
  conversationId String       @id
  lastViewedAt   DateTime
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
}
```
Generate with `pnpm prisma migrate dev --name add_conversation_view` against the dev Postgres (`havaya-postgres-dev`); it auto-applies to prod on deploy.

**Backfill existing conversations (finding 3)** — append a data step to the generated `migration.sql` so pre-existing chats don't all light up as unread on first load:
```sql
INSERT INTO "ConversationView" ("conversationId", "lastViewedAt")
SELECT "id", "updatedAt" FROM "Conversation";
```
Seeds `lastViewedAt = updatedAt` ⇒ `updatedAt > lastViewedAt` is false ⇒ existing chats start "read" (dots only appear on genuinely new activity afterward).

### 2. Server query + props — `src/app/page.tsx`
In the signed-in branch, add the top-5 query to the existing `Promise.all` (scoped by `userId`; `db` from `@/lib/db` — add the import if not already present), then compute `unread` server-side and serialize `updatedAt` to ISO before crossing into the client `HomeHub`:
```ts
const recent = await db.conversation.findMany({
  where: { userId, messages: { some: {} } }, // skip empty placeholders — see "Side fix"
  orderBy: { updatedAt: "desc" },
  take: 5,
  select: { id: true, title: true, sectionContext: true, updatedAt: true,
            view: { select: { lastViewedAt: true } } },
});
const recentChats = recent.map((c) => ({
  id: c.id, title: c.title, sectionContext: c.sectionContext,
  updatedAt: c.updatedAt.toISOString(),
  unread: !c.view || c.updatedAt > c.view.lastViewedAt,
}));
```
Pass `recentChats={recentChats}` to `<HomeHub>`.

### 3. Layout refactor — `src/components/home/HomeHub.tsx` + `PromptsPanel.tsx`
- `HomeHub`: add `recentChats: RecentChat[]` to props; destructure `conversationId` from `useHavayaRuntime({})` (confirmed exposed, `havayaRuntime.ts:181`). Replace the bare `<PromptsPanel … />` with a shared column wrapper that **only renders when at least one panel has content (finding 2)** — otherwise the `lg:w-72` column reserves 288px of blank space and squeezes the Thread:
  ```tsx
  {(prompts.length > 0 || pastMeeting || recentChats.length > 0) && (
    <div className="flex w-full shrink-0 flex-col gap-4 lg:w-72">
      <PromptsPanel prompts={prompts} onPick={sendMessage} disabled={isRunning}
        pinned={pastMeeting ? PAST_MEETING_PINNED : null} />
      <RecentChatsPanel chats={recentChats} activeConversationId={conversationId} />
    </div>
  )}
  ```
- `PromptsPanel.tsx`: change the `<aside>` className `shrink-0 lg:w-72` → `w-full` (the wrapper now owns the width). Its internal `null`-when-empty and mobile horizontal-scroll behavior are unchanged.
- Mobile (page is `flex-col`): Thread → prompts (horizontal scroll) → recent chats (vertical list) stacked. Desktop (`lg:flex-row-reverse`): right column = prompts above, recent chats below.

### 4. New component — `src/components/home/RecentChatsPanel.tsx` (client)
Exports `RecentChat` type `{ id; title: string|null; sectionContext: string|null; updatedAt: string; unread: boolean }`.
- Returns `null` when `chats.length === 0` (hide the whole panel for new users).
- Title: `<h2 className="mb-2 px-1 text-sm font-bold text-foreground">שיחות אחרונות</h2>`.
- Rows: `<ul className="flex flex-col gap-0.5">`, each row a `<Link href={`/chat?cid=${chat.id}`} aria-current={isActive ? "page" : undefined}>` styled:
  - base: `flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors`
  - active (`chat.id === activeConversationId`): `bg-muted font-medium text-foreground`
  - inactive: `text-muted-foreground hover:bg-muted/60 hover:text-foreground`
- **Dot (finding 4):** an **always-rendered** fixed leading slot keeps every row's text aligned whether or not it has a dot — `<span className="flex size-2 shrink-0 items-center justify-center">` — with the dot itself rendered *inside* it only when `chat.unread && chat.id !== activeConversationId` (never nag the chat you're looking at): `{showDot && <span className="size-2 rounded-full bg-blue-500" aria-label="חדש" />}`. As the leading child it sits at the start = right in RTL.
- Label: `<span dir="auto" className="line-clamp-1 flex-1 text-start">{label}</span>` where `label = title?.trim() || hebrewSectionLabel(sectionContext) || "שיחה חדשה"` (`past_meeting → "פגישה קודמת"`).
- Reuses: `cn` (`@/lib/utils`), `Link` (`next/link`), tokens `bg-muted`/`rounded-xl` (soft gray), and the row/title patterns from `PromptsPanel.tsx` + `DriveBrowser.tsx`. Server-computed `unread` ⇒ no `localStorage`/mount-gating, no hydration mismatch (server and first client render both have `activeConversationId === null`).

### 5. Mark-viewed (clears the dot) — 3 small touch-points
- **`src/app/api/chat/route.ts`** (POST) — two writes per message, after the assistant reply:
  - **Bump recency (finding 1):** today the `conversation.update` runs only `if (isFirstMessage)` (title) — so continued chats never bump `updatedAt`. Make it run on **every** message so the list orders by last activity:
    ```ts
    await db.conversation.update({
      where: { id: conversation.id },
      data: isFirstMessage ? { title: message.slice(0, 80) } : { updatedAt: new Date() },
    });
    ```
    (Both branches bump `updatedAt` — `@updatedAt` is set to ~now on any row update.)
  - **Clear the dot:** then upsert the view *after* the bump (so `lastViewedAt >= updatedAt` ⇒ not unread):
    ```ts
    await db.conversationView.upsert({
      where: { conversationId: conversation.id },
      create: { conversationId: conversation.id, lastViewedAt: new Date() },
      update: { lastViewedAt: new Date() },
    });
    ```
  Note: the mark-viewed-only paths below (opening `/chat`) upsert the view **without** touching `updatedAt` — that's the point of the separate table: *viewing* a chat must not reorder it, only *messaging* does.
- **`src/app/api/chat/mark-viewed/route.ts`** (NEW POST): `getCurrentUser()` → verify the conversation belongs to the user → same upsert. Returns `{ ok: true }`.
- **`src/app/chat/page.tsx`**: in the existing `cid`-hydrate effect, after a successful hydrate, `fetch("/api/chat/mark-viewed", { method: "POST", body: JSON.stringify({ conversationId: cid }) })` (fire-and-forget) so opening an old chat clears its dot.

## Reused utilities / patterns (do not reinvent)
- `getCurrentUser()` → `@/lib/auth` (Clerk userId, scopes every query).
- `db` → `@/lib/db`; index `@@index([userId, updatedAt(sort: Desc)])` already exists for the top-5 query.
- `useHavayaRuntime()` exposes `conversationId` + `hydrate` (`src/lib/havayaRuntime.ts:181`).
- Styling precedents: `PromptsPanel.tsx` (bold-title + list rows), `DriveBrowser.tsx` (`hover:bg-muted` rows), `BottomNav.tsx` (active state). RTL via global `dir="rtl"` + logical utils (`text-start`).

## Verification
1. **Schema/client:** `pnpm prisma migrate dev --name add_conversation_view` (dev DB) → regenerates the Prisma client with `ConversationView`.
2. **Types:** `pnpm exec tsc --noEmit` — confirms `RecentChat` threads `page.tsx → HomeHub → RecentChatsPanel`, the `conversationId` destructure, and the new query/route compile.
3. **Build:** `pnpm build` (standard Next build; does not run migrations).
4. **Manual (signed in, ≥1 conversation):** load `/` → "שיחות אחרונות" appears **under** "רעיונות לשיחה" (right column on desktop; stacked below the prompts on mobile); only the newest **5** show; long Hebrew titles truncate to one line and are right-aligned; a **blue dot at the right (start)** on chats not yet viewed; **click a row → `/chat?cid=` opens** and hydrates; return to `/` → that chat's dot is **gone**; send a message in the home Thread → its row highlights (`bg-muted`) once it's in the snapshot and shows no dot.
5. **Deploy:** push to `main`; Coolify rebuilds and `prisma migrate deploy` applies the new table.

## Side fix — empty placeholder conversations

**Issue:** `src/app/api/chat/new-session/route.ts` creates a `Conversation` row (no messages, no title) **every time `/chat` is opened without a `cid`**. The recent-chats query already **excludes** these from the list (the `messages: { some: {} }` filter in §2 — otherwise they'd show as a blank "שיחה חדשה" and push real chats out of the top 5), but they still **accumulate** in the DB — one row per bare `/chat` visit that never sends a message.

**Recommended (minimal) — prune stale empties on new-session.** In `new-session`, after creating the conversation, delete the user's *older* empty conversations:
```ts
await db.conversation.deleteMany({
  where: {
    userId,
    messages: { none: {} },
    id: { not: conversationId },
    createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // >1 day old
  },
});
```
The age guard prevents deleting a placeholder a concurrent tab just created (whose `cid` is live in that tab's URL → its first message would 404). `ConversationView` rows cascade-delete via the FK. Bounds growth to ~a day of unused placeholders.

**Cleaner alternative (bigger) — make `/chat` lazy.** Drop the `new-session` call and let the first message create the conversation, exactly as the home Thread already does via `/api/chat` with no `conversationId`. `/chat` with no `cid` renders an empty Thread; on the first send the runtime returns the new `conversationId` and the page `router.replace`s to `/chat?cid=<id>`. Eliminates placeholders at the source and removes a round-trip, but changes the `/chat` bootstrap + URL flow — defer unless we also want to retire `new-session`.

## Notes / open questions for review
- "Unread" in a synchronous single-user chat mainly means **"updated since you last opened it"** (e.g. created/continued on another device) — a useful affordance, not a notification system. Is the DB-backed `ConversationView` worth it vs. a lighter client-only marker? (Decision so far: DB-backed.)
- A just-created conversation won't appear in the (server-snapshot) list until the next full page load; acceptable for v1 (could be optimistically prepended client-side later).
- Dot color is `bg-blue-500` per the spec; `bg-primary` (emerald) would be more on-brand — flag a preference.
- Separate `ConversationView` table vs. a `lastViewedAt` column on `Conversation` (the column would need a raw-SQL write to dodge the `@updatedAt` auto-bump). The separate table is the recommended approach here.
