import { FileTextIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getMergedTaxonomy } from "@/lib/reportCategories";

export const dynamic = "force-dynamic";

function shekel(agorot: number): string {
  return (agorot / 100).toLocaleString("he-IL", { style: "currency", currency: "ILS" });
}

/** Hebrew month title from "2026-06". */
function monthTitle(month: string): string {
  const NAMES = [
    "ינואר",
    "פברואר",
    "מרץ",
    "אפריל",
    "מאי",
    "יוני",
    "יולי",
    "אוגוסט",
    "ספטמבר",
    "אוקטובר",
    "נובמבר",
    "דצמבר",
  ];
  const [y, m] = month.split("-").map(Number);
  return `${NAMES[(m ?? 1) - 1]} ${y}`;
}

export default async function ReportPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  // Merged (base ∪ admin-added) taxonomy, so DB-category spend renders under
  // its section instead of being dropped by the by-leaf bucketing below.
  const taxonomy = await getMergedTaxonomy();

  const jobs = await db.reportJob.findMany({
    where: { targetUserId: userId, status: "published" },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      title: true,
      sheetUrl: true,
      publishedAt: true,
      transactions: {
        select: {
          month: true,
          merchant: true,
          date: true,
          amountAgorot: true,
          category: true,
          uncategorized: true,
        },
      },
      artifacts: { select: { id: true }, take: 1 },
    },
  });

  if (jobs.length === 0) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <FileTextIcon className="size-7" aria-hidden />
        </span>
        <h1 className="font-heading text-3xl tracking-tight">דוח</h1>
        <p className="max-w-sm text-muted-foreground">אין עדיין דוחות. דוחות שיפורסמו עבורך יופיעו כאן.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-4 pb-24" dir="rtl">
      <h1 className="font-heading text-3xl tracking-tight">דוחות</h1>
      {jobs.map((job) => {
        // month → leaf → sum, from the stored transaction rows.
        const months = new Map<string, Map<string, number>>();
        const uncat: { month: string; date: string; merchant: string; amountAgorot: number }[] = [];
        for (const t of job.transactions) {
          if (t.uncategorized) {
            uncat.push({ month: t.month, date: t.date, merchant: t.merchant, amountAgorot: t.amountAgorot });
            continue;
          }
          const byLeaf = months.get(t.month) ?? new Map<string, number>();
          byLeaf.set(t.category ?? "", (byLeaf.get(t.category ?? "") ?? 0) + t.amountAgorot);
          months.set(t.month, byLeaf);
        }
        const monthKeys = [...months.keys()].sort();

        return (
          <section key={job.id} className="space-y-4 rounded-2xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-semibold" dir="auto">
                {job.title || "דוח הוצאות"}
              </h2>
              <span className="flex items-center gap-3 text-sm">
                {job.artifacts[0] && (
                  <a
                    href={`/api/reports/${job.id}/download`}
                    className="flex min-h-11 items-center gap-1 rounded-lg border px-3 text-foreground"
                  >
                    <DownloadIcon className="size-4" aria-hidden /> קובץ Excel
                  </a>
                )}
                {job.sheetUrl && (
                  <a
                    href={job.sheetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-11 items-center gap-1 rounded-lg border px-3 text-foreground"
                  >
                    <ExternalLinkIcon className="size-4" aria-hidden /> Google Sheets
                  </a>
                )}
              </span>
            </div>

            {monthKeys.map((month) => {
              const byLeaf = months.get(month)!;
              let grand = 0;
              for (const v of byLeaf.values()) grand += v;
              return (
                <div key={month} className="overflow-x-auto rounded-xl border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 text-right">
                        <th className="px-3 py-2 font-semibold" colSpan={2}>
                          חודש {monthTitle(month)}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {taxonomy.map((section) => {
                        const rows = section.leaves
                          .map((leaf) => ({ leaf, sum: byLeaf.get(leaf) ?? 0 }))
                          .filter((r) => r.sum !== 0);
                        if (rows.length === 0) return null;
                        const secSum = rows.reduce((a, r) => a + r.sum, 0);
                        return (
                          <FragmentRows key={section.section} section={section.section} secSum={secSum} rows={rows} />
                        );
                      })}
                      <tr className="border-t bg-amber-50 font-semibold">
                        <td className="px-3 py-2">סה&quot;כ החודש</td>
                        <td className="px-3 py-2 whitespace-nowrap">{shekel(grand)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })}

            {uncat.length > 0 && (
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 text-right">
                      <th className="px-3 py-2 font-semibold" colSpan={3}>
                        ללא סיווג ({uncat.length})
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {uncat.map((t, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-1.5 whitespace-nowrap">{t.date}</td>
                        <td className="px-3 py-1.5" dir="auto">
                          {t.merchant}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{shekel(t.amountAgorot)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}

function FragmentRows({
  section,
  secSum,
  rows,
}: {
  section: string;
  secSum: number;
  rows: { leaf: string; sum: number }[];
}) {
  return (
    <>
      <tr className="border-t bg-blue-50/60 font-semibold">
        <td className="px-3 py-1.5">{section}</td>
        <td className="px-3 py-1.5 whitespace-nowrap">{shekel(secSum)}</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.leaf} className="border-t">
          <td className="px-3 py-1.5 pr-6">{r.leaf}</td>
          <td className="px-3 py-1.5 whitespace-nowrap">{shekel(r.sum)}</td>
        </tr>
      ))}
    </>
  );
}
