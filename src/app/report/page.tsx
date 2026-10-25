import { FileTextIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getMergedTaxonomy } from "@/lib/reportCategories";
import {
  shekel,
  monthTitle,
  installmentInfo,
  buildAnalysis,
  matchTargets,
  suggestMatches,
  type PerSourceCycles,
} from "@/lib/reportAnalysis";
import { INCOME_SECTION } from "@/config/reportTaxonomy";
import { IncomeBlock } from "@/components/report/IncomeBlock";
import { SettlementMatchCard } from "@/components/report/SettlementMatchCard";

/** The verification's perSource list, or [] for a null / old-shape verification (fail closed). */
function perSourceOf(verification: unknown): PerSourceCycles[] {
  if (typeof verification !== "object" || verification === null) return [];
  const per = (verification as { perSource?: unknown }).perSource;
  return Array.isArray(per) ? (per as PerSourceCycles[]) : [];
}

/** The B2 note — the one line of the verification that names unmatched settlements. */
function noCyclesNote(verification: unknown): string | null {
  if (typeof verification !== "object" || verification === null) return null;
  const notes = (verification as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) return null;
  return (notes as unknown[]).find((n): n is string => typeof n === "string" && n.includes("ללא מחזור חיוב")) ?? null;
}

export const dynamic = "force-dynamic";

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
      verification: true,
      transactions: {
        select: {
          id: true,
          month: true,
          merchant: true,
          date: true,
          amountAgorot: true,
          category: true,
          uncategorized: true,
          sourceLabel: true,
          note: true,
          kind: true,
        },
      },
      settlements: {
        orderBy: [{ month: "asc" }, { date: "asc" }],
        select: { id: true, month: true, date: true, payee: true, amountAgorot: true, sourceLabel: true, matchedCycle: true },
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
        // month → leaf → sum, from the stored transaction rows. Income rows
        // (kind === "income") never enter the expense buckets — they feed the
        // income table below each month; uncategorized bank credits are listed
        // apart from uncategorized debits (docs/plans/bank-statements.md C2).
        const months = new Map<string, Map<string, number>>();
        type UncatRow = { month: string; date: string; merchant: string; amountAgorot: number; note: string | null };
        const uncat: UncatRow[] = [];
        const uncatCredits: UncatRow[] = [];
        for (const t of job.transactions) {
          if (t.uncategorized) {
            (t.kind === "credit" ? uncatCredits : uncat).push({
              month: t.month,
              date: t.date,
              merchant: t.merchant,
              amountAgorot: t.amountAgorot,
              note: t.note,
            });
            continue;
          }
          if (t.kind === "income") continue;
          const byLeaf = months.get(t.month) ?? new Map<string, number>();
          byLeaf.set(t.category ?? "", (byLeaf.get(t.category ?? "") ?? 0) + t.amountAgorot);
          months.set(t.month, byLeaf);
        }
        // Income and מצבנו come from the same builder the admin view uses, so
        // the two surfaces can never disagree on a figure.
        const analysis = buildAnalysis(job.transactions, taxonomy);
        const hasIncome = analysis.income.leaves.length > 0;
        for (const m of analysis.months) if (!months.has(m)) months.set(m, new Map());
        const monthKeys = [...months.keys()].sort();
        const expenseTaxonomy = taxonomy.filter((s) => s.section !== INCOME_SECTION);

        const perSource = perSourceOf(job.verification);
        const targets = matchTargets(perSource);
        const suggestions = Object.fromEntries(suggestMatches(job.settlements, perSource));

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
                      {expenseTaxonomy.map((section) => {
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
                  {(() => {
                    const mi = analysis.months.indexOf(month);
                    const income = mi >= 0 ? analysis.income.byMonth[mi] : 0;
                    return (
                      <IncomeBlock
                        className="border-t"
                        columns={[monthTitle(month)]}
                        leaves={analysis.income.leaves
                          .filter((l) => mi >= 0 && l.byMonth[mi] !== 0)
                          .map((l) => ({ leaf: l.leaf, byColumn: [l.byMonth[mi]] }))}
                        incomeByColumn={[income]}
                        expenseByColumn={[grand]}
                        showIncome={hasIncome}
                      />
                    );
                  })()}
                </div>
              );
            })}

            {job.settlements.length > 0 && (
              <SettlementMatchCard
                jobId={job.id}
                settlements={job.settlements}
                targets={targets}
                suggestions={suggestions}
                note={targets.length === 0 ? noCyclesNote(job.verification) : null}
              />
            )}

            {[
              { title: "ללא סיווג", rows: uncat },
              { title: "זיכויים ללא סיווג (הכנסה או החזר — טרם הוכרע)", rows: uncatCredits },
            ].map(({ title, rows }) =>
              rows.length === 0 ? null : (
              <div key={title} className="overflow-x-auto rounded-xl border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 text-right">
                      <th className="px-3 py-2 font-semibold" colSpan={3}>
                        {title} ({rows.length}) · {shekel(rows.reduce((a, t) => a + t.amountAgorot, 0))}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-1.5 whitespace-nowrap">{t.date}</td>
                        <td className="px-3 py-1.5" dir="auto">
                          {t.merchant}
                          {(() => {
                            const inst = installmentInfo(t.note);
                            return inst ? (
                              <span
                                className="ms-1 whitespace-nowrap rounded bg-muted px-1 text-[0.7rem] text-muted-foreground"
                                title={t.note ?? undefined}
                              >
                                🔁 {inst.n}/{inst.of}
                              </span>
                            ) : null;
                          })()}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{shekel(t.amountAgorot)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              ),
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
