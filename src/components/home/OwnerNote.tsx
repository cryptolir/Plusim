import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// App owner's short note, sourced from the agent workspace (app_note section).
// Hidden until the note exists.
export function OwnerNote({ markdown }: { markdown: string | null }) {
  if (!markdown) return null;

  return (
    <div
      className="border-b border-amber-200/70 bg-amber-50/80 px-4 py-2.5 text-center text-sm text-amber-950"
      dir="auto"
    >
      <div className="mx-auto max-w-3xl [&_a]:underline [&_p]:m-0">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}
