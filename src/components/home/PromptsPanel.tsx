"use client";
import { HistoryIcon, LightbulbIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Formal note cards: straight (no tilt), soft pastel fill with a colored
// start-edge accent, cycled by index.
const NOTE_STYLES = [
  "bg-amber-50 border-amber-200 border-s-amber-400 text-amber-950",
  "bg-emerald-50 border-emerald-200 border-s-emerald-400 text-emerald-950",
  "bg-sky-50 border-sky-200 border-s-sky-400 text-sky-950",
  "bg-rose-50 border-rose-200 border-s-rose-400 text-rose-950",
];

// A pinned, dynamically-sourced prompt (e.g. "Past meeting") whose visible label
// differs from the message sent on click, and which carries a sectionContext so
// the server can inject hidden context (the meeting summary) on the first turn.
export interface PinnedPrompt {
  label: string;
  message: string;
  sectionContext: string;
}

// Clickable prompts sourced from the agent workspace (User_D_Prompt section).
// Clicking a prompt sends it straight into the chat. Renders nothing until
// prompts or a pinned card exist.
export function PromptsPanel({
  prompts,
  onPick,
  disabled,
  pinned,
}: {
  prompts: string[];
  onPick: (text: string, sectionContext?: string) => void;
  disabled?: boolean;
  pinned?: PinnedPrompt | null;
}) {
  if (!prompts.length && !pinned) return null;

  return (
    <aside className="w-full">
      <h2 className="mb-2 flex items-center gap-1.5 px-1 text-sm font-semibold text-muted-foreground">
        <LightbulbIcon className="size-4 text-primary" aria-hidden />
        רעיונות לשיחה
      </h2>
      <div className="flex gap-3 overflow-x-auto px-1 pb-2 lg:flex-col lg:overflow-visible">
        {pinned && (
          <button
            type="button"
            dir="auto"
            disabled={disabled}
            onClick={() => onPick(pinned.message, pinned.sectionContext)}
            className="flex min-h-11 w-56 shrink-0 items-center gap-2 rounded-xl border border-s-4 border-primary/30 border-s-primary bg-primary/10 px-4 py-3 text-start text-sm font-medium leading-snug text-primary shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50 lg:w-full"
          >
            <HistoryIcon className="size-4 shrink-0" aria-hidden />
            {pinned.label}
          </button>
        )}
        {prompts.map((prompt, i) => (
          <button
            key={i}
            type="button"
            dir="auto"
            disabled={disabled}
            onClick={() => onPick(prompt)}
            className={cn(
              "min-h-11 w-56 shrink-0 rounded-xl border border-s-4 px-4 py-3 text-start text-sm leading-snug shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50 lg:w-full",
              NOTE_STYLES[i % NOTE_STYLES.length],
            )}
          >
            {prompt}
          </button>
        ))}
      </div>
    </aside>
  );
}
