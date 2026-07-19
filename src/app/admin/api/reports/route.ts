/**
 * Reports admin API — create a job (multipart upload) + list jobs.
 *
 * POST multipart/form-data: targetUserId, title?, files[] (.xlsx/.pdf ≤10MB).
 * Files are content-sniffed (zip/PDF magic bytes) and stored as bytea.
 */
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 12;

function sniffMime(name: string, buf: Buffer): string | null {
  const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
  const isPdf = buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
  const lower = name.toLowerCase();
  if (isZip && lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (isPdf && lower.endsWith(".pdf")) return "application/pdf";
  return null;
}

export async function POST(req: NextRequest) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const targetUserId = String(form.get("targetUserId") ?? "").trim();
  const title = String(form.get("title") ?? "").trim().slice(0, 120) || null;
  if (!targetUserId) return NextResponse.json({ error: "targetUserId required" }, { status: 400 });

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "no files" }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `max ${MAX_FILES} files` }, { status: 400 });

  const prepared: { filename: string; mime: string; size: number; sha256: string; bytes: Buffer }[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: `${f.name}: over 10MB` }, { status: 400 });
    }
    const bytes = Buffer.from(await f.arrayBuffer());
    const mime = sniffMime(f.name, bytes);
    if (!mime) {
      return NextResponse.json(
        { error: `${f.name}: only .xlsx and .pdf statements are accepted` },
        { status: 400 },
      );
    }
    prepared.push({
      filename: f.name.slice(0, 200),
      mime,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes,
    });
  }

  const job = await db.reportJob.create({
    data: {
      targetUserId,
      createdBy: auth.actor,
      title,
      files: { create: prepared },
    },
    select: { id: true },
  });

  console.log(`[admin/reports] job=${job.id} created by=${auth.actor} files=${prepared.length}`);
  return NextResponse.json({ ok: true, jobId: job.id });
}

export async function GET(req: NextRequest) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const jobs = await db.reportJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      targetUserId: true,
      status: true,
      title: true,
      error: true,
      sheetUrl: true,
      createdAt: true,
      dispatchedAt: true,
      completedAt: true,
      publishedAt: true,
      _count: { select: { files: true, transactions: true } },
    },
  });
  return NextResponse.json({ jobs });
}
