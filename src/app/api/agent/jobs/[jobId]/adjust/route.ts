/**
 * Agent date / category edits for the adjustment chat.
 * POST /api/agent/jobs/:jobId/adjust?t=<adjust token>
 * Body: { edits: [{ id, date?, category? }] } — nothing else is accepted.
 *
 * The agent's whole power is what an admin can already do by hand: set a row's
 * date (month derived) and/or category (income invariant enforced) — never an
 * amount, a source, a row's existence, or anything of another job. The route,
 * not the agent, builds every written field (reportEdits.resolveEdit).
 *
 * One interactive transaction, all or nothing: (a) claim the job — still
 * adjustable, same token, same dispatch generation — and bump rowsRevision;
 * (b) load the target rows of THIS job; (c) validate every edit; (d) write each.
 * Then the APP rebuilds the workbook from its rows (reportWorkbook.ts); the
 * agent never sends workbook bytes. docs/plans/report-adjust-chat.md B5.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAdjustRequest } from "@/lib/agentRuntimeAuth";
import { getMergedTaxonomy, getValidLeafSet } from "@/lib/reportCategories";
import { bankSources } from "@/lib/reportAnalysis";
import { ADJUSTABLE, resolveEdit, type EditChange } from "@/lib/reportEdits";
import { rebuildReportWorkbook } from "@/lib/reportWorkbook";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_EDITS = 100;
const EDIT_KEYS = new Set(["id", "date", "category"]);

interface Edit {
  id: string;
  date?: unknown;
  category?: unknown;
}

/** Strict body parse: the only shape accepted, or the reason it is not. */
export function parseEdits(body: unknown): Edit[] | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "edits") return "body must contain exactly { edits }";
  const edits = (body as { edits: unknown }).edits;
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_EDITS) {
    return `edits must be a list of 1–${MAX_EDITS}`;
  }
  const seen = new Set<string>();
  for (const [i, e] of edits.entries()) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return `edit ${i}: not an object`;
    const unknown = Object.keys(e).filter((k) => !EDIT_KEYS.has(k));
    if (unknown.length) return `edit ${i}: field(s) not allowed: ${unknown.join(", ")}`;
    const { id } = e as Edit;
    if (typeof id !== "string" || !id) return `edit ${i}: id required`;
    if (seen.has(id)) return `edit ${i}: duplicate id ${id}`;
    seen.add(id);
    if ((e as Edit).date === undefined && (e as Edit).category === undefined) {
      return `edit ${i}: nothing to change (date or category)`;
    }
  }
  return edits as Edit[];
}

class AdjustRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  const auth = await authorizeAdjustRequest(req, jobId);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const edits = parseEdits(body);
  if (typeof edits === "string") return NextResponse.json({ error: edits }, { status: 400 });

  const [validLeaves, taxonomy] = await Promise.all([getValidLeafSet(), getMergedTaxonomy()]);

  let applied: { id: string; merchant: string; field: EditChange["field"]; from: string | null; to: string }[];
  try {
    applied = await db.$transaction(async (tx) => {
      // (a) The claim: still adjustable, the exact token, the exact generation.
      const claim = await tx.reportJob.updateMany({
        where: {
          id: jobId,
          status: { in: ADJUSTABLE },
          adjustTokenHash: auth.tokenHash,
          dispatchedAt: auth.generation,
        },
        data: { rowsRevision: { increment: 1 } },
      });
      if (claim.count === 0) throw new AdjustRefused(409, "job no longer accepting adjustments");

      const job = await tx.reportJob.findUnique({ where: { id: jobId }, select: { verification: true } });
      const bankLabels = bankSources(job?.verification);

      // (b) Rows of THIS job only; a missing id is another job's row or gone.
      const ids = edits.map((e) => e.id);
      const rows = await tx.reportTransaction.findMany({
        where: { id: { in: ids }, jobId },
        select: {
          id: true,
          merchant: true,
          date: true,
          category: true,
          uncategorized: true,
          amountAgorot: true,
          sourceLabel: true,
          note: true,
        },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) throw new AdjustRefused(409, `rows not found in this job: ${missing.join(", ")}`);

      // (c) Validate everything before writing anything.
      const resolved = edits.map((e) => {
        const row = byId.get(e.id)!;
        const r = resolveEdit(row, e, { validLeaves, taxonomy, bankLabels });
        if ("error" in r) throw new AdjustRefused(400, `${row.merchant} (${row.date}, ${e.id}): ${r.error}`);
        return { row, r };
      });

      // (d) Write each, scoped to this job.
      const out: typeof applied = [];
      for (const { row, r } of resolved) {
        if (r.changes.length === 0) continue;
        const upd = await tx.reportTransaction.updateMany({ where: { id: row.id, jobId }, data: r.data });
        if (upd.count !== 1) throw new AdjustRefused(409, `row ${row.id} changed during the edit`);
        for (const c of r.changes) out.push({ id: row.id, merchant: row.merchant, ...c });
      }
      return out;
    });
  } catch (e) {
    if (e instanceof AdjustRefused) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const workbook = await rebuildReportWorkbook(jobId, auth.generation);
  console.log(`[agent/adjust] job=${jobId} edits=${edits.length} applied=${applied.length} workbook=${workbook}`);
  return NextResponse.json({ applied, workbook: workbook === "failed" ? "failed" : "updated" });
}
