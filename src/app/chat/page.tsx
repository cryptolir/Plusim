"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { usePlusimRuntime } from "@/lib/plusimRuntime";
import { NEW_SESSION_TIMEOUT_MS } from "@/lib/chatTimeouts";

function ChatInner() {
  const sp = useSearchParams();

  // Captured ONCE at mount, before any URL edit strips them (the seeded fallback
  // relies on this — it clears the params synchronously but must still send the
  // seed and its section context).
  const seed = sp.get("p") ?? "";
  const ctx = sp.get("ctx");
  const autosend = sp.get("autosend") === "1";
  const cidParam = sp.get("cid");

  const { runtime, hydrate, loadHistory, sendMessage, conversationId } = usePlusimRuntime({
    initialConversationId: cidParam,
    sectionContext: ctx,
  });

  // Gate the send surface until this load's initial data settles. On a `?cid`
  // open the view renders immediately (Rev 17) but SEND waits for the initial
  // history hydrate (P1e); on a bare load the whole surface waits for the minted
  // id (P1c). `?cid` still needs the gate because, before hydrate lands, the
  // empty thread would render welcome suggestions — a live send path.
  const [sendReady, setSendReady] = useState(false);

  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    if (cidParam) {
      // Existing conversation: load history (hydrate + maybe start the bounded
      // pending-reply pickup) under the runtime's shared generation guard, then
      // enable sends. `loadHistory` never rejects.
      loadHistory(cidParam).finally(() => setSendReady(true));
      // Clear the "new activity" dot for this conversation in the recent list.
      void fetch("/api/chat/mark-viewed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: cidParam }),
      }).catch(() => {});
      return;
    }

    // Bare `/chat` load: mint the conversation server-side, then wire the id into
    // the runtime and the URL BEFORE any seeded send. The fetch is bounded so a
    // hung `new-session` falls into the fallback instead of pinning the gate.
    const doAutosend = Boolean(seed) && autosend;
    const enterFallback = () => {
      // new-session failed (reject / non-OK / missing id / hung): enable the
      // surface and let the first send lazy-create via /api/chat. Strip the seed
      // params synchronously even without a `cid` so a refresh can't replay the
      // seed, and still fire the seeded send (carrying `ctx`) so the click isn't
      // dropped.
      if (seed) window.history.replaceState(null, "", "/chat");
      setSendReady(true);
      if (doAutosend) void sendMessage(seed, ctx);
    };

    fetch("/api/chat/new-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sectionContext: ctx }),
      signal: AbortSignal.timeout(NEW_SESSION_TIMEOUT_MS),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("new-session failed"))))
      .then((data) => {
        if (!data.conversationId) {
          enterFallback();
          return;
        }
        // Wire the minted id into the runtime (the double-conversation fix), then
        // commit the `?cid` URL SYNCHRONOUSLY with native history (Next 16 writes
        // router.replace on a later transition, so a refresh right after the send
        // starts could still see ?p=…&autosend=1 and replay the seed).
        hydrate([], data.conversationId);
        window.history.replaceState(null, "", `/chat?cid=${data.conversationId}`);
        setSendReady(true);
        if (doAutosend) void sendMessage(seed);
      })
      .catch(enterFallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fallback URL sync: when the lazy-create send returns an id (no `new-session`
  // ran, so nothing set the URL), commit `?cid` with native history so a refresh
  // resumes the thread. No-op on the normal path (URL already carries the cid).
  useEffect(() => {
    if (!conversationId) return;
    const current = new URL(window.location.href).searchParams.get("cid");
    if (current === conversationId) return;
    window.history.replaceState(null, "", `/chat?cid=${conversationId}`);
  }, [conversationId]);

  return (
    <div className="flex flex-col h-full">
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread sendEnabled={sendReady} />
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
