/**
 * Income table + מצבנו row — one component for both report surfaces
 * (docs/plans/bank-statements.md C2): the client's /report (one month per
 * table) and the admin ReportView (all months as columns). No hooks, no data
 * fetching: the caller hands it the numbers from reportAnalysis.buildAnalysis,
 * already positive for income.
 */
import { shekel } from "@/lib/reportAnalysis";

export interface IncomeBlockProps {
  /** Column headers, in order (one per month, optionally followed by an average). */
  columns: string[];
  /** Income leaves that carry rows; `byColumn` has one value per column, POSITIVE agorot. */
  leaves: { leaf: string; byColumn: number[] }[];
  /** Σ income per column (positive). */
  incomeByColumn: number[];
  /** Expense total per column (the matrix's סה"כ החודש). */
  expenseByColumn: number[];
  /** Hide the leaf rows and the income header when the job has no income rows — the מצבנו row still renders. */
  showIncome: boolean;
  className?: string;
}

export function IncomeBlock({ columns, leaves, incomeByColumn, expenseByColumn, showIncome, className }: IncomeBlockProps) {
  const cell = "px-3 py-1.5 whitespace-nowrap tabular-nums";
  return (
    <div className={className ?? "overflow-x-auto rounded-xl border"}>
      <table className="w-full text-sm" data-testid="income-block">
        {showIncome && (
          <>
            <thead>
              <tr className="bg-emerald-50/70 text-right">
                <th className="px-3 py-2 font-semibold">הכנסות</th>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leaves.map((l) => (
                <tr key={l.leaf} className="border-t">
                  <td className="px-3 py-1.5 pr-6">{l.leaf}</td>
                  {l.byColumn.map((v, i) => (
                    <td key={i} className={cell}>
                      {shekel(v)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t bg-emerald-50/70 font-semibold">
                <td className="px-3 py-1.5">סה&quot;כ הכנסות</td>
                {incomeByColumn.map((v, i) => (
                  <td key={i} className={cell}>
                    {shekel(v)}
                  </td>
                ))}
              </tr>
            </tbody>
          </>
        )}
        <tbody>
          <tr className="border-t-2 bg-muted/40 font-semibold" data-testid="net-row">
            <td className="px-3 py-2">מצבנו</td>
            {columns.map((c, i) => {
              const net = (incomeByColumn[i] ?? 0) - (expenseByColumn[i] ?? 0);
              return (
                <td key={c} className={`${cell} ${net < 0 ? "text-red-700" : "text-emerald-700"}`}>
                  <span className="block text-xs font-normal text-muted-foreground">
                    הכנסות {shekel(incomeByColumn[i] ?? 0)} · הוצאות {shekel(expenseByColumn[i] ?? 0)}
                  </span>
                  יתרה {shekel(net)}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
