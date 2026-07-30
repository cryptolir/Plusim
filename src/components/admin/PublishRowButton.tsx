"use client";

/**
 * Publish shortcut inside the reports table — the same POST the job page makes,
 * so every publish guard (fatal verification, stale run, files added after the
 * last run) still applies and its Hebrew refusal is shown right in the row.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

export function PublishRowButton({
  jobId,
  saveToken,
  user,
}: {
  jobId: string;
  saveToken: string;
  user: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function publish() {
    // Publishing puts the report in front of the client — from a list of rows,
    // one stray click on the wrong line is easy, so the client is named first.
    if (!window.confirm(`לפרסם את הדוח ל${user}? הדוח יופיע ללקוח באפליקציה.`)) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/admin/api/reports/${jobId}/publish`, {
        method: "POST",
        headers: { "x-admin-save-token": saveToken },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `הפרסום נכשל (${res.status})`);
      // The publish can succeed while the Sheets export does not (Drive down,
      // no folder, stale link cleared). Silence would read as a clean publish.
      if (typeof data?.exportNote === "string") setNote(data.exportNote);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <button
        onClick={publish}
        disabled={busy}
        className="rounded-full border px-3 py-1 text-xs transition-colors hover:bg-muted disabled:opacity-50"
      >
        {busy ? "מפרסם…" : "פרסום"}
      </button>
      {error && (
        <span className="max-w-56 text-xs text-red-600" title={error}>
          {error}
        </span>
      )}
      {note && (
        <span className="max-w-56 text-xs text-amber-700" title={note}>
          פורסם, אך ייצוא הגיליון לא הושלם: {note}
        </span>
      )}
    </span>
  );
}
