"use client";
import Link from "next/link";
import { cn } from "@/lib/utils";

// One row of the home-hub "שיחות אחרונות" list. `unread` is computed server-side
// (no view row, or the chat was updated since it was last opened); `updatedAt` is
// an ISO string so it crosses the server→client boundary cleanly.
export interface RecentChat {
  id: string;
  title: string | null;
  sectionContext: string | null;
  updatedAt: string;
  unread: boolean;
}

// Hebrew fallback labels for conversations that have no title yet.
const SECTION_LABELS: Record<string, string> = {
  past_meeting: "פגישה קודמת",
};

function labelFor(chat: RecentChat): string {
  const title = chat.title?.trim();
  if (title) return title;
  if (chat.sectionContext && SECTION_LABELS[chat.sectionContext]) {
    return SECTION_LABELS[chat.sectionContext];
  }
  return "שיחה חדשה";
}

// ChatGPT-style recent-conversations list shown under "רעיונות לשיחה". Top 5 rows,
// the active conversation highlighted, an unread dot at the RTL leading (start =
// right) edge. Hidden entirely when the user has no conversations.
export function RecentChatsPanel({
  chats,
  activeConversationId,
}: {
  chats: RecentChat[];
  activeConversationId: string | null;
}) {
  if (chats.length === 0) return null;

  return (
    <aside className="w-full">
      <h2 className="mb-2 px-1 text-sm font-bold text-foreground">שיחות אחרונות</h2>
      <ul className="flex flex-col gap-0.5">
        {chats.map((chat) => {
          const isActive = chat.id === activeConversationId;
          const showDot = chat.unread && !isActive;
          return (
            <li key={chat.id}>
              <Link
                href={`/chat?cid=${chat.id}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {/* Always-rendered fixed slot so rows align with or without a dot. */}
                <span className="flex size-2 shrink-0 items-center justify-center">
                  {showDot && (
                    <span className="size-2 rounded-full bg-blue-500" aria-label="חדש" />
                  )}
                </span>
                <span dir="auto" className="line-clamp-1 flex-1 text-start">
                  {labelFor(chat)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
