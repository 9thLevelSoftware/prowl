"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Subscribes to the worker's event stream and refreshes server components when something changes.
 * Refreshes are throttled so a burst of events (e.g. discovery ingesting 200 jobs) causes one re-render.
 */
export function LiveRefresh() {
  const router = useRouter();
  const [toast, setToast] = useState<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      es = new EventSource("/api/events");
      es.onmessage = (msg) => {
        try {
          const e = JSON.parse(msg.data) as { type: string; message?: string };
          if (e.type === "discovery:progress" && e.message) setToast(e.message);
          if (e.type === "discovery:done" && e.message) setToast(`Discovery: ${e.message}`);
          if (e.type === "task:failed") setToast(`A task failed: ${(e as { error?: string }).error ?? ""}`.slice(0, 160));
        } catch {
          /* ignore */
        }
        if (!pending.current) {
          pending.current = setTimeout(() => {
            pending.current = null;
            router.refresh();
          }, 1500);
        }
      };
      es.onerror = () => {
        es?.close();
        retry = setTimeout(connect, 10_000);
      };
    };
    connect();
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
      if (pending.current) clearTimeout(pending.current);
    };
  }, [router]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  return toast ? (
    <div role="status" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-md border border-border bg-panel px-3 py-2 text-[13px] shadow-lg">
      {toast}
    </div>
  ) : null;
}
