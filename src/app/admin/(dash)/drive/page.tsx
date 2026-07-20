import Link from "next/link";
import { requireAdmin } from "@/lib/adminClerk";
import { mintSaveToken } from "@/lib/adminSaveToken";
import { DRIVE_TOKEN_SCOPE } from "@/lib/driveAuth";
import { DriveBrowser } from "@/components/admin/DriveBrowser";
import {
  DRIVE_ROOT_FOLDER_ID,
  getConnectedEmail,
  getEntry,
  isDriveConnected,
  listChildren,
  type DriveEntry,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

type Crumb = { id: string; name: string };

async function breadcrumbs(folderId: string): Promise<Crumb[]> {
  const crumbs: Crumb[] = [];
  let cur: string | undefined = folderId;
  for (let i = 0; i < 20 && cur; i++) {
    try {
      const e = await getEntry(cur);
      crumbs.unshift({ id: e.id, name: e.name });
      if (e.id === DRIVE_ROOT_FOLDER_ID) break;
      cur = e.parents?.[0];
    } catch {
      break;
    }
  }
  return crumbs;
}

export default async function AdminDrivePage({
  searchParams,
}: {
  searchParams: Promise<{ folderId?: string; connected?: string; error?: string }>;
}) {
  const admin = await requireAdmin();
  const sp = await searchParams;

  if (!(await isDriveConnected())) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-4 text-xl font-semibold">Google Drive</h1>
        {sp.error && (
          <p className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            Connection error: {sp.error}
          </p>
        )}
        <div className="rounded-xl border bg-card p-6">
          <p className="mb-4 text-sm text-muted-foreground">
            Connect the Google account that owns the meeting transcripts to browse and summarize
            files. Read + write access is needed (to save summaries back into the folder).
          </p>
          <a
            href="/admin/drive/connect"
            className="inline-flex rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
          >
            Connect Google Drive
          </a>
        </div>
      </div>
    );
  }

  const folderId = sp.folderId || DRIVE_ROOT_FOLDER_ID;
  const driveToken = mintSaveToken(admin.email, DRIVE_TOKEN_SCOPE);
  const email = await getConnectedEmail();

  let entries: DriveEntry[] = [];
  let crumbs: Crumb[] = [];
  let loadError: string | null = null;
  try {
    [entries, crumbs] = await Promise.all([listChildren(folderId), breadcrumbs(folderId)]);
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Failed to load folder";
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Google Drive</h1>
        <span className="text-xs text-muted-foreground">
          {email ? `Connected as ${email}` : "Connected"} ·{" "}
          <a href="/admin/drive/connect" className="underline">
            reconnect
          </a>
        </span>
      </div>

      {sp.connected && (
        <p className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-700">
          Connected ✓
        </p>
      )}

      <nav className="mb-3 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {crumbs.map((c, i) => (
          <span key={c.id} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden>/</span>}
            {c.id === folderId ? (
              <span className="font-medium text-foreground">{c.name}</span>
            ) : (
              <Link href={`/admin/drive?folderId=${encodeURIComponent(c.id)}`} className="hover:underline">
                {c.name}
              </Link>
            )}
          </span>
        ))}
      </nav>

      {loadError ? (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</p>
      ) : (
        <DriveBrowser entries={entries} driveToken={driveToken} />
      )}

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">Summary method (skill)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The method the agent applies when summarizing a transcript is now edited on the{" "}
          <Link href="/admin/settings" className="underline">
            Settings
          </Link>{" "}
          page.
        </p>
      </section>
    </div>
  );
}
