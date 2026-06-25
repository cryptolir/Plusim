"use client";
import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

interface AgentInfo {
  displayName?: string;
  emoji?: string;
  iconImageUrl?: string;
}

// Module-level cache: the agent's identity is fetched once per page load and
// shared by every message row (avatars render per message).
let cachedInfo: AgentInfo | null = null;
let pendingInfo: Promise<AgentInfo | null> | null = null;

function fetchAgentInfo(): Promise<AgentInfo | null> {
  if (cachedInfo) return Promise.resolve(cachedInfo);
  pendingInfo ??= fetch("/api/chat/agent-info")
    .then((r) => (r.ok ? (r.json() as Promise<AgentInfo>) : null))
    .then((data) => {
      cachedInfo = data;
      return data;
    })
    .catch(() => null);
  return pendingInfo;
}

export function useAgentInfo(): AgentInfo | null {
  const [info, setInfo] = useState<AgentInfo | null>(cachedInfo);
  useEffect(() => {
    let mounted = true;
    fetchAgentInfo().then((data) => {
      if (mounted && data) setInfo(data);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return info;
}

// The agent's profile picture (Telegram-style), shown beside every agent
// reply. Falls back to the agent's emoji while loading / on error.
export function AgentAvatar({ className }: { className?: string }) {
  const info = useAgentInfo();
  return (
    <Avatar className={cn("size-8 shrink-0", className)}>
      {info?.iconImageUrl ? (
        <AvatarImage src={info.iconImageUrl} alt={info.displayName ?? ""} />
      ) : null}
      <AvatarFallback className="bg-emerald-100 text-base">
        {info?.emoji ?? "🌱"}
      </AvatarFallback>
    </Avatar>
  );
}

// The signed-in user's profile picture (from Clerk), shown beside their
// messages. Falls back to their initial.
export function UserAvatar({ className }: { className?: string }) {
  const { user } = useUser();
  const initial =
    user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "א";
  return (
    <Avatar className={cn("size-8 shrink-0", className)}>
      {user?.imageUrl ? <AvatarImage src={user.imageUrl} alt="" /> : null}
      <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">
        {initial.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
