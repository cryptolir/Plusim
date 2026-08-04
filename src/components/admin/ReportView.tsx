"use client";

/**
 * The online report — the published workbook as a live page.
 *
 * Tabs mirror the workbook sheets (ניתוח תוצאות / התפלגות ההוצאות / פירוט
 * תנועות / un_categorized). Every total is clickable: it opens a side panel
 * with the exact transactions behind it, which can be copied out as TSV
 * (paste-ready into Excel or WhatsApp).
 *
 * All numbers arrive precomputed from src/lib/reportAnalysis.ts; this file only
 * renders and filters — no second source of truth for any sum.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  shekel,
  monthShort,
  monthTitle,
  installmentInfo,
  DISTRIBUTION_EXCLUDED_LEAVES,
  type Analysis,
  type AnalysisTxn,
} from "@/lib/reportAnalysis";

/** "8/12" chip for an installment row — display-only, read from the note. */
function InstallmentBadge({ note }: { note: string | null | undefined }) {
  const inst = installmentInfo(note);
  if (!inst) return null;
  return (
    <span
      className="ms-1 whitespace-nowrap rounded bg-muted px-1 text-[0.7rem] text-muted-foreground"
      title={note ?? undefined}
    >
      🔁 {inst.n}/{inst.of}
    </span>
  );
}

type Tab = "matrix" | "distribution" | "transactions" | "uncategorized";

const TABS: { id: Tab; label: string }[] = [
  { id: "matrix", label: "ניתוח תוצאות" },
  { id: "distribution", label: "התפלגות ההוצאות" },
  { id: "transactions", label: "פירוט תנועות" },
  { id: "uncategorized", label: "ללא סיווג" },
];

/** Brand chart tokens, cycled at two weights so 10 sections stay distinguishable. */
const SLICE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
function sliceColor(i: number): string {
  return SLICE_COLORS[i % SLICE_COLORS.length];
}
function sliceOpacity(i: number): number {
  return i < SLICE_COLORS.length ? 1 : 0.55;
}

interface Drill {
  title: string;
  rows: AnalysisTxn[];
  /** Set for an all-months drill, so the panel can show the average that was clicked. */
  monthsAveraged?: number;
}

export function ReportView({
  job,
  analysis,
  transactions,
}: {
  job: { id: string; title: string; user: string; publishedAt: string | null; sheetUrl: string | null };
  analysis: Analysis;
  transactions: AnalysisTxn[];
}) {
  const [tab, setTab] = useState<Tab>("matrix");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drill, setDrill] = useState<Drill | null>(null);
  const [search, setSearch] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);

  const { months, sections, monthTotals, grandTotal, avgPerMonth, distribution } = analysis;
  // A section keeps its leaves whenever any transaction lands in it, so an
  // empty `leaves` means a row of dashes — hidden unless asked for.
  const emptyCount = sections.filter((s) => s.leaves.length === 0).length;
  const visibleSections = showEmpty ? sections : sections.filter((s) => s.leaves.length > 0);

  function toggle(section: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(section)) next.add(section);
      return next;
    });
  }

  /** Rows behind a cell: one leaf or a whole section, one month or all of them. */
  function openDrill(label: string, leaves: string[], month: string | null) {
    const leafSet = new Set(leaves);
    const rows = transactions
      .filter((t) => !t.uncategorized && t.category !== null && leafSet.has(t.category))
      .filter((t) => (month === null ? true : t.month === month))
      .sort((a, b) => a.date.localeCompare(b.date));
    setDrill({
      title: month ? `${label} · ${monthTitle(month)}` : `${label} · כל החודשים`,
      rows,
      monthsAveraged: month ? undefined : months.length,
    });
  }

  const filteredTxns = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = [...transactions].sort((a, b) => b.date.localeCompare(a.date));
    if (!q) return rows;
    return rows.filter((t) =>
      [t.merchant, t.category ?? "", t.sourceLabel, t.note ?? "", t.date].join(" ").toLowerCase().includes(q),
    );
  }, [transactions, search]);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl tracking-tight" dir="auto">
              {job.title}
            </h1>
            <p className="text-sm text-muted-foreground">
              {job.user}
              {job.publishedAt && <> · פורסם ב-{job.publishedAt}</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {job.sheetUrl && (
              <a
                href={job.sheetUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border px-3 py-1 transition-colors hover:bg-muted"
              >
                Google Sheet ↗
              </a>
            )}
            <a
              href={`/admin/reports/${job.id}`}
              className="rounded-full border px-3 py-1 transition-colors hover:bg-muted"
            >
              עבודת הדוח
            </a>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label='סה"כ מסווג' value={shekel(grandTotal)} />
          <Stat label="ממוצע חודשי" value={shekel(Math.round(avgPerMonth))} />
          <Stat label="חודשים" value={String(months.length)} />
          <Stat
            label="ללא סיווג"
            value={String(analysis.uncategorized.length)}
            sub={analysis.uncategorized.length > 0 ? shekel(analysis.uncategorizedTotal) : undefined}
            tone={analysis.uncategorized.length > 0 ? "warn" : undefined}
          />
        </div>

        <nav className="flex flex-wrap gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === t.id
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {t.id === "uncategorized" && analysis.uncategorized.length > 0 && (
                <span className="ms-1 rounded-full bg-accent px-1.5 text-xs text-accent-foreground">
                  {analysis.uncategorized.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      {months.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          אין תנועות בדוח הזה.
        </p>
      ) : tab === "matrix" ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              לחיצה על סכום פותחת את התנועות שמרכיבות אותו. לחיצה על שם מדור פותחת את הקטגוריות שבו.
            </p>
            <span className="flex shrink-0 items-center gap-2">
              {emptyCount > 0 && (
                <button
                  onClick={() => setShowEmpty((v) => !v)}
                  className="rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted"
                >
                  {showEmpty ? "הסתרת מדורים ריקים" : `הצגת מדורים ריקים (${emptyCount})`}
                </button>
              )}
              <CopyButton label="העתקת הטבלה" text={() => matrixTsv(analysis)} />
            </span>
          </div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="sticky start-0 z-10 bg-muted px-3 py-2 text-start font-medium">קטגוריה</th>
                  {months.map((m) => (
                    <th key={m} className="px-1.5 py-2 text-start font-medium whitespace-nowrap">
                      {monthShort(m)}
                    </th>
                  ))}
                  <th className="px-1.5 py-2 text-start font-medium whitespace-nowrap">ממוצע</th>
                  <th className="px-1.5 py-2 text-start font-medium whitespace-nowrap">סה&quot;כ</th>
                </tr>
              </thead>
              <tbody>
                {visibleSections.map((s) => (
                  <SectionRows
                    key={s.section}
                    section={s}
                    months={months}
                    expanded={open.has(s.section)}
                    onToggle={() => toggle(s.section)}
                    onCell={openDrill}
                  />
                ))}
                <tr className="border-t-2 bg-accent/40 font-semibold">
                  <td className="sticky start-0 z-10 bg-accent px-3 py-2 whitespace-nowrap">סה&quot;כ החודש</td>
                  {monthTotals.map((v, i) => (
                    <td key={i} className="px-1.5 py-2 tabular-nums whitespace-nowrap">
                      {shekel(v)}
                    </td>
                  ))}
                  <td className="px-1.5 py-2 tabular-nums whitespace-nowrap">{shekel(Math.round(avgPerMonth))}</td>
                  <td className="px-1.5 py-2 tabular-nums whitespace-nowrap">{shekel(grandTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : tab === "distribution" ? (
        <section className="space-y-4">
          <div className="flex flex-col items-center gap-6 rounded-xl border p-4 sm:flex-row sm:items-start">
            <Donut slices={distribution} />
            <ul className="w-full space-y-1">
              {distribution.map((d, i) => (
                <li key={d.section}>
                  <button
                    onClick={() =>
                      // The slice excludes the business/tax leaves, so its
                      // breakdown must too — otherwise the panel total would
                      // not add up to the number that was clicked.
                      openDrill(
                        d.section,
                        (sections.find((s) => s.section === d.section)?.leaves ?? [])
                          .map((l) => l.leaf)
                          .filter((leaf) => !DISTRIBUTION_EXCLUDED_LEAVES.includes(leaf)),
                        null,
                      )
                    }
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-muted"
                  >
                    <span
                      className="size-3 shrink-0 rounded-sm"
                      style={{ background: sliceColor(i), opacity: sliceOpacity(i) }}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{d.section}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {(d.share * 100).toFixed(1)}%
                    </span>
                    <span className="w-28 text-end tabular-nums whitespace-nowrap">{shekel(Math.round(d.amount))}</span>
                  </button>
                </li>
              ))}
              {distribution.length === 0 && (
                <li className="p-2 text-sm text-muted-foreground">אין הוצאות להתפלגות.</li>
              )}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            הסכומים הם ממוצע חודשי, כמו בגיליון. עסק, מע&quot;מ, מס הכנסה וביטוח לאומי אינם נכללים
            בהתפלגות
            {analysis.distributionExcludedAvg !== 0 && (
              <> (ממוצע חודשי של {shekel(Math.round(analysis.distributionExcludedAvg))})</>
            )}
            .
          </p>
          <CopyButton label="העתקת ההתפלגות" text={() => distributionTsv(analysis)} />
        </section>
      ) : tab === "transactions" ? (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="חיפוש בבית עסק, קטגוריה, מקור או הערה…"
              className="min-h-11 w-full max-w-sm rounded-lg border bg-background px-3 text-sm"
              dir="auto"
            />
            <span className="text-sm text-muted-foreground">{filteredTxns.length} תנועות</span>
            <CopyButton label="העתקת התנועות" text={() => txnsTsv(filteredTxns)} />
          </div>
          <TxnTable rows={filteredTxns} showCategory />
        </section>
      ) : (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              תנועות שהסוכן לא סיווג ({shekel(analysis.uncategorizedTotal)} בסך הכול, לא נכללות
              בטבלאות). אפשר לסווג אותן בעמוד עבודת הדוח.
            </p>
            <CopyButton label="העתקה" text={() => txnsTsv(analysis.uncategorized)} />
          </div>
          {analysis.uncategorized.length === 0 ? (
            <p className="rounded-xl border p-6 text-center text-muted-foreground">
              כל התנועות סווגו ✓
            </p>
          ) : (
            <TxnTable rows={analysis.uncategorized} />
          )}
        </section>
      )}

      {drill && <DrillPanel drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "warn";
}) {
  return (
    <div className={`rounded-xl border p-3 ${tone === "warn" ? "border-accent bg-accent/30" : ""}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs tabular-nums text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SectionRows({
  section,
  months,
  expanded,
  onToggle,
  onCell,
}: {
  section: Analysis["sections"][number];
  months: string[];
  expanded: boolean;
  onToggle: () => void;
  onCell: (label: string, leaves: string[], month: string | null) => void;
}) {
  const leaves = section.leaves.map((l) => l.leaf);
  const empty = section.leaves.length === 0;
  const rowCount = section.countByMonth.reduce((a, b) => a + b, 0);
  return (
    <>
      <tr className="border-t bg-secondary/40 font-medium">
        <td className="sticky start-0 z-10 bg-secondary px-3 py-2 whitespace-nowrap">
          <button
            onClick={onToggle}
            disabled={empty}
            className="flex items-center gap-1 disabled:opacity-60"
            aria-expanded={expanded}
          >
            <span className="inline-block w-3 text-muted-foreground">{empty ? "" : expanded ? "−" : "+"}</span>
            {section.section}
          </button>
        </td>
        {section.byMonth.map((v, i) => (
          <Cell
            key={i}
            value={v}
            count={section.countByMonth[i]}
            onClick={() => onCell(section.section, leaves, months[i])}
          />
        ))}
        <Cell value={Math.round(section.avg)} count={rowCount} onClick={() => onCell(section.section, leaves, null)} />
        <Cell value={section.total} count={rowCount} onClick={() => onCell(section.section, leaves, null)} />
      </tr>
      {expanded &&
        section.leaves.map((l) => (
          <tr key={l.leaf} className="border-t text-muted-foreground">
            <td className="sticky start-0 z-10 bg-background px-3 py-1.5 ps-8 whitespace-nowrap" dir="auto">
              {l.leaf}
            </td>
            {l.byMonth.map((v, i) => (
              <Cell
                key={i}
                value={v}
                count={l.countByMonth[i]}
                onClick={() => onCell(l.leaf, [l.leaf], months[i])}
              />
            ))}
            <Cell
              value={Math.round(l.avg)}
              count={l.countByMonth.reduce((a, b) => a + b, 0)}
              onClick={() => onCell(l.leaf, [l.leaf], null)}
            />
            <Cell
              value={l.total}
              count={l.countByMonth.reduce((a, b) => a + b, 0)}
              onClick={() => onCell(l.leaf, [l.leaf], null)}
            />
          </tr>
        ))}
    </>
  );
}

/** A number cell — clickable whenever transactions sit behind it, even at ₪0.00. */
function Cell({ value, count, onClick }: { value: number; count: number; onClick: () => void }) {
  if (count === 0) {
    return <td className="px-1.5 py-1.5 text-muted-foreground/50">—</td>;
  }
  return (
    <td className="px-1 py-1.5">
      <button
        onClick={onClick}
        className="w-full rounded px-1 py-0.5 text-start tabular-nums whitespace-nowrap underline decoration-dotted underline-offset-4 transition-colors hover:bg-muted"
      >
        {shekel(value)}
      </button>
    </td>
  );
}

function Donut({ slices }: { slices: Analysis["distribution"] }) {
  const R = 60;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 160 160" className="size-40 shrink-0 -rotate-90" role="img" aria-label="התפלגות ההוצאות">
      <circle cx="80" cy="80" r={R} fill="none" stroke="var(--muted)" strokeWidth="24" />
      {slices.map((s, i) => {
        const len = s.share * C;
        const el = (
          <circle
            key={s.section}
            cx="80"
            cy="80"
            r={R}
            fill="none"
            stroke={sliceColor(i)}
            strokeOpacity={sliceOpacity(i)}
            strokeWidth="24"
            strokeDasharray={`${len} ${C - len}`}
            strokeDashoffset={-offset}
          />
        );
        offset += len;
        return el;
      })}
    </svg>
  );
}

function TxnTable({ rows, showCategory = false }: { rows: AnalysisTxn[]; showCategory?: boolean }) {
  return (
    <div className="max-h-[36rem] overflow-auto rounded-xl border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted">
          <tr>
            <th className="px-3 py-2 text-start font-medium">תאריך</th>
            <th className="px-3 py-2 text-start font-medium">בית עסק</th>
            <th className="px-3 py-2 text-start font-medium">סכום</th>
            {showCategory && <th className="px-3 py-2 text-start font-medium">קטגוריה</th>}
            <th className="px-3 py-2 text-start font-medium">מקור</th>
            <th className="px-3 py-2 text-start font-medium">הערה</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-t">
              <td className="px-3 py-1.5 whitespace-nowrap">{t.date}</td>
              <td className="px-3 py-1.5" dir="auto">
                {t.merchant}
                <InstallmentBadge note={t.note} />
              </td>
              <td className="px-3 py-1.5 tabular-nums whitespace-nowrap">{shekel(t.amountAgorot)}</td>
              {showCategory && (
                <td className="px-3 py-1.5" dir="auto">
                  {t.uncategorized ? "— ללא סיווג —" : t.category}
                </td>
              )}
              <td className="px-3 py-1.5" dir="auto">
                {t.sourceLabel}
              </td>
              <td className="px-3 py-1.5 text-muted-foreground" dir="auto">
                {t.note}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DrillPanel({ drill, onClose }: { drill: Drill; onClose: () => void }) {
  const total = drill.rows.reduce((a, t) => a + t.amountAgorot, 0);

  // Base UI Dialog gives focus trap, scroll lock, Escape and aria wiring; only
  // the placement is overridden, from centred modal to a full-height side sheet.
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        dir="rtl"
        className="top-0 bottom-0 left-0 flex h-auto w-full max-w-xl translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-s bg-background p-0 sm:max-w-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <DialogTitle className="font-heading text-lg" dir="auto">
              {drill.title}
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {drill.rows.length} תנועות · {shekel(total)}
              {drill.monthsAveraged !== undefined && drill.monthsAveraged > 0 && (
                <> · ממוצע חודשי {shekel(Math.round(total / drill.monthsAveraged))}</>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <CopyButton label="העתקת הפירוט" text={() => txnsTsv(drill.rows, total)} />
            <button
              onClick={onClose}
              className="rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted"
            >
              סגירה
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {drill.rows.length === 0 ? (
            <p className="p-4 text-center text-muted-foreground">אין תנועות.</p>
          ) : (
            <ul>
              {drill.rows.map((t) => (
                <li key={t.id} className="border-b px-4 py-2.5 last:border-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate font-medium" dir="auto" title={t.merchant}>
                      {t.merchant}
                      <InstallmentBadge note={t.note} />
                    </span>
                    <span className="shrink-0 tabular-nums whitespace-nowrap">{shekel(t.amountAgorot)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span className="tabular-nums">{t.date}</span>
                    <span>·</span>
                    <span dir="auto">{t.uncategorized ? "ללא סיווג" : t.category}</span>
                    <span>·</span>
                    <span dir="auto">{t.sourceLabel}</span>
                  </div>
                  {t.note && (
                    <p className="mt-1 text-xs text-muted-foreground/80" dir="auto">
                      {t.note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Copies to the clipboard and says so for two seconds. */
function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setState("ok");
        } catch {
          setState("fail");
        }
      }}
      className="shrink-0 rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted"
    >
      {state === "ok" ? "הועתק ✓" : state === "fail" ? "ההעתקה נכשלה" : label}
    </button>
  );
}

/** Tab-separated, so a paste into Excel/Sheets lands in columns. A tab or a
 *  newline inside any value would shift every column after it, so each cell is
 *  flattened to single spaces on the way out. */
function cell(v: string | number): string {
  return String(v).replace(/[\t\r\n]+/g, " ");
}
function tsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(cell).join("\t")).join("\n");
}

function amount(agorot: number): string {
  return (agorot / 100).toFixed(2);
}

function txnsTsv(rows: AnalysisTxn[], total?: number): string {
  const body: (string | number)[][] = [
    ["תאריך", "בית עסק", "סכום", "קטגוריה", "מקור", "הערה"],
    ...rows.map((t) => [
      t.date,
      t.merchant,
      amount(t.amountAgorot),
      t.uncategorized ? "ללא סיווג" : (t.category ?? ""),
      t.sourceLabel,
      t.note ?? "",
    ]),
  ];
  if (total !== undefined) body.push([`סה"כ`, "", amount(total), "", "", ""]);
  return tsv(body);
}

function matrixTsv(a: Analysis): string {
  const head = ["קטגוריה", ...a.months.map(monthTitle), "ממוצע", 'סה"כ'];
  const rows: (string | number)[][] = [head];
  for (const s of a.sections) {
    rows.push([s.section, ...s.byMonth.map(amount), amount(Math.round(s.avg)), amount(s.total)]);
    for (const l of s.leaves) {
      rows.push([`  ${l.leaf}`, ...l.byMonth.map(amount), amount(Math.round(l.avg)), amount(l.total)]);
    }
  }
  rows.push([
    'סה"כ החודש',
    ...a.monthTotals.map(amount),
    amount(Math.round(a.avgPerMonth)),
    amount(a.grandTotal),
  ]);
  return tsv(rows);
}

function distributionTsv(a: Analysis): string {
  return tsv([
    ["מדור", "ממוצע חודשי", "אחוז"],
    ...a.distribution.map((d) => [d.section, amount(Math.round(d.amount)), `${(d.share * 100).toFixed(1)}%`]),
  ]);
}
