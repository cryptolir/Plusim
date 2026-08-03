import Link from "next/link";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/adminClerk";
import { mintSaveToken } from "@/lib/adminSaveToken";
import { REPORTS_TOKEN_SCOPE } from "@/lib/reportsAdminAuth";
import { db } from "@/lib/db";
import { ReportUploadForm } from "@/components/admin/ReportUploadForm";
import { PublishRowButton } from "@/components/admin/PublishRowButton";
import { DeleteJobButton } from "@/components/admin/DeleteJobButton";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  uploaded: "bg-muted text-foreground",
  dispatched: "bg-amber-100 text-amber-900",
  processing: "bg-amber-100 text-amber-900",
  needs_review: "bg-orange-100 text-orange-900",
  completed: "bg-emerald-100 text-emerald-900",
  published: "bg-blue-100 text-blue-900",
  failed: "bg-red-100 text-red-900",
};

// Hebrew display labels for the status values (keys stay English — they are the
// job.status enum used in logic/queries; only the rendered badge text changes).
const STATUS_LABEL: Record<string, string> = {
  uploaded: "הועלה",
  dispatched: "נשלח לסוכן",
  processing: "בעיבוד",
  needs_review: "ממתין לבדיקה",
  completed: "הושלם",
  published: "פורסם",
  failed: "נכשל",
};

export default async function AdminReportsPage() {
  const admin = await requireAdmin();
  const token = mintSaveToken(admin.email, REPORTS_TOKEN_SCOPE);

  const client = await clerkClient();
  const list = await client.users.getUserList({ limit: 200 });
  const users = list.data.map((u) => ({
    id: u.id,
    label:
      [u.firstName, u.lastName].filter(Boolean).join(" ") ||
      u.username ||
      u.primaryEmailAddress?.emailAddress ||
      u.id,
  }));
  const nameByUser = new Map(users.map((u) => [u.id, u.label]));

  const jobs = await db.reportJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      targetUserId: true,
      status: true,
      title: true,
      createdAt: true,
      _count: { select: { files: true, transactions: true } },
    },
  });

  // The publish route also accepts "published" (re-publish), but a published row
  // shows the report link instead — re-publishing belongs on the job page, where
  // the verification panel is. Any other status would only earn a refusal.
  const canPublish = (status: string) => ["completed", "needs_review"].includes(status);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="mb-1 text-xl font-semibold">דוחות מדפי חשבון</h1>
        <p className="text-sm text-muted-foreground">
          העלו דפי חשבון של כרטיסי אשראי (.xlsx / .pdf), שלחו אותם לסוכן onlyclaw לסיווג, בדקו
          אותם, ולאחר מכן פרסמו אותם לאזור הדוחות של המשתמש.
        </p>
      </div>

      <ReportUploadForm users={users} saveToken={token} />

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          {/* Header cells inherit the page's RTL start alignment — a text-left
              here (the old bug) put every label on the opposite side of its
              column's data. */}
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-start font-medium">עבודה</th>
              <th className="px-3 py-2 text-start font-medium">משתמש</th>
              <th className="px-3 py-2 text-start font-medium">סטטוס</th>
              <th className="px-3 py-2 text-start font-medium">קבצים</th>
              <th className="px-3 py-2 text-start font-medium">עסקאות</th>
              <th className="px-3 py-2 text-start font-medium">נוצר</th>
              <th className="px-3 py-2 text-start font-medium">דוח מקוון</th>
              <th className="px-3 py-2 text-start font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-t align-top">
                <td className="px-3 py-2">
                  <Link
                    href={`/admin/reports/${j.id}`}
                    className="block max-w-56 truncate text-blue-600 underline"
                    title={j.title || j.id}
                    dir="auto"
                  >
                    {j.title || j.id.slice(0, 10)}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  {/* max-width on a <td> is ignored under table-layout:auto —
                      the clamp has to live on a block inside the cell. */}
                  <span className="block max-w-40 truncate" dir="auto">
                    {nameByUser.get(j.targetUserId) ?? j.targetUserId}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[j.status] ?? "bg-muted"}`}>
                    {STATUS_LABEL[j.status] ?? j.status}
                  </span>
                </td>
                <td className="px-3 py-2 tabular-nums">{j._count.files}</td>
                <td className="px-3 py-2 tabular-nums">{j._count.transactions}</td>
                {/* Hebrew locale + LTR isolation: a bare toLocaleString() renders
                    US order and its digits scatter inside the RTL row. */}
                <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                  <span dir="ltr">
                    {j.createdAt.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {j.status === "published" ? (
                    <Link
                      href={`/admin/reports/${j.id}/view`}
                      target="_blank"
                      className="rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors hover:bg-muted"
                    >
                      פתיחת הדוח ↗
                    </Link>
                  ) : canPublish(j.status) ? (
                    <PublishRowButton
                      jobId={j.id}
                      saveToken={token}
                      user={nameByUser.get(j.targetUserId) ?? j.targetUserId}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">טרם מוכן</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {["dispatched", "processing"].includes(j.status) ? null : (
                    <DeleteJobButton
                      jobId={j.id}
                      saveToken={token}
                      label={j.title || j.id.slice(0, 10)}
                    />
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  אין עדיין עבודות דוח — העלו דפי חשבון למעלה.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
