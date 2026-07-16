"use client";

import { useEffect, useRef, useState } from "react";

// Official Facebook Page Plugin, iframe build — no JS SDK, no app id, no global
// tracking script; one self-contained frame. We measure the container and render
// the plugin at its real width (FB clamps to 180–500) so it never overflows the
// mobile viewport. Height is fixed at mount and NOT reactive to height changes,
// so the mobile URL-bar collapse (which jitters viewport height) can never
// reload the feed mid-scroll — only a real width change (rotation) re-renders.
const PAGE_URL = "https://www.facebook.com/Iplusim";

export default function FacebookPage() {
  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = Math.min(500, Math.max(180, Math.floor(el.clientWidth)));
        setDims((prev) => {
          if (prev && Math.abs(prev.w - w) < 8) return prev; // width steady → ignore height jitter
          const h = Math.max(400, Math.floor(el.clientHeight));
          return { w, h };
        });
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const src = dims
    ? "https://www.facebook.com/plugins/page.php?" +
      new URLSearchParams({
        href: PAGE_URL,
        tabs: "timeline",
        width: String(dims.w),
        height: String(dims.h),
        small_header: "false",
        adapt_container_width: "true",
        hide_cover: "false",
        show_facepile: "true",
        locale: "he_IL",
      }).toString()
    : null;

  return (
    <div ref={ref} className="h-full w-full">
      {src && dims && (
        <iframe
          src={src}
          title="עמוד הפייסבוק של פלוסים"
          width={dims.w}
          height={dims.h}
          className="mx-auto block"
          style={{ border: "none", overflow: "hidden" }}
          scrolling="no"
          allowFullScreen
          allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
          loading="lazy"
        />
      )}
    </div>
  );
}
