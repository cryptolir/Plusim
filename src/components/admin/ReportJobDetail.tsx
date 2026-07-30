"use client";

/**
 * Admin job detail: status + actions (run / publish), verification panel,
 * transaction review (assign categories to uncategorized rows), and pending
 * merchant-mapping approvals. All calls carry the reports save token.
 */
import { useEffect, useState } from "react";
import { SECTION_NAMES } from "@/config/reportTaxonomy";

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
  /** ISO string; the detail route already selects it. Used for the stale-dispatch reopen (F28). */
  dispatchedAt: string | null;
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
  // Merged (base ∪ admin-added) category leaves from the job-detail GET — the
  // single source for the assign picker; never the static base constant.
  const [categoryLeaves, setCategoryLeaves] = useState<string[]>([]);
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
      setCategoryLeaves(data.categoryLeaves ?? []);
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

  // Re-running a PUBLISHED report is the "update a ready report" path: it pulls
  // the report out of the client's view until it is re-published, and the agent
  // rebuilds every row — so manual category assignments that were not saved with
  // "לזכור" are recomputed. Both consequences are stated before we send.
  async function runAgent() {
    const published = job?.status === "published";
    if (
      published &&
      !window.confirm(
        "הרצה מחדש של דוח שפורסם:\n\n" +
          "• הדוח ייעלם מהתצוגה של הלקוח עד לפרסום מחדש.\n" +
          "• הסוכן יבנה מחדש את כל השורות — סיווגים ידניים שלא נשמרו עם סימון “לזכור” יחושבו מחדש.\n\n" +
          "להמשיך?",
      )
    ) {
      return;
    }
    await action("run", `/admin/api/reports/${jobId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(published ? { confirmUpdate: true } : {}),
    });
  }

  async function addFiles(files: FileList) {
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f);
    await action("addFiles", `/admin/api/reports/${jobId}/files`, { method: "POST", body: form });
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
  // A `dispatched` row older than the route stale bound (2 min) is one whose
  // enqueue died before a queue entry existed. The run route accepts exactly
  // that as an idempotent repair — but only an admin can trigger it, so the
  // button must reopen or the job is stuck forever with no product path out
  // (F28). `processing` is never reopened: the worker sweep owns that case.
  const STALE_DISPATCH_MS = 2 * 60_000;
  const staleDispatch =
    job.status === "dispatched" &&
    job.dispatchedAt !== null &&
    Date.now() - new Date(job.dispatchedAt).getTime() > STALE_DISPATCH_MS;
  const running = ["dispatched", "processing"].includes(job.status) && !staleDispatch;

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
          onClick={() => runAgent()}
          disabled={busy !== null || running}
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
        {/* Adding files to a job that already has a report is the update flow:
            upload here, then re-run the agent over the whole set. Hidden while
            the agent is working — the server refuses those appends anyway. */}
        {!running && (
          <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">הוספת דפי חשבון (.xlsx / .pdf)</span>
            <input
              type="file"
              multiple
              accept=".xlsx,.pdf"
              disabled={busy !== null}
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length > 0) void addFiles(files);
                e.target.value = "";
              }}
              className="min-h-11 rounded-lg border bg-background px-2 py-2 disabled:opacity-50"
            />
            {busy === "addFiles" && <span className="text-muted-foreground">מעלה…</span>}
            {job.files.length > 0 && (
              <span className="text-xs text-muted-foreground">
                לאחר ההוספה יש להריץ את הסוכן מחדש כדי לעדכן את הדוח.
              </span>
            )}
          </label>
        )}
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
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">ללא סיווג — הקצאת קטגוריות ({uncategorized.length})</h2>
            <AddCategoryForm
              onAdd={async (name, section) => {
                const data = await action("add-category", "/admin/api/report-categories", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name, section }),
                });
                return data !== undefined;
              }}
              busy={busy === "add-category"}
            />
          </div>
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
                  <UncatRow key={t.id} txn={t} leaves={categoryLeaves} onAssign={assignCategory} />
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

function AddCategoryForm({
  onAdd,
  busy,
}: {
  onAdd: (name: string, section: string) => Promise<boolean>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [section, setSection] = useState(SECTION_NAMES[0] ?? "");

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-lg border px-3 py-1 text-sm">
        ➕ הוספת קטגוריה
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm" dir="rtl">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="שם קטגוריה חדשה"
        className="rounded border bg-background px-2 py-1"
        dir="rtl"
      />
      <label className="flex items-center gap-1 text-muted-foreground">
        שיוך למדור
        <select
          value={section}
          onChange={(e) => setSection(e.target.value)}
          className="rounded border bg-background px-1 py-1"
          dir="rtl"
        >
          {SECTION_NAMES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <button
        onClick={async () => {
          if (await onAdd(name.trim(), section)) {
            setName("");
            setOpen(false);
          }
        }}
        disabled={busy || !name.trim()}
        className="rounded border px-3 py-1 disabled:opacity-50"
      >
        {busy ? "מוסיף…" : "הוספה"}
      </button>
      <button onClick={() => setOpen(false)} className="rounded border px-3 py-1 text-muted-foreground">
        ביטול
      </button>
    </span>
  );
}

function UncatRow({
  txn,
  leaves,
  onAssign,
}: {
  txn: Txn;
  leaves: string[];
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
            {leaves.map((l) => (
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
