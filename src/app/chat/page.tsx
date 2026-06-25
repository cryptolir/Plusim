"use client";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { usePlusimRuntime } from "@/lib/plusimRuntime";

function ChatInner() {
  const sp = useSearchParams();
  const router = useRouter();

  const seed = sp.get("p") ?? "";
  const ctx = sp.get("ctx");
  const autosend = sp.get("autosend") === "1";
  const cidParam = sp.get("cid");

  const { runtime, hydrate, sendMessage } = usePlusimRuntime({
    initialConversationId: cidParam,
    sectionContext: ctx,
  });

  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    if (cidParam) {
      fetch(`/api/chat/history?conversationId=${cidParam}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.messages) hydrate(data.messages, cidParam);
        })
        .catch(console.error);
      // Clear the "new activity" dot for this conversation in the recent list.
      void fetch("/api/chat/mark-viewed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: cidParam }),
      }).catch(() => {});
      return;
    }

    fetch("/api/chat/new-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sectionContext: ctx }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data.conversationId) return;
        router.replace(`/chat?cid=${data.conversationId}`, { scroll: false });

        if (seed && autosend) {
          // Fire-and-forget — sendMessage handles state updates internally
          void sendMessage(seed);
        }
      })
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-[100dvh]">
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatInner />
    </Suspense>
  );
}
