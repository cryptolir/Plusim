"use client";
import { useState, useCallback, useRef } from "react";
import {
  useExternalStoreRuntime,
  WebSpeechDictationAdapter,
  type AppendMessage,
} from "@assistant-ui/react";
import { CHAT_CLIENT_TIMEOUT_MS } from "@/lib/chatTimeouts";

const dictationAdapter = new WebSpeechDictationAdapter();

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

  // Keep refs in sync so callbacks always see latest values.
  sectionContextRef.current = opts.sectionContext ?? null;

  const sendMessage = useCallback(async (text: string, sectionContextOverride?: string | null) => {
    if (!text.trim()) return;

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
  }, []);

  const onNew = useCallback(
    async (msg: AppendMessage) => {
      await sendMessage(extractText(msg));
    },
    [sendMessage]
  );

  const onCancel = useCallback(async () => {
    abortRef.current?.abort();
  }, []);

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

  const reset = useCallback(() => {
    conversationIdRef.current = null;
    setMessages([]);
    setConversationId(null);
    setIsRunning(false);
    abortRef.current?.abort();
  }, []);

  return { runtime, hydrate, reset, sendMessage, conversationId, isRunning };
}
