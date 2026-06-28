import { UsersIcon } from "lucide-react";

// ponytail: placeholder — real community content is coded later.
export default function CommunityPage() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <UsersIcon className="size-7" aria-hidden />
      </span>
      <h1 className="font-heading text-3xl tracking-tight">קהילה</h1>
      <p className="max-w-sm text-muted-foreground">בקרוב.</p>
    </main>
  );
}
