"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DriveEntry } from "@/lib/googleDrive";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

function isTranscriptLike(e: DriveEntry): boolean {
  return e.mimeType === GOOGLE_DOC_MIME || e.mimeType.startsWith("text/");
}
function isEditable(e: DriveEntry): boolean {
  return e.mimeType.startsWith("text/"); // plain text can be overwritten; Google Docs cannot
}
function isSummary(e: DriveEntry): boolean {
  return e.appProperties?.havayaSummary === "true";
}

export function DriveBrowser({ entries, driveToken }: { entries: DriveEntry[]; driveToken: string }) {
  const folders = entries.filter((e) => e.isFolder);
  const files = entries.filter((e) => !e.isFolder);

  return (
    <div className="space-y-4">
      {folders.length > 0 && (
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Folders</h2>
          <ul className="divide-y rounded-xl border">
            {folders.map((f) => (
              <li key={f.id}>
                <Link
                  href={`/admin/drive?folderId=${encodeURIComponent(f.id)}`}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                >
                  <span aria-hidden>📁</span>
                  <span className="font-medium">{f.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</h2>
        {files.length === 0 ? (
          <p className="rounded-xl border p-3 text-sm text-muted-foreground">No files in this folder.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {files.map((f) => (
              <FileRow key={f.id} file={f} driveToken={driveToken} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface Preview {
  title: string;
  date: string;
  summary: string;
  truncated: boolean;
  alreadyExists: { name: string } | null;
}

function FileRow({ file, driveToken }: { file: DriveEntry; driveToken: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const summary = isSummary(file);
  const canSummarize = isTranscriptLike(file) && !summary;
  const auth = { "x-admin-save-token": driveToken };

  async function viewText() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/admin/api/drive/file-text?fileId=${encodeURIComponent(file.id)}`, { headers: auth });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setText(typeof data.text === "string" ? data.text : "");
      else setStatus(`Could not load: ${data.error ?? res.status}`);
    } catch (e) {
      setStatus(`Could not load: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveText() {
    if (text === null) return;
    setBusy(true);
    setStatus("Saving changes…");
    try {
      const res = await fetch(`/admin/api/drive/file-text`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ fileId: file.id, text }),
      });
      const data = await res.json().catch(() => ({}));
      setStatus(res.ok ? "Saved ✓" : `Save failed: ${data.error ?? res.status}`);
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Move "${file.name}" to Google Drive trash?`)) return;
    setBusy(true);
    setStatus("Deleting…");
    try {
      const res = await fetch(`/admin/api/drive/file?fileId=${encodeURIComponent(file.id)}`, {
        method: "DELETE",
        headers: auth,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) router.refresh();
      else setStatus(`Delete failed: ${data.error ?? res.status}`);
    } catch (e) {
      setStatus(`Delete failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function summarize() {
    setBusy(true);
    setStatus("Summarizing… this can take 1–3 minutes.");
    setPreview(null);
    try {
      const res = await fetch(`/admin/api/drive/summarize`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ fileId: file.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus(null);
        setPreview({
          title: data.title ?? "",
          date: data.date ?? "",
          summary: data.summary ?? "",
          truncated: Boolean(data.truncated),
          alreadyExists: data.alreadyExists ? { name: data.alreadyExists.name } : null,
        });
      } else {
        setStatus(`Failed: ${data.error ?? res.status}`);
      }
    } catch (e) {
      setStatus(`Failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!preview) return;
    setBusy(true);
    setStatus("Saving…");
    try {
      const res = await fetch(`/admin/api/drive/save-summary`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ fileId: file.id, title: preview.title, date: preview.date, summary: preview.summary }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPreview(null);
        setStatus(`Saved: ${data.file?.name ?? "summary"}`);
        router.refresh();
      } else {
        setStatus(`Save failed: ${data.error ?? res.status}`);
      }
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden>{summary ? "📝" : "📄"}</span>
        <span className="font-medium" dir="auto">
          {file.name}
        </span>
        {summary && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">summary</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {isTranscriptLike(file) && (
            <button
              onClick={viewText}
              disabled={busy}
              className="rounded-full border px-3 py-1 text-xs transition-colors hover:bg-muted disabled:opacity-50"
            >
              View / edit
            </button>
          )}
          {canSummarize && (
            <button
              onClick={summarize}
              disabled={busy}
              className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
            >
              {preview ? "Re-summarize" : "Summarize"}
            </button>
          )}
          <button
            onClick={remove}
            disabled={busy}
            className="rounded-full border border-red-200 px-3 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
          >
            Delete
          </button>
        </span>
      </div>

      {status && <p className="mt-1 text-xs text-muted-foreground">{status}</p>}

      {preview && (
        <div className="mt-2 space-y-2 rounded-lg border bg-muted/20 p-3">
          {preview.alreadyExists && (
            <p className="text-xs text-amber-700">
              A summary already exists for this file ({preview.alreadyExists.name}). Saving creates another.
            </p>
          )}
          {preview.truncated && (
            <p className="text-xs text-amber-700">Transcript was long and got truncated before summarizing.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <label className="flex-1 text-xs text-muted-foreground">
              Title
              <input
                value={preview.title}
                onChange={(e) => setPreview({ ...preview, title: e.target.value })}
                dir="auto"
                className="mt-0.5 w-full rounded-md border px-2 py-1 text-sm text-foreground"
              />
            </label>
            <label className="w-40 text-xs text-muted-foreground">
              Date
              <input
                value={preview.date}
                onChange={(e) => setPreview({ ...preview, date: e.target.value })}
                className="mt-0.5 w-full rounded-md border px-2 py-1 text-sm text-foreground"
              />
            </label>
          </div>
          <textarea
            value={preview.summary}
            onChange={(e) => setPreview({ ...preview, summary: e.target.value })}
            dir="auto"
            className="h-56 w-full rounded-md border p-2 text-sm leading-relaxed text-foreground"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="rounded-full bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
            >
              Save to folder
            </button>
            <button
              onClick={() => {
                setPreview(null);
                setStatus(null);
              }}
              disabled={busy}
              className="rounded-full border px-4 py-1.5 text-xs transition-colors hover:bg-muted disabled:opacity-50"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {text !== null && (
        <div className="mt-2 space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            dir="auto"
            spellCheck={false}
            className="h-72 w-full rounded-lg border bg-muted/20 p-2 font-mono text-xs leading-relaxed text-foreground"
          />
          <div className="flex items-center gap-2">
            {isEditable(file) && (
              <button
                onClick={saveText}
                disabled={busy}
                className="rounded-full bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
              >
                Save changes
              </button>
            )}
            <button
              onClick={() => {
                setText(null);
                setStatus(null);
              }}
              disabled={busy}
              className="rounded-full border px-4 py-1.5 text-xs transition-colors hover:bg-muted disabled:opacity-50"
            >
              Close
            </button>
            {!isEditable(file) && <span className="text-xs text-muted-foreground">(read-only — Google Doc)</span>}
          </div>
        </div>
      )}
    </li>
  );
}
