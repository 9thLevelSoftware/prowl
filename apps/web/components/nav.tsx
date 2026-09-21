"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  UserRound,
  Briefcase,
  ClipboardCheck,
  Send,
  CircleAlert,
  Rss,
  MessagesSquare,
  Activity,
  Settings,
  Rocket,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "./ui";
import { ActivityStatus } from "./activity-status";

const ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/onboarding", label: "Get started", icon: Rocket },
  { section: "Pipeline" },
  { href: "/jobs", label: "Jobs", icon: Briefcase, count: "jobs" },
  { href: "/review", label: "Review", icon: ClipboardCheck, count: "review" },
  { href: "/needs-input", label: "Needs you", icon: CircleAlert, count: "needsInput", warn: true },
  { href: "/applications", label: "Applications", icon: Send },
  { section: "You" },
  { href: "/profile", label: "Profile & resume", icon: UserRound },
  { href: "/preferences", label: "Preferences", icon: SlidersHorizontal },
  { href: "/qa", label: "Saved answers", icon: MessagesSquare },
  { section: "System" },
  { href: "/sources", label: "Job sources", icon: Rss, count: "suggestions" },
  { href: "/runs", label: "Activity & costs", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function Nav({ counts, worker }: { counts: Record<string, number>; worker: { online: boolean; currentTask: string | null } }) {
  const pathname = usePathname();
  return (
    <nav className="flex h-full flex-col gap-0.5 p-3">
      <Link href="/" className="mb-4 flex items-center gap-2 px-2 pt-1">
        <span className="grid size-7 place-items-center rounded-md bg-accent text-[13px] font-bold text-white dark:text-[#10131c]">JH</span>
        <span className="font-semibold tracking-tight">Prowl</span>
      </Link>
      {ITEMS.map((item, i) => {
        if ("section" in item) {
          return (
            <p key={i} className="mt-4 px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
              {item.section}
            </p>
          );
        }
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;
        const count = "count" in item ? counts[item.count] : 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn("flex h-8 items-center gap-2 rounded-md px-2 text-[13.5px] text-muted hover:bg-panel-2 hover:text-text", active && "bg-panel-2 font-medium text-text")}
          >
            <Icon className="size-4 shrink-0" strokeWidth={1.8} />
            <span className="flex-1 truncate">{item.label}</span>
            {count ? (
              <span className={cn("tabular rounded px-1.5 text-[11px] font-semibold", "warn" in item ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent")}>{count}</span>
            ) : null}
          </Link>
        );
      })}
      <ActivityStatus initialWorker={worker} />
    </nav>
  );
}
