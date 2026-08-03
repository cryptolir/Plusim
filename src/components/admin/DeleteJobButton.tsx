"use client";

/** Delete an entire report job (files/transactions/artifacts cascade in the DB). */
import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteJobButton({
  jobId,
  saveToken,
  label,
}: {
  jobId: string;
  saveToken: string;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm(`למחוק לצמיתות את הדוח "${label}"? כל הקבצים והעסקאות שלו יימחקו.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/admin/api/reports/${jobId}`, {
        method: "DELETE",
        headers: { "x-admin-save-token": saveToken },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `המחיקה נכשלה (${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <button
        onClick={remove}
        disabled={busy}
        className="rounded-full border px-3 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
      >
        {busy ? "מוחק…" : "מחיקה"}
      </button>
      {error && (
        <span className="max-w-56 text-xs text-red-600" title={error}>
          {error}
        </span>
      )}
    </span>
  );
}
