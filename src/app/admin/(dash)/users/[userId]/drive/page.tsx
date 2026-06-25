import Link from "next/link";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/adminClerk";
import { mintSaveToken } from "@/lib/adminSaveToken";
import { db } from "@/lib/db";
import { DriveFolderPicker } from "@/components/admin/DriveFolderPicker";
import { DRIVE_ROOT_FOLDER_ID, isDriveConnected, listChildren } from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

export default async function UserDrivePage({ params }: { params: Promise<{ userId: string }> }) {
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

  const connected = await isDriveConnected();
  const current = await db.userDriveFolder.findUnique({ where: { userId } });

  let folders: { id: string; name: string }[] = [];
  let loadError: string | null = null;
  if (connected) {
    try {
      folders = (await listChildren(DRIVE_ROOT_FOLDER_ID))
        .filter((e) => e.isFolder)
        .map((e) => ({ id: e.id, name: e.name }));
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Failed to load folders";
    }
  }

  const saveToken = mintSaveToken(admin.email, userId);

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/admin" className="text-sm text-blue-600 underline">
        ← Back to users
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Drive folder — {label}</h1>
      <p className="break-all text-xs text-muted-foreground">{userId}</p>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Link a folder of meeting transcripts/summaries to this user. Its summaries become background
        context for the agent in this user&apos;s chats (in addition to their workspace files).
      </p>

      {!connected ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Google Drive isn&apos;t connected yet.{" "}
          <Link href="/admin/drive" className="underline">
            Connect it first
          </Link>
          , then assign a folder.
        </p>
      ) : loadError ? (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</p>
      ) : (
        <DriveFolderPicker
          userId={userId}
          folders={folders}
          currentFolderId={current?.folderId ?? null}
          saveToken={saveToken}
        />
      )}
    </div>
  );
}
