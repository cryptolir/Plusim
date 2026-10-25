"use client";

/**
 * התאמת חיובי אשראי לחשבון הבנק — the client's reconciliation card
 * (docs/plans/bank-statements.md C2, Decision 5).
 *
 * One row per bank settlement (a debit that paid a card statement), a select of
 * the job's charge cycles, the suggestion pre-selected, and a per-cycle footer
 * `charged · settled · Δ`. Nothing is matched silently: a suggestion is shown
 * as a selection with an "אישור" button; only a confirmed or hand-picked choice
 * is posted to PATCH /api/reports/[jobId]/settlements/[id]. Plain data in —
 * the server page builds targets and suggestions from reportAnalysis.
 */
import { useState } from "react";
import { shekel, monthTitle, type MatchTarget } from "@/lib/reportAnalysis";

export interface SettlementRow {
  id: string;
  date: string;
  month: string;
  payee: string;
  amountAgorot: number;
  sourceLabel: string;
  matchedCycle: string | null;
}

export const CARD_TITLE = "התאמת חיובי אשראי לחשבון הבנק";

export function SettlementMatchCard({
  jobId,
  settlements,
  targets,
  suggestions,
  note,
}: {
  jobId: string;
  settlements: SettlementRow[];
  targets: MatchTarget[];
  /** settlement id → suggested cycle id (reportAnalysis.suggestMatches). */
  suggestions: Record<string, string>;
  /** The verification note when no cycles exist — rendered verbatim instead of the select. */
  note?: string | null;
}) {
  // Persisted matches (what the server has). Suggestions are NOT persisted
  // until confirmed — the client's explicit choice is the match.
  const [matched, setMatched] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(settlements.map((s) => [s.id, s.matchedCycle])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(id: string, cycle: string | null) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${jobId}/settlements/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ matchedCycle: cycle }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "השמירה נכשלה");
      }
      setMatched((m) => ({ ...m, [id]: cycle }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(null);
    }
  }

  const byCycle = new Map<string, number>();
  for (const s of settlements) {
    const c = matched[s.id];
    if (c) byCycle.set(c, (byCycle.get(c) ?? 0) + s.amountAgorot);
  }
  const unmatchedTotal = settlements.filter((s) => !matched[s.id]).reduce((a, s) => a + s.amountAgorot, 0);

  return (
    <div className="space-y-3 rounded-xl border p-3" data-testid="settlement-card">
      <h3 className="font-semibold">{CARD_TITLE}</h3>
      <p className="text-sm text-muted-foreground">
        חיובי כרטיסי האשראי שירדו מחשבון הבנק אינם נספרים כהוצאה — הפירוט שלהם נמצא בדפי הכרטיס. כאן אפשר להתאים
        כל חיוב למחזור החיוב של הכרטיס ששולם בו.
      </p>
      {note && <p className="rounded-lg bg-amber-50 p-2 text-sm">{note}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 text-right">
              <th className="px-2 py-1.5 font-medium">תאריך</th>
              <th className="px-2 py-1.5 font-medium">בנק</th>
              <th className="px-2 py-1.5 font-medium">משלם</th>
              <th className="px-2 py-1.5 font-medium">סכום</th>
              {targets.length > 0 && <th className="px-2 py-1.5 font-medium">מחזור חיוב</th>}
            </tr>
          </thead>
          <tbody>
            {settlements.map((s) => {
              const persisted = matched[s.id];
              const suggestion = suggestions[s.id];
              const showSuggestion = !persisted && !!suggestion;
              return (
                <tr key={s.id} className="border-t">
                  <td className="px-2 py-1.5 whitespace-nowrap">{s.date}</td>
                  <td className="px-2 py-1.5" dir="auto">
                    {s.sourceLabel}
                  </td>
                  <td className="px-2 py-1.5" dir="auto">
                    {s.payee}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{shekel(s.amountAgorot)}</td>
                  {targets.length > 0 && (
                    <td className="px-2 py-1.5">
                      <span className="flex flex-wrap items-center gap-1">
                        <select
                          value={persisted ?? suggestion ?? ""}
                          disabled={busy === s.id}
                          onChange={(e) => void save(s.id, e.target.value || null)}
                          className="min-h-9 rounded border bg-background px-1 text-sm"
                          dir="rtl"
                          aria-label={`מחזור חיוב עבור ${s.payee} ${s.date}`}
                        >
                          <option value="">— ללא התאמה —</option>
                          {targets.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.label} · {t.chargeDate} · {shekel(t.targetAgorot)}
                            </option>
                          ))}
                        </select>
                        {showSuggestion && (
                          <button
                            type="button"
                            onClick={() => void save(s.id, suggestion)}
                            disabled={busy === s.id}
                            className="min-h-9 rounded border px-2 text-xs"
                            title="הצעה אוטומטית — לחצו לאישור"
                          >
                            ✓ אישור ההצעה
                          </button>
                        )}
                        {persisted && <span className="text-xs text-emerald-700">הותאם</span>}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {targets.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="cycle-footer">
          {targets.map((t) => {
            const settled = byCycle.get(t.id) ?? 0;
            const delta = t.targetAgorot - settled;
            return (
              <li key={t.id} className="flex flex-wrap gap-x-3 rounded-lg bg-muted/40 px-2 py-1">
                <span className="font-medium">
                  {t.label} · {monthTitle(t.chargeDate.slice(0, 7))} ({t.chargeDate})
                </span>
                <span>חויב {shekel(t.targetAgorot)}</span>
                <span>שולם {shekel(settled)}</span>
                <span className={delta === 0 ? "text-emerald-700" : "text-amber-700"}>הפרש {shekel(delta)}</span>
              </li>
            );
          })}
          {unmatchedTotal > 0 && (
            <li className="px-2 text-muted-foreground">ללא התאמה: {shekel(unmatchedTotal)}</li>
          )}
        </ul>
      )}
    </div>
  );
}
