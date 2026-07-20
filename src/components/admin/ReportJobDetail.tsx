"use client";

/**
 * Admin job detail: status + actions (run / publish), verification panel,
 * transaction review (assign categories to uncategorized rows), and pending
 * merchant-mapping approvals. All calls carry the reports save token.
 */
import { useEffect, useState } from "react";
import { TAXONOMY_LEAVES } from "@/config/reportTaxonomy";

// Hebrew display labels for job.status (keys stay English — they are the status
// enum used in logic; only the rendered badge text is translated).
const STATUS_LABEL: Record<string, string> = {
  uploaded: "הועלה",
  dispatched: "נשלח לסוכן",
  processing: "בעיבוד",
  needs_review: "ממתין לבדיקה",
  completed: "הושלם",
  published: "פורסם",
  failed: "נכשל",
};

interface Txn {
  id: string;
  month: string;
  date: string;
  merchant: string;
  amountAgorot: number;
  category: string | null;
  uncategorized: boolean;
  sourceLabel: string;
  note: string | null;
}

interface JobDetail {
  id: string;
  targetUserId: string;
  createdBy: string;
  status: string;
  title: string | null;
  error: string | null;
  sheetUrl: string | null;
  verification: {
    problems?: string[];
    perSource?: { label: string; statementTotalAgorot: number | null; recomputedTotalAgorot: number; match: boolean }[];
    txCount?: number;
    uncategorizedCount?: number;
    agentNotes?: string | null;
  } | null;
  files: { id: string; filename: string; mime: string; size: number }[];
  artifacts: { id: string; filename: string }[];
  transactions: Txn[];
}

interface Mapping {
  id: string;
  merchantPattern: string;
  category: string;
  source: string;
}

function shekel(agorot: number): string {
  return (agorot / 100).toLocaleString("he-IL", { style: "currency", currency: "ILS" });
}

export function ReportJobDetail({ jobId, saveToken }: { jobId: string; saveToken: string }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const headers = { "x-admin-save-token": saveToken };

  // Initial load + a 10s poll so the agent callback landing shows up without
  // a manual refresh (admin page, single viewer — polling is fine).
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const res = await fetch(`/admin/api/reports/${jobId}`, {
        headers: { "x-admin-save-token": saveToken },
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        setError(data?.error ?? `הטעינה נכשלה (${res.status})`);
        return;
      }
      setJob(data.job);
      setMappings(data.pendingMappings ?? []);
    }
    void tick();
    const t = setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [jobId, saveToken, refreshKey]);

  const load = () => setRefreshKey((k) => k + 1);

  async function action(label: string, path: string, init?: RequestInit) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `${label} נכשל (${res.status})`);
      load();
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function assignCategory(txId: string, category: string, remember: boolean) {
    if (!category) return;
    await action("assign", `/admin/api/reports/${jobId}/transactions/${txId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category, rememberMerchant: remember }),
    });
  }

  if (error && !job) return <p className="text-red-600">{error}</p>;
  if (!job) return <p className="text-muted-foreground">טוען…</p>;

  const uncategorized = job.transactions.filter((t) => t.uncategorized);
  const v = job.verification;
  const running = ["dispatched", "processing"].includes(job.status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{job.title || `עבודה ${job.id.slice(0, 10)}`}</h1>
        <span className="rounded-full border px-2 py-0.5 text-xs">{STATUS_LABEL[job.status] ?? job.status}</span>
        {running && <span className="text-xs text-muted-foreground">הסוכן עובד… (מתרענן אוטומטית)</span>}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {job.error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{job.error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => action("run", `/admin/api/reports/${jobId}/run`, { method: "POST" })}
          disabled={busy !== null || job.status === "published"}
          className="min-h-11 rounded-lg border px-4 disabled:opacity-50"
        >
          {busy === "run" ? "שולח…" : job.status === "uploaded" ? "שליחה לסוכן" : "הרצה מחדש של הסוכן"}
        </button>
        <button
          onClick={() => action("publish", `/admin/api/reports/${jobId}/publish`, { method: "POST" })}
          disabled={busy !== null || !["completed", "needs_review", "published"].includes(job.status)}
          className="min-h-11 rounded-lg border bg-foreground px-4 text-background disabled:opacity-50"
          title={uncategorized.length > 0 ? `${uncategorized.length} שורות עדיין ללא סיווג` : undefined}
        >
          {busy === "publish" ? "מפרסם…" : job.status === "published" ? "פרסום מחדש" : "פרסום למשתמש"}
        </button>
        {job.sheetUrl && (
          <a href={job.sheetUrl} target="_blank" rel="noreferrer" className="min-h-11 rounded-lg border px-4 py-2 text-blue-600 underline">
            פתיחת Google Sheet
          </a>
        )}
      </div>

      <section className="rounded-xl border p-4">
        <h2 className="mb-2 font-medium">קובצי דפי חשבון</h2>
        <ul className="space-y-1 text-sm">
          {job.files.map((f) => (
            <li key={f.id} dir="auto">
              {f.filename} <span className="text-muted-foreground">({Math.round(f.size / 1024)} KB)</span>
            </li>
          ))}
        </ul>
      </section>

      {v && (
        <section className="rounded-xl border p-4">
          <h2 className="mb-2 font-medium">אימות</h2>
          <p className="text-sm text-muted-foreground">
            {v.txCount ?? 0} עסקאות · {v.uncategorizedCount ?? 0} ללא סיווג
          </p>
          {v.perSource && v.perSource.length > 0 && (
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">מקור</th>
                  <th className="py-1 pr-3 font-medium">סה&quot;כ בדף החשבון</th>
                  <th className="py-1 pr-3 font-medium">סה&quot;כ מחושב</th>
                  <th className="py-1 font-medium">התאמה</th>
                </tr>
              </thead>
              <tbody>
                {v.perSource.map((s) => (
                  <tr key={s.label} className="border-t">
                    <td className="py-1 pr-3" dir="auto">{s.label}</td>
                    <td className="py-1 pr-3">{s.statementTotalAgorot === null ? "—" : shekel(s.statementTotalAgorot)}</td>
                    <td className="py-1 pr-3">{shekel(s.recomputedTotalAgorot)}</td>
                    <td className="py-1">{s.match ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {v.problems && v.problems.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-sm text-orange-700">
              {v.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          {v.agentNotes && <p className="mt-2 text-sm text-muted-foreground" dir="auto">{v.agentNotes}</p>}
        </section>
      )}

      {uncategorized.length > 0 && (
        <section className="rounded-xl border p-4">
          <h2 className="mb-2 font-medium">ללא סיווג — הקצאת קטגוריות ({uncategorized.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">תאריך</th>
                  <th className="py-1 pr-3 font-medium">בית עסק</th>
                  <th className="py-1 pr-3 font-medium">סכום</th>
                  <th className="py-1 pr-3 font-medium">הערה</th>
                  <th className="py-1 font-medium">קטגוריה</th>
                </tr>
              </thead>
              <tbody>
                {uncategorized.map((t) => (
                  <UncatRow key={t.id} txn={t} onAssign={assignCategory} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {mappings.length > 0 && (
        <section className="rounded-xl border p-4">
          <h2 className="mb-2 font-medium">מיפויי בתי עסק מוצעים ({mappings.length})</h2>
          <ul className="space-y-2 text-sm">
            {mappings.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span dir="auto" className="font-medium">{m.merchantPattern}</span>
                <span className="text-muted-foreground">→</span>
                <span dir="auto">{m.category}</span>
                <span className="text-xs text-muted-foreground">({m.source})</span>
                <button
                  onClick={() =>
                    action("mapping", `/admin/api/report-mappings/${m.id}`, {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ approved: true }),
                    })
                  }
                  className="rounded border px-2 py-0.5 text-xs"
                >
                  אישור
                </button>
                <button
                  onClick={() => action("mapping", `/admin/api/report-mappings/${m.id}`, { method: "DELETE" })}
                  className="rounded border px-2 py-0.5 text-xs text-red-600"
                >
                  דחייה
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl border p-4">
        <h2 className="mb-2 font-medium">כל העסקאות ({job.transactions.length})</h2>
        <div className="max-h-[32rem] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">חודש</th>
                <th className="py-1 pr-3 font-medium">תאריך</th>
                <th className="py-1 pr-3 font-medium">בית עסק</th>
                <th className="py-1 pr-3 font-medium">סכום</th>
                <th className="py-1 pr-3 font-medium">קטגוריה</th>
                <th className="py-1 font-medium">מקור</th>
              </tr>
            </thead>
            <tbody>
              {job.transactions.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="py-1 pr-3 whitespace-nowrap">{t.month}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{t.date}</td>
                  <td className="py-1 pr-3" dir="auto">{t.merchant}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{shekel(t.amountAgorot)}</td>
                  <td className="py-1 pr-3" dir="auto">{t.uncategorized ? "— ללא סיווג —" : t.category}</td>
                  <td className="py-1" dir="auto">{t.sourceLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function UncatRow({
  txn,
  onAssign,
}: {
  txn: Txn;
  onAssign: (txId: string, category: string, remember: boolean) => Promise<void>;
}) {
  const [category, setCategory] = useState("");
  const [remember, setRemember] = useState(true);
  return (
    <tr className="border-t">
      <td className="py-1 pr-3 whitespace-nowrap">{txn.date}</td>
      <td className="py-1 pr-3" dir="auto">{txn.merchant}</td>
      <td className="py-1 pr-3 whitespace-nowrap">{shekel(txn.amountAgorot)}</td>
      <td className="py-1 pr-3 text-muted-foreground" dir="auto">{txn.note}</td>
      <td className="py-1">
        <span className="flex items-center gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded border bg-background px-1 py-0.5"
            dir="rtl"
          >
            <option value="">בחר קטגוריה…</option>
            {TAXONOMY_LEAVES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            לזכור
          </label>
          <button
            onClick={() => void onAssign(txn.id, category, remember)}
            disabled={!category}
            className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
          >
            הקצאה
          </button>
        </span>
      </td>
    </tr>
  );
}
