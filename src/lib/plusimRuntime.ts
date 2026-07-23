"use client";
import { useState, useCallback, useRef } from "react";
import {
  useExternalStoreRuntime,
  WebSpeechDictationAdapter,
  type AppendMessage,
} from "@assistant-ui/react";
import { CHAT_CLIENT_TIMEOUT_MS } from "@/lib/chatTimeouts";
import {
  initialPickupState,
  pollOutcome,
  type PickupRow,
} from "@/lib/pendingReplyPickup";

const dictationAdapter = new WebSpeechDictationAdapter();

// How often the bounded pickup re-checks history for the pending reply (ms).
const PICKUP_POLL_INTERVAL_MS = 5_000;
// Per-fetch bound on any single history request inside the pickup, so a hung
// request can never pin the spinner past the window.
const PICKUP_FETCH_TIMEOUT_MS = 10_000;

interface LocalMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

interface UsePlusimRuntimeOptions {
  initialConversationId?: string | null;
  sectionContext?: string | null;
}

function extractText(message: AppendMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

interface HistoryRow {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

export function usePlusimRuntime(opts: UsePlusimRuntimeOptions = {}) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(
    opts.initialConversationId ?? null
  );
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const sectionContextRef = useRef<string | null>(opts.sectionContext ?? null);
  const conversationIdRef = useRef<string | null>(opts.initialConversationId ?? null);

  // Shared cancel/generation guard for EVERY history fetch — the initial `?cid`
  // hydrate, the pickup interval polls, and the final deadline fetch (Rev 20/23).
  // Bumping the generation invalidates any in-flight or already-scheduled history
  // work: a response that resolves after a cancel/new send is ignored by
  // generation, so no stale history can wholesale-`hydrate` over a started turn.
  const pickupGenRef = useRef(0);
  const pickupAbortRef = useRef<AbortController | null>(null);
  const pickupTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Keep refs in sync so callbacks always see latest values.
  sectionContextRef.current = opts.sectionContext ?? null;

  const hydrate = useCallback((rows: HistoryRow[], cid: string) => {
    conversationIdRef.current = cid;
    setConversationId(cid);
    setMessages(
      rows.map((r) => ({
        id: r.id,
        role: r.role === "user" ? "user" : "assistant",
        content: r.content,
        createdAt: new Date(r.createdAt),
      }))
    );
  }, []);

  // End any active pickup and invalidate every in-flight/scheduled history fetch.
  // Called by `onCancel` (Stop) and at the top of `sendMessage` (a new send owns
  // the transcript). Clears the pickup spinner but not a send that is starting —
  // `sendMessage` sets `isRunning` true again right after calling this.
  const cancelPickup = useCallback(() => {
    pickupGenRef.current += 1;
    pickupAbortRef.current?.abort();
    pickupAbortRef.current = null;
    pickupTimersRef.current.forEach((t) => clearTimeout(t));
    pickupTimersRef.current = [];
    setIsRunning(false);
  }, []);

  const sendMessage = useCallback(async (text: string, sectionContextOverride?: string | null) => {
    if (!text.trim()) return;

    // A new send owns the transcript: stop any pending-reply pickup and
    // invalidate its fetches BEFORE the optimistic append, so a late history
    // response can't clobber this turn.
    cancelPickup();

    const userMessage: LocalMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;
    // Client abort must outlast the server's agent ceiling + un-abortable
    // pre/post-agent work (A2), or a reply produced near the ceiling is
    // discarded before its JSON arrives. Shared constant so the two can't drift.
    const timeoutId = setTimeout(() => controller.abort(), CHAT_CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          message: text,
          sectionContext: sectionContextOverride ?? sectionContextRef.current,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // The API's error strings are developer-facing English; surface a
        // Hebrew message to the user instead.
        const errorText =
          res.status === 429
            ? "הגעתם לקצב ההודעות המרבי. נסו שוב בעוד רגע."
            : "משהו השתבש. נסו שוב.";
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: errorText,
            createdAt: new Date(),
          },
        ]);
        return;
      }

      const data = await res.json();
      if (data.conversationId && data.conversationId !== conversationIdRef.current) {
        conversationIdRef.current = data.conversationId;
        setConversationId(data.conversationId);
      }

      setMessages((prev) => [
        ...prev,
        {
          id: data.assistantMessage.id,
          role: "assistant",
          content: data.assistantMessage.content,
          createdAt: new Date(data.assistantMessage.createdAt),
        },
      ]);
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          // A3 (replaces the cut refetch): the reply is saved server-side even
          // when we stop waiting, so point the user at the conversation rather
          // than implying the answer was lost.
          content: isAbort
            ? "הפסקנו להמתין לתשובה. אם היא כבר מוכנה, היא תופיע בשיחה ברשימת השיחות האחרונות."
            : "שגיאת תקשורת. נסו שוב.",
          createdAt: new Date(),
        },
      ]);
    } finally {
      clearTimeout(timeoutId);
      abortRef.current = null;
      setIsRunning(false);
    }
  }, [cancelPickup]);

  // One bounded history fetch under the shared abort/generation guard. Resolves
  // to the parsed rows (or null if the response is stale/failed/superseded).
  const fetchHistory = useCallback(
    async (cid: string, gen: number, controller: AbortController): Promise<HistoryRow[] | null> => {
      const timer = setTimeout(() => controller.abort(), PICKUP_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`/api/chat/history?conversationId=${cid}`, {
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        // Ignore a response that a cancel/new send has superseded.
        if (gen !== pickupGenRef.current) return null;
        return (data.messages ?? []) as HistoryRow[];
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    []
  );

  // The pickup loop is held in a ref (reassigned each render to close over the
  // latest fetch/hydrate) so `loadHistory` can call it with no declaration-order
  // or circular-dependency issue. Declared before `loadHistory` references it.
  const startPickupRef = useRef<
    (cid: string, pendingId: string, pendingCreatedAtMs: number, remainingMs: number, gen: number) => void
  >(() => {});

  // Load an existing conversation on a `?cid` open: hydrate its history, then —
  // if the last row is a lone pending turn still inside its bounded window —
  // start the pickup poll. Every fetch here shares the generation guard, so a
  // send fired before this settles cannot be clobbered. Never rejects; resolves
  // when the initial hydrate settles (the page flips the send gate then).
  const loadHistory = useCallback(
    async (cid: string): Promise<void> => {
      const gen = ++pickupGenRef.current;
      const controller = new AbortController();
      pickupAbortRef.current = controller;

      let serverNowMs = Date.now();
      let rows: HistoryRow[] | null = null;
      const timer = setTimeout(() => controller.abort(), PICKUP_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`/api/chat/history?conversationId=${cid}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (gen !== pickupGenRef.current) return; // superseded by a send/cancel
          rows = (data.messages ?? []) as HistoryRow[];
          if (data.serverNow) serverNowMs = new Date(data.serverNow).getTime();
        }
      } catch {
        return; // network/abort — page still enables the composer
      } finally {
        clearTimeout(timer);
      }

      if (!rows) return;
      hydrate(rows, cid);

      const decision = initialPickupState(rows as PickupRow[], serverNowMs, CHAT_CLIENT_TIMEOUT_MS);
      if (!decision.pending || !decision.pendingId || decision.remainingMs == null) return;
      // startPickupRef is a stable ref reassigned each render to close over the
      // latest fetch/hydrate, so it needs no dependency here.
      startPickupRef.current(cid, decision.pendingId, decision.pendingCreatedAtMs!, decision.remainingMs, gen);
    },
    [hydrate]
  );

  startPickupRef.current = (cid, pendingId, pendingCreatedAtMs, remainingMs, gen) => {
    setIsRunning(true);
    // `stopped` ends this pickup instance's polling without touching the shared
    // generation (which cancelPickup owns). The generation check still guards
    // cross-instance races (a new send/cancel); `stopped` guards within-instance
    // (the deadline stops the poll from rescheduling).
    let stopped = false;
    const clearTimers = () => {
      pickupTimersRef.current.forEach((t) => clearTimeout(t));
      pickupTimersRef.current = [];
    };
    const isCurrent = () => !stopped && gen === pickupGenRef.current;

    const poll = async () => {
      if (!isCurrent()) return;
      const controller = new AbortController();
      pickupAbortRef.current = controller;
      const rows = await fetchHistory(cid, gen, controller);
      if (!isCurrent()) return;
      if (rows) {
        const outcome = pollOutcome(rows as PickupRow[], pendingId, pendingCreatedAtMs);
        if (outcome === "complete") {
          hydrate(rows, cid);
          stopped = true;
          setIsRunning(false);
          clearTimers();
          return;
        }
        if (outcome === "stop") {
          // Silent fall-back to the already-hydrated transcript (ambiguous).
          stopped = true;
          setIsRunning(false);
          clearTimers();
          return;
        }
      }
      // keep-polling (or a transient failed fetch) → schedule the next tick.
      pickupTimersRef.current.push(setTimeout(poll, PICKUP_POLL_INTERVAL_MS));
    };

    // First poll after one interval; the deadline bounds the whole thing.
    pickupTimersRef.current.push(setTimeout(poll, PICKUP_POLL_INTERVAL_MS));
    pickupTimersRef.current.push(
      setTimeout(async () => {
        if (!isCurrent()) return;
        // Spinner is bounded: clear `isRunning` AT the deadline regardless of the
        // final fetch, and stop the poll from rescheduling. The final fetch below
        // is separate — its result STILL hydrates a last-interval reply if it
        // returns before its own per-fetch bound (Rev 4).
        stopped = true;
        setIsRunning(false);
        clearTimers();
        const controller = new AbortController();
        pickupAbortRef.current = controller;
        const rows = await fetchHistory(cid, gen, controller);
        if (gen !== pickupGenRef.current || !rows) return;
        if (pollOutcome(rows as PickupRow[], pendingId, pendingCreatedAtMs) === "complete") {
          hydrate(rows, cid);
        }
      }, remainingMs)
    );
  };

  const onNew = useCallback(
    async (msg: AppendMessage) => {
      await sendMessage(extractText(msg));
    },
    [sendMessage]
  );

  const onCancel = useCallback(async () => {
    abortRef.current?.abort();
    cancelPickup();
  }, [cancelPickup]);

  const runtime = useExternalStoreRuntime<LocalMessage>({
    isRunning,
    messages,
    onNew,
    onCancel,
    convertMessage: (m) => ({
      role: m.role,
      content: m.content,
      id: m.id,
      createdAt: m.createdAt,
    }),
    adapters: {
      dictation: dictationAdapter,
    },
  });

  const reset = useCallback(() => {
    cancelPickup();
    conversationIdRef.current = null;
    setMessages([]);
    setConversationId(null);
    setIsRunning(false);
    abortRef.current?.abort();
  }, [cancelPickup]);

  return { runtime, hydrate, loadHistory, reset, sendMessage, cancelPickup, conversationId, isRunning };
}
