"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function DriveFolderPicker({
  userId,
  folders,
  currentFolderId,
  saveToken,
}: {
  userId: string;
  folders: { id: string; name: string }[];
  currentFolderId: string | null;
  saveToken: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(folderId: string | null) {
    setSaving(true);
    setStatus(null);
    try {
      const folderName = folders.find((f) => f.id === folderId)?.name ?? null;
      const res = await fetch(`/admin/api/users/${encodeURIComponent(userId)}/drive`, {
        method: folderId ? "PUT" : "DELETE",
        headers: { "content-type": "application/json", "x-admin-save-token": saveToken },
        body: folderId ? JSON.stringify({ folderId, folderName }) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus(folderId ? "Assigned ✓" : "Unassigned ✓");
        router.refresh();
      } else if (res.status === 401) {
        setStatus("Authorization expired — reload the page and try again.");
      } else if (res.status === 403) {
        setStatus("Not allowed — the folder must be under the transcripts root.");
      } else {
        setStatus(`Failed: ${data.error ?? res.status}`);
      }
    } catch (e) {
      setStatus(`Failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {folders.length === 0 ? (
        <p className="text-sm text-muted-foreground">No subfolders found under the transcripts root.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {folders.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <span aria-hidden>📁</span>
                <span className="font-medium" dir="auto">
                  {f.name}
                </span>
                {currentFolderId === f.id && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">current</span>
                )}
              </span>
              <button
                onClick={() => save(f.id)}
                disabled={saving || currentFolderId === f.id}
                className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
              >
                {currentFolderId === f.id ? "Assigned" : "Assign"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {currentFolderId && (
        <button
          onClick={() => save(null)}
          disabled={saving}
          className="text-xs text-red-600 underline disabled:opacity-50"
        >
          Unassign folder
        </button>
      )}
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
