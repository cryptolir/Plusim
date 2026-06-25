import Link from "next/link";
import type { ReactNode } from "react";

interface SectionCTAProps {
  seed?: string;
  ctx?: string;
  autosend?: boolean;
  children: ReactNode;
  className?: string;
}

export default function SectionCTA({
  seed,
  ctx,
  autosend,
  children,
  className,
}: SectionCTAProps) {
  const params = new URLSearchParams();
  if (seed) params.set("p", seed);
  if (ctx) params.set("ctx", ctx);
  if (autosend) params.set("autosend", "1");
  const href = `/chat?${params.toString()}`;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
