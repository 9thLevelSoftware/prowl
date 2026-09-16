"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type { ActivityResponse } from "@/app/api/activity/route";
import { cn } from "./ui";

function elapsed(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Live system status: what the AI is doing right now (from the web app or the worker) and
 * whether the background worker is running. Polls every 2 seconds while the tab is visible.
 */
export function ActivityStatus({ initialWorker }: { initialWorker: { online: boolean; currentTask: string | null } }) {
  const [data, setData] = useState<ActivityResponse>({ worker: { online: initialWorker.online, tasks: initialWorker.currentTask ? [initialWorker.currentTask] : [] }, ai: [] });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch("/api/activity", { cache: "no-store" });
        if (res.ok && !stopped) setData(await res.json());
      } catch {
        /* keep last known state */
      }
      if (!stopped) timer = setTimeout(poll, document.hidden ? 10_000 : 2_000);
    };
    void poll();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, []);

  const busy = data.ai.length > 0;
  const first = data.ai[0];

  return (
    <div className="mt-auto flex flex-col gap-2" aria-live="polite">
      <div className={cn("rounded-md border px-2.5 py-2 text-[12px]", busy ? "border-busy/40 bg-busy-soft" : "border-border")}>
        <div className="flex items-center gap-1.5">
          {busy ? <Sparkles className="size-3.5 animate-pulse text-busy" /> : <span className="size-2 rounded-full bg-border" />}
          <span className={cn("font-medium", busy && "text-busy")}>{busy ? "AI working" : "AI idle"}</span>
          {busy ? <span className="tabular ml-auto text-muted">{elapsed(first!.startedAt, now)}</span> : null}
        </div>
        {first ? (
          <>
            <p className="mt-0.5 truncate">{first.label}</p>
            <p className="truncate text-muted">
              {first.model}
              {first.effort ? ` · ${first.effort} effort` : ""}
            </p>
            {data.ai.length > 1 ? <p className="text-muted">+{data.ai.length - 1} more in progress</p> : null}
          </>
        ) : null}
      </div>
      <div className="rounded-md border border-border px-2.5 py-2 text-[12px]">
        <div className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", data.worker.online ? "bg-ok" : "bg-bad")} />
          <span className="font-medium">{data.worker.online ? "Worker running" : "Worker offline"}</span>
        </div>
        <p className="mt-0.5 truncate text-muted">{data.worker.online ? (data.worker.tasks.length ? data.worker.tasks.join(", ") : "No background tasks") : "Run pnpm dev to start it"}</p>
      </div>
    </div>
  );
}
