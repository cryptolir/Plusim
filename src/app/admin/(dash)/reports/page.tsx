import Link from "next/link";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/adminClerk";
import { mintSaveToken } from "@/lib/adminSaveToken";
import { REPORTS_TOKEN_SCOPE } from "@/lib/reportsAdminAuth";
import { db } from "@/lib/db";
import { ReportUploadForm } from "@/components/admin/ReportUploadForm";

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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="mb-1 text-xl font-semibold">Statement reports</h1>
        <p className="text-sm text-muted-foreground">
          Upload card statements (.xlsx / .pdf), send them to the onlyclaw agent for
          categorization, review, then publish to the user&apos;s report section.
        </p>
      </div>

      <ReportUploadForm users={users} saveToken={token} />

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Job</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Files</th>
              <th className="px-3 py-2 font-medium">Transactions</th>
              <th className="px-3 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-t">
                <td className="px-3 py-2">
                  <Link href={`/admin/reports/${j.id}`} className="text-blue-600 underline">
                    {j.title || j.id.slice(0, 10)}
                  </Link>
                </td>
                <td className="px-3 py-2">{nameByUser.get(j.targetUserId) ?? j.targetUserId}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[j.status] ?? "bg-muted"}`}>
                    {j.status}
                  </span>
                </td>
                <td className="px-3 py-2">{j._count.files}</td>
                <td className="px-3 py-2">{j._count.transactions}</td>
                <td className="px-3 py-2 whitespace-nowrap">{j.createdAt.toLocaleString()}</td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  No report jobs yet — upload statements above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
