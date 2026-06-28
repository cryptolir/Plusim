import { FileTextIcon } from "lucide-react";

// ponytail: placeholder — real report content is coded later.
export default function ReportPage() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <FileTextIcon className="size-7" aria-hidden />
      </span>
      <h1 className="font-heading text-3xl tracking-tight">דוח</h1>
      <p className="max-w-sm text-muted-foreground">בקרוב.</p>
    </main>
  );
}
