import Link from "next/link";
import { requireAdmin } from "@/lib/adminClerk";
import { mintSaveToken } from "@/lib/adminSaveToken";
import { REPORTS_TOKEN_SCOPE } from "@/lib/reportsAdminAuth";
import { ReportJobDetail } from "@/components/admin/ReportJobDetail";

export const dynamic = "force-dynamic";

export default async function AdminReportJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const admin = await requireAdmin();
  const { jobId } = await params;
  const token = mintSaveToken(admin.email, REPORTS_TOKEN_SCOPE);

  return (
    <div className="space-y-4">
      <Link href="/admin/reports" className="text-sm text-blue-600 underline">
        ← כל עבודות הדוח
      </Link>
      <ReportJobDetail jobId={jobId} saveToken={token} />
    </div>
  );
}
