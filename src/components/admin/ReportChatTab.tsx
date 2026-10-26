"use client";
/**
 * The "שיחה עם הסוכן" tab of the admin online report
 * (docs/plans/report-adjust-chat.md C2): the app's own chat UI, pointed at the
 * job's admin chat route. The agent can change dates and categories only; the
 * page refreshes after every reply so the matrix, ledger and notes show it.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { usePlusimRuntime } from "@/lib/plusimRuntime";

export function ReportChatTab({ jobId, saveToken }: { jobId: string; saveToken: string }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const chatUrl = `/admin/api/reports/${jobId}/chat`;
  const headers = useMemo(() => ({ "x-admin-save-token": saveToken }), [saveToken]);

  const { runtime, loadHistory } = usePlusimRuntime({
    chatUrl,
    historyUrl: () => chatUrl,
    headers,
    showServerErrors: true,
    onReply: () => router.refresh(),
  });

  // The thread is per job (and per run); hydrate it once, then allow sending.
  useEffect(() => {
    loadHistory(jobId).finally(() => setReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per job
  }, [jobId]);

  return (
    <section className="space-y-2">
      <div className="h-[60vh] min-h-96 overflow-hidden rounded-xl border">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread
            sendEnabled={ready}
            showSuggestions={false}
            welcomeTitle="שיחה עם הסוכן על הדוח"
            welcomeSubtitle={
              'אפשר לבקש שינוי תאריך או קטגוריה. לדוגמה: "העבר את תשלום 2 של רמי לוי לחודש הבא", או "סווג את חברת חשמל לחשמל".'
            }
          />
        </AssistantRuntimeProvider>
      </div>
      <p className="text-sm text-muted-foreground">
        שינויים נשמרים מיד בדוח. גיליון Google יתעדכן בלחיצה על פרסום בעבודת הדוח.
      </p>
    </section>
  );
}
