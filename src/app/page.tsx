import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { auth, currentUser } from "@clerk/nextjs/server";
import { SproutIcon } from "lucide-react";
import { HomeHub } from "@/components/home/HomeHub";
import { getUserSection, seedAppProfileNameIfMissing } from "@/lib/agentglob";
import { parsePrompts, parseAppProfileName } from "@/lib/agentContent";
import { db } from "@/lib/db";
import { isDriveConnected, listSummaries } from "@/lib/googleDrive";

export default async function Home() {
  const { userId } = await auth();

  // Signed-out: simple landing with sign-in / sign-up.
  if (!userId) {
    return (
      <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-6 p-8">
        <span className="flex size-16 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-lg shadow-emerald-600/20">
          <SproutIcon className="size-8" aria-hidden />
        </span>
        <h1 className="font-heading text-5xl tracking-tight">Plusim</h1>
        <p className="max-w-sm text-center text-lg text-muted-foreground">
          המלווה הפיננסי שלך לתכנון, להחלטות ולהכוונה — בכל רגע.
        </p>
        <div className="flex items-center gap-3">
          <SignInButton>
            <button className="min-h-11 rounded-full border border-border bg-card px-6 py-2.5 text-sm font-medium transition-colors hover:bg-muted">
              התחברות
            </button>
          </SignInButton>
          <SignUpButton>
            <button className="min-h-11 rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground shadow-md shadow-emerald-600/25 transition-colors hover:bg-emerald-700">
              בואו נתחיל
            </button>
          </SignUpButton>
        </div>
      </main>
    );
  }

  // Signed-in: the hub. Content fetched server-side. The per-user sections
  // (User_D_Prompt, app_note) come from the user's agent-workspace file via an
  // app-key-scoped read; they return null until the AgentGlob user-file API
  // ships (Phase 2) → graceful empty states. See AGENTGLOB_USER_FILE_API.md.
  const [user, promptSection, noteSection, appProfileSection, recentRows] = await Promise.all([
    currentUser(),
    getUserSection(userId, "User_D_Prompt"),
    getUserSection(userId, "app_note"),
    // Read uncached: the seed below writes the name server-side and we want the
    // next load to read it immediately, not after the 60s section cache.
    getUserSection(userId, "app_profile", { noStore: true, timeoutMs: 2500 }),
    // Recent chats for the home-hub "שיחות אחרונות" panel (top 5 by recency).
    db.conversation.findMany({
      // `messages: { some: {} }` excludes empty placeholder conversations that
      // /api/chat/new-session creates on a bare /chat visit (no message sent yet),
      // which would otherwise show as "שיחה חדשה" and push real chats out of the top 5.
      where: { userId, messages: { some: {} } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: {
        id: true,
        title: true,
        sectionContext: true,
        updatedAt: true,
        view: { select: { lastViewedAt: true } },
      },
    }),
  ]);
  // Compute the "unread" flag server-side (no view row, or updated since last
  // view) and serialize the date so it crosses cleanly into the client component.
  const recentChats = recentRows.map((c) => ({
    id: c.id,
    title: c.title,
    sectionContext: c.sectionContext,
    updatedAt: c.updatedAt.toISOString(),
    unread: !c.view || c.updatedAt.getTime() > c.view.lastViewedAt.getTime(),
  }));
  // Greeting name: prefer the per-user file's app_profile name. Seed it from the
  // Clerk first name on first contact (best-effort, current-Clerk-user only), and
  // fall back to the Clerk first name transiently until the file is seeded. Plain
  // "שלום!" when neither exists.
  const clerkFirst = user?.firstName?.trim() || null;
  const fileName = parseAppProfileName(appProfileSection);
  if (!fileName && clerkFirst) {
    await seedAppProfileNameIfMissing(clerkFirst);
  }
  const firstName = fileName ?? clerkFirst;

  // "Past meeting" pin: shown when the user's assigned Drive folder holds
  // summaries. Guarded so a Drive outage never breaks the home page.
  let pastMeeting = false;
  try {
    const folder = await db.userDriveFolder.findUnique({ where: { userId } });
    if (folder && (await isDriveConnected())) {
      pastMeeting = (await listSummaries(folder.folderId)).length > 0;
    }
  } catch {
    pastMeeting = false;
  }

  return (
    <HomeHub
      prompts={parsePrompts(promptSection)}
      note={noteSection}
      pastMeeting={pastMeeting}
      firstName={firstName}
      recentChats={recentChats}
    />
  );
}
