"use client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { usePlusimRuntime } from "@/lib/plusimRuntime";
import { PromptsPanel, type PinnedPrompt } from "@/components/home/PromptsPanel";
import { RecentChatsPanel, type RecentChat } from "@/components/home/RecentChatsPanel";
import { OwnerNote } from "@/components/home/OwnerNote";

// Pinned "Past meeting" card. The visible label + sent message are Hebrew; the
// server injects the latest meeting summary as hidden context for `past_meeting`.
const PAST_MEETING_PINNED: PinnedPrompt = {
  label: "פגישה קודמת",
  message: "אשמח לחזור אל הפגישה הקודמת שלנו ולהמשיך משם.",
  sectionContext: "past_meeting",
};

export function HomeHub({
  prompts,
  note,
  pastMeeting,
  firstName,
  recentChats,
}: {
  prompts: string[];
  note: string | null;
  pastMeeting?: boolean;
  firstName?: string | null;
  recentChats: RecentChat[];
}) {
  // Lazy chat: no conversation is created until the first message is sent
  // (from a prompt click or the composer). Shares the same runtime that the
  // standalone /chat route uses. `conversationId` drives the selected-row state.
  const { runtime, sendMessage, isRunning, conversationId } = usePlusimRuntime({});
  const hasSidebar = prompts.length > 0 || Boolean(pastMeeting) || recentChats.length > 0;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex min-h-[100dvh] flex-col pb-6">
        <OwnerNote markdown={note} />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-3 py-3 lg:flex-row-reverse lg:items-stretch lg:gap-5 lg:px-4">
          <section className="h-[58vh] w-full overflow-hidden rounded-3xl border bg-card shadow-sm lg:h-[74vh] lg:flex-1">
            <Thread firstName={firstName} />
          </section>
          {hasSidebar && (
            <div className="flex w-full shrink-0 flex-col gap-4 lg:w-72">
              <PromptsPanel
                prompts={prompts}
                onPick={sendMessage}
                disabled={isRunning}
                pinned={pastMeeting ? PAST_MEETING_PINNED : null}
              />
              <RecentChatsPanel chats={recentChats} activeConversationId={conversationId} />
            </div>
          )}
        </main>

      </div>
    </AssistantRuntimeProvider>
  );
}
