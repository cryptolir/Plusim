import Link from "next/link";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const client = await clerkClient();
  const list = await client.users.getUserList({ limit: 200 });

  const stats = await db.conversation.groupBy({
    by: ["userId"],
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  const statByUser = new Map(
    stats.map((s) => [s.userId, { count: s._count._all, last: s._max.updatedAt }]),
  );

  const driveFolders = await db.userDriveFolder.findMany();
  const folderByUser = new Map(
    driveFolders.map((f) => [f.userId, f.folderName || f.folderId]),
  );

  const rows = list.data
    .map((u) => {
      const s = statByUser.get(u.id);
      const name =
        [u.firstName, u.lastName].filter(Boolean).join(" ") ||
        u.username ||
        u.primaryEmailAddress?.emailAddress ||
        u.id;
      return {
        id: u.id,
        name,
        email: u.primaryEmailAddress?.emailAddress ?? "",
        count: s?.count ?? 0,
        last: s?.last ?? null,
        driveFolder: folderByUser.get(u.id) ?? null,
      };
    })
    .sort((a, b) => (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0));

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">משתמשים ({rows.length})</h1>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">משתמש</th>
              <th className="px-3 py-2 font-medium">שימוש אחרון</th>
              <th className="px-3 py-2 font-medium">שיחות</th>
              <th className="px-3 py-2 font-medium">תיקיית Drive</th>
              <th className="px-3 py-2 font-medium">קובץ משתמש</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2">
                  <div className="font-medium">{r.name}</div>
                  {r.email && <div className="text-xs text-muted-foreground">{r.email}</div>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.last ? r.last.toLocaleString() : "—"}
                </td>
                <td className="px-3 py-2">{r.count}</td>
                <td className="px-3 py-2">
                  {r.driveFolder ? (
                    <span className="flex items-center gap-2">
                      <span className="max-w-[12rem] truncate" title={r.driveFolder}>
                        📁 {r.driveFolder}
                      </span>
                      <Link href={`/admin/users/${r.id}/drive`} className="text-xs text-blue-600 underline">
                        שינוי
                      </Link>
                    </span>
                  ) : (
                    <Link href={`/admin/users/${r.id}/drive`} className="text-blue-600 underline">
                      שיוך
                    </Link>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Link href={`/admin/users/${r.id}/file`} className="text-blue-600 underline">
                    עריכת קובץ
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  אין משתמשים.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
