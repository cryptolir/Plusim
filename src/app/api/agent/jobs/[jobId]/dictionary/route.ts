/**
 * Agent dictionary lookup. POST /api/agent/jobs/:jobId/dictionary?t=<jobToken>
 * Body: { merchants: string[] } — 1..500 normalized merchant strings, ≤ 200 chars each.
 * Returns: { hits: { [merchant]: category } } — approved mappings only.
 *
 * Replaces the manifest's inline 2,000-entry dictionary for new skills: the
 * skill asks about exactly the merchants in its job, so the dictionary has no
 * size cap (docs/plans/scale-large-statements.md A3/B3). Auth: static runtime
 * bearer + per-job token — this route is middleware-public (src/proxy.ts), the
 * handler is the security boundary.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAgentJobRequest } from "@/lib/agentRuntimeAuth";
import { getMergedTaxonomy } from "@/lib/reportCategories";
import { isIncomeLeaf } from "@/config/reportTaxonomy";

export const dynamic = "force-dynamic";

const MAX_MERCHANTS = 500;
const MAX_MERCHANT_CHARS = 200;
// 500 × 200 chars × 4 UTF-8 bytes, plus JSON punctuation.
const MAX_BODY_BYTES = 512 * 1024;

/**
 * The body as UTF-8 text, or null once it exceeds `limit` bytes. Reads the
 * stream incrementally and cancels it at the limit, so an oversized or endless
 * (chunked) body never gets buffered in full.
 */
async function readBodyCapped(req: NextRequest, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  const auth = await authorizeAgentJobRequest(req, jobId);
  if (auth instanceof NextResponse) return auth;

  const text = await readBodyCapped(req, MAX_BODY_BYTES);
  if (text === null) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const merchants = (body as { merchants?: unknown } | null)?.merchants;
  if (
    !Array.isArray(merchants) ||
    merchants.length < 1 ||
    merchants.length > MAX_MERCHANTS ||
    !merchants.every((m) => typeof m === "string" && m.length > 0 && [...m].length <= MAX_MERCHANT_CHARS)
  ) {
    return NextResponse.json(
      { error: `merchants must be 1–${MAX_MERCHANTS} non-empty strings of ≤ ${MAX_MERCHANT_CHARS} chars` },
      { status: 400 },
    );
  }

  const rows = await db.merchantMapping.findMany({
    where: { approved: true, merchantPattern: { in: [...new Set(merchants as string[])] } },
    select: { merchantPattern: true, category: true },
  });
  // The skill's own rule, enforced here too: only a leaf that exists, and never
  // an income leaf — the dictionary holds one (expense) direction per merchant.
  const taxonomy = await getMergedTaxonomy();
  const valid = new Set(taxonomy.flatMap((s) => s.leaves));
  const hits: Record<string, string> = {};
  for (const r of rows) {
    if (valid.has(r.category) && !isIncomeLeaf(r.category, taxonomy)) hits[r.merchantPattern] = r.category;
  }
  return NextResponse.json({ hits });
}
