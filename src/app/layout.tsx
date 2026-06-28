import type { Metadata } from "next";
import { Rubik, Secular_One, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { heIL } from "@clerk/localizations";
import type { ComponentProps } from "react";
import { auth } from "@clerk/nextjs/server";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import "./globals.css";

// Hebrew-first typography: Rubik (friendly geometric body) + Secular One
// (bold display headings). Both ship Hebrew + Latin subsets.
const rubik = Rubik({
  variable: "--font-rubik",
  subsets: ["hebrew", "latin"],
});

const secularOne = Secular_One({
  variable: "--font-secular",
  weight: "400",
  subsets: ["hebrew", "latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// @clerk/localizations trails @clerk/nextjs's pinned @clerk/types on a few
// internal SSO-wizard keys; the strings merge fine at runtime, so bridge the
// type drift here.
const clerkLocalization = heIL as unknown as ComponentProps<
  typeof ClerkProvider
>["localization"];

export const metadata: Metadata = {
  title: "Plusim",
  description: "ליווי פיננסי חכם בשיחה — תכנון, החלטות והכוונה אישית.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Show the profile bar only when signed in; the signed-out landing has none.
  const { userId } = await auth();

  return (
    <ClerkProvider localization={clerkLocalization}>
      <html
        lang="he"
        dir="rtl"
        className={`${rubik.variable} ${secularOne.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="flex h-[100dvh] flex-col overflow-hidden">
          {userId && <TopBar />}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {userId && <BottomNav />}
        </body>
      </html>
    </ClerkProvider>
  );
}
