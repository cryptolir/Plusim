import FacebookPage from "./FacebookPage";

export const metadata = { title: "קהילה" };

// Community tab = the Plusim Facebook page, embedded via the official Page Plugin
// (see FacebookPage.tsx for why the iframe build over the SDK).
export default function CommunityPage() {
  return (
    <main className="flex h-full flex-col">
      <header className="shrink-0 px-4 pb-2 pt-4 text-center">
        <h1 className="font-heading text-2xl tracking-tight">קהילה</h1>
        <p className="text-sm text-muted-foreground">עמוד הפייסבוק של פלוסים</p>
      </header>
      <div className="min-h-0 flex-1 px-2 pb-4">
        <FacebookPage />
      </div>
    </main>
  );
}
