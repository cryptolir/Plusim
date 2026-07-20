"use client";
import { useState } from "react";

/**
 * Generic admin setting editor — a textarea that PUTs to the allowlisted
 * `/admin/api/settings/[key]` route. Reused for every section on /admin/settings.
 * Pass `defaultText` for settings that have a built-in default (adds a "Load
 * default" button and the "using the built-in default" hint); omit it for
 * free-text settings that are simply blank when unset.
 */
export function SettingEditor({
  settingKey,
  initial,
  saveToken,
  defaultText,
  placeholder,
  heightClass = "h-48",
}: {
  settingKey: string;
  initial: string;
  saveToken: string;
  defaultText?: string;
  placeholder?: string;
  heightClass?: string;
}) {
  const [text, setText] = useState(initial);
  const usingDefault = Boolean(defaultText) && !initial.trim();
  const [status, setStatus] = useState<string | null>(
    usingDefault ? "כרגע נעשה שימוש בברירת המחדל המובנית." : null,
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setStatus("שומר…");
    try {
      const res = await fetch(`/admin/api/settings/${settingKey}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-admin-save-token": saveToken },
        body: JSON.stringify({ value: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus(
          text.trim()
            ? "נשמר ✓"
            : defaultText
              ? "נוקה — נעשה שימוש בברירת המחדל המובנית."
              : "נוקה.",
        );
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
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        dir="auto"
        placeholder={placeholder ?? defaultText}
        className={`${heightClass} w-full rounded-xl border p-3 text-sm leading-relaxed`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
        >
          {saving ? "שומר…" : "שמירה"}
        </button>
        {defaultText && (
          <button
            onClick={() => setText(defaultText)}
            disabled={saving}
            className="rounded-full border px-4 py-2 text-sm transition-colors hover:bg-muted disabled:opacity-50"
          >
            טעינת ברירת המחדל
          </button>
        )}
        {text.trim() && (
          <button
            onClick={() => setText("")}
            disabled={saving}
            className="text-xs text-red-600 underline disabled:opacity-50"
          >
            {defaultText ? "ניקוי (חזרה לברירת המחדל)" : "ניקוי"}
          </button>
        )}
        {status && <span className="text-sm text-muted-foreground">{status}</span>}
      </div>
    </div>
  );
}
