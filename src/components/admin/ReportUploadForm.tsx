"use client";

/**
 * Admin upload form for statement files. POSTs multipart to /admin/api/reports
 * with the reports save token, then refreshes the page so the new job appears.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function ReportUploadForm({
  users,
  saveToken,
}: {
  users: { id: string; label: string }[];
  saveToken: string;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [targetUserId, setTargetUserId] = useState(users[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const files = fileInput.current?.files;
    if (!targetUserId) return setError("Pick a user.");
    if (!files || files.length === 0) return setError("Pick at least one statement file.");

    const form = new FormData();
    form.set("targetUserId", targetUserId);
    if (title.trim()) form.set("title", title.trim());
    for (const f of Array.from(files)) form.append("files", f);

    setBusy(true);
    try {
      const res = await fetch("/admin/api/reports", {
        method: "POST",
        headers: { "x-admin-save-token": saveToken },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `upload failed (${res.status})`);
      setTitle("");
      if (fileInput.current) fileInput.current.value = "";
      router.push(`/admin/reports/${data.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border p-4">
      <h2 className="font-medium">New report job</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Target user</span>
          <select
            value={targetUserId}
            onChange={(e) => setTargetUserId(e.target.value)}
            className="min-h-11 rounded-lg border bg-background px-2"
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Title (optional)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. דוח יוני 2026"
            className="min-h-11 rounded-lg border bg-background px-2"
            dir="auto"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Statements (.xlsx / .pdf)</span>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".xlsx,.pdf"
            className="min-h-11 rounded-lg border bg-background px-2 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-lg border bg-foreground px-4 text-background disabled:opacity-50"
        >
          {busy ? "Uploading…" : "Create job"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
