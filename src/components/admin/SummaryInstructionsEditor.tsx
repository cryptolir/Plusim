"use client";
import { useState } from "react";

export function SummaryInstructionsEditor({
  initial,
  defaultText,
  usingDefault,
  saveToken,
}: {
  initial: string;
  defaultText: string;
  usingDefault: boolean;
  saveToken: string;
}) {
  const [text, setText] = useState(initial);
  const [status, setStatus] = useState<string | null>(
    usingDefault ? "Currently using the built-in default." : null,
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setStatus("Saving…");
    try {
      const res = await fetch("/admin/api/settings/summary-instructions", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-admin-save-token": saveToken },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus(text.trim() ? "Saved ✓" : "Cleared — using the built-in default.");
      } else {
        setStatus(`Save failed: ${data.error ?? res.status}`);
      }
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        dir="auto"
        placeholder={defaultText}
        className="h-[58vh] w-full rounded-xl border p-3 text-sm leading-relaxed"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() => setText(defaultText)}
          disabled={saving}
          className="rounded-full border px-4 py-2 text-sm transition-colors hover:bg-muted disabled:opacity-50"
        >
          Load default
        </button>
        {text.trim() && (
          <button
            onClick={() => setText("")}
            disabled={saving}
            className="text-xs text-red-600 underline disabled:opacity-50"
          >
            Clear (revert to default)
          </button>
        )}
        {status && <span className="text-sm text-muted-foreground">{status}</span>}
      </div>
    </div>
  );
}
