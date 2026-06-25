import Link from "next/link";
import { clerkClient } from "@clerk/nextjs/server";
import { getUserFileRaw } from "@/lib/agentglob";
import { requireAdmin } from "@/lib/adminClerk";
import { mintSaveToken } from "@/lib/adminSaveToken";
import { FileEditor } from "@/components/admin/FileEditor";

export const dynamic = "force-dynamic";

export default async function UserFilePage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const admin = await requireAdmin();
  const { userId } = await params;

  let label = userId;
  try {
    const u = await (await clerkClient()).users.getUser(userId);
    label =
      [u.firstName, u.lastName].filter(Boolean).join(" ") ||
      u.username ||
      u.primaryEmailAddress?.emailAddress ||
      userId;
  } catch {
    // fall back to the raw id
  }

  const raw = await getUserFileRaw(userId);
  const saveToken = mintSaveToken(admin.email, userId);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/admin" className="text-sm text-blue-600 underline">
        ← Back to users
      </Link>
      <h1 className="mt-2 text-xl font-semibold">User file — {label}</h1>
      <p className="mb-4 break-all text-xs text-muted-foreground">{userId}</p>

      {raw === null ? (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Could not load the user file. The raw endpoint may be unavailable or the read key is not
          configured.
        </p>
      ) : (
        <FileEditor
          userId={userId}
          initialContent={raw.content}
          etag={raw.etag}
          exists={raw.exists}
          saveToken={saveToken}
        />
      )}
    </div>
  );
}
