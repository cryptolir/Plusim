"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileTextIcon, HomeIcon, UsersIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Persistent bottom tab bar for signed-in users. The app is RTL, so flex lays
// the DOM out right→left: the array order below renders as
// Community (right) · Home (center) · Report (left), as requested.
const TABS = [
  { href: "/community", label: "קהילה", Icon: UsersIcon },
  { href: "/", label: "בית", Icon: HomeIcon },
  { href: "/report", label: "דוח", Icon: FileTextIcon },
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="flex h-16 shrink-0 items-stretch border-t bg-background/95 backdrop-blur">
      {TABS.map(({ href, label, Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors",
              active
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
