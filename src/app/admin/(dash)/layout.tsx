import Link from "next/link";
import { requireAdmin } from "@/lib/adminClerk";

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();

  return (
    <div className="min-h-[100dvh]" dir="rtl">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-4">
          <span className="font-semibold">ניהול Plusim</span>
          <nav className="flex items-center gap-3 text-sm">
            <Link href="/admin" className="text-muted-foreground transition-colors hover:text-foreground">
              משתמשים
            </Link>
            <Link href="/admin/drive" className="text-muted-foreground transition-colors hover:text-foreground">
              Drive
            </Link>
            <Link href="/admin/reports" className="text-muted-foreground transition-colors hover:text-foreground">
              דוחות
            </Link>
            <Link href="/admin/settings" className="text-muted-foreground transition-colors hover:text-foreground">
              הגדרות
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{admin.email}</span>
          <a href="/" className="rounded-full border px-3 py-1 transition-colors hover:bg-muted">
            ← האפליקציה
          </a>
        </div>
      </header>
      <div className="mx-auto max-w-5xl p-4">{children}</div>
    </div>
  );
}
