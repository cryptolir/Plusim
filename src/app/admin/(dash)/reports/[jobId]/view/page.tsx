import Link from "next/link";
import { notFound } from "next/navigation";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/adminClerk";
import { db } from "@/lib/db";
import { getMergedTaxonomy } from "@/lib/reportCategories";
import { buildAnalysis } from "@/lib/reportAnalysis";
import { ReportView } from "@/components/admin/ReportView";

export const dynamic = "force-dynamic";

export const metadata = { title: "דוח מקוון · Plusim" };

/** Clerk display name for the report's owner; falls back to the raw id. */
async function userLabel(userId: string): Promise<string> {
  try {
    const client = await clerkClient();
    const u = await client.users.getUser(userId);
    return (
      [u.firstName, u.lastName].filter(Boolean).join(" ") ||
      u.username ||
      u.primaryEmailAddress?.emailAddress ||
      userId
    );
  } catch {
    return userId;
  }
}

export default async function AdminReportViewPage({ params }: { params: Promise<{ jobId: string }> }) {
  await requireAdmin();
  const { jobId } = await params;

  const job = await db.reportJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      title: true,
      status: true,
      targetUserId: true,
      publishedAt: true,
      sheetUrl: true,
      transactions: {
        orderBy: { date: "asc" },
        select: {
          id: true,
          month: true,
          date: true,
          merchant: true,
          amountAgorot: true,
          category: true,
          uncategorized: true,
          sourceLabel: true,
          note: true,
        },
      },
    },
  });
  if (!job) notFound();

  // The online report is the PUBLISHED report — an unpublished job has no
  // report to show yet, and the table's publish shortcut is the way in.
  if (job.status !== "published") {
    return (
      <div className="space-y-4">
        <Link href="/admin/reports" className="text-sm text-blue-600 underline">
          ← כל עבודות הדוח
        </Link>
        <div className="rounded-xl border p-6 text-center">
          <p className="text-muted-foreground">הדוח הזה טרם פורסם, ולכן אין עדיין דוח מקוון.</p>
          <Link href={`/admin/reports/${job.id}`} className="mt-2 inline-block text-blue-600 underline">
            מעבר לעבודת הדוח לפרסום
          </Link>
        </div>
      </div>
    );
  }

  const [taxonomy, user] = await Promise.all([getMergedTaxonomy(), userLabel(job.targetUserId)]);
  const analysis = buildAnalysis(job.transactions, taxonomy);

  return (
    <ReportView
      job={{
        id: job.id,
        title: job.title || "דוח הוצאות",
        user,
        publishedAt: job.publishedAt ? job.publishedAt.toLocaleDateString("he-IL") : null,
        sheetUrl: job.sheetUrl,
      }}
      analysis={analysis}
      transactions={job.transactions}
    />
  );
}
