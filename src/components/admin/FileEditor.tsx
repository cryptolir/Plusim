"use client";
import { useState } from "react";

export function FileEditor({
  userId,
  initialContent,
  etag,
  exists,
  saveToken,
}: {
  userId: string;
  initialContent: string;
  etag: string;
  exists: boolean;
  saveToken: string;
}) {
  const [content, setContent] = useState(initialContent);
  const [curEtag, setCurEtag] = useState(etag);
  const [status, setStatus] = useState<string | null>(
    exists ? null : "הקובץ הזה עדיין לא קיים — שמירה תיצור אותו.",
  );
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(force = false) {
    setSaving(true);
    setStatus(null);
    setConflict(false);
    try {
      // Auth rides on the server-minted save token (see lib/adminSaveToken.ts)
      // instead of the Clerk session cookie, which goes stale between page load
      // and save on the current test-mode Clerk instance.
      const res = await fetch(`/admin/api/users/${encodeURIComponent(userId)}/file`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-admin-save-token": saveToken,
        },
        body: JSON.stringify({ content, etag: curEtag, force }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCurEtag(typeof data.etag === "string" ? data.etag : curEtag);
        setStatus("נשמר ✓");
      } else if (res.status === 409) {
        setConflict(true);
        setStatus(
          "הקובץ הזה השתנה מאז שפתחתם אותו. טענו מחדש כדי לקבל את הגרסה העדכנית, או בצעו שמירה בכפייה כדי לדרוס אותה.",
        );
      } else if (res.status === 401) {
        setStatus("הרשאת השמירה פגה — טענו מחדש את הדף ונסו לשמור שוב.");
      } else if (res.status === 403) {
        setStatus("החשבון הזה לא ברשימת המנהלים (ADMIN_EMAILS) — התחברו עם חשבון מנהל.");
      } else {
        setStatus(`השמירה נכשלה: ${data.error ?? res.status}`);
      }
    } catch (e) {
      setStatus(`השמירה נכשלה: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        dir="auto"
        spellCheck={false}
        className="h-[60vh] w-full rounded-xl border p-3 font-mono text-sm"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => save(false)}
          disabled={saving}
          className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
        >
          {saving ? "שומר…" : "שמירה"}
        </button>
        {conflict && (
          <>
            <button
              onClick={() => window.location.reload()}
              className="rounded-full border px-4 py-2 text-sm transition-colors hover:bg-muted"
            >
              טעינת הגרסה העדכנית
            </button>
            <button
              onClick={() => save(true)}
              disabled={saving}
              className="rounded-full border border-red-300 px-4 py-2 text-sm text-red-600 transition-colors hover:bg-red-50"
            >
              שמירה בכפייה
            </button>
          </>
        )}
        {status && <span className="text-sm text-muted-foreground">{status}</span>}
      </div>
    </div>
  );
}
