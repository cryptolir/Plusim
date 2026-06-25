"use client";
import { UserButton } from "@clerk/nextjs";
import { SproutIcon } from "lucide-react";

// Persistent top app bar for signed-in users: profile avatar (Clerk UserButton)
// on the start side. Clicking it opens Clerk's account menu — account details,
// a "Manage account" modal (edit avatar / email / password with verification),
// and "Sign out". Sticky so page content flows below it (no overlap).
export function TopBar() {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center border-b bg-background/90 px-3 backdrop-blur">
      <UserButton appearance={{ elements: { userButtonAvatarBox: "h-8 w-8" } }} />
      <span className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 font-heading text-lg tracking-tight">
        <SproutIcon className="size-5 text-primary" aria-hidden />
        Plusim
      </span>
    </header>
  );
}
