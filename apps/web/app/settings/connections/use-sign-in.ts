"use client";

import { useEffect, useRef, useState } from "react";
import type { Result } from "@/components/action";
import { signInStatusAction } from "@/lib/actions/llm";

type StartResult = { ok: true; data?: { flowId: string; authorizeUrl: string; connectionId: string | null }; message?: string } | { ok: false; error: string };

export interface SignInState {
  phase: "idle" | "waiting" | "done" | "error";
  message?: string;
  authorizeUrl?: string;
}

/**
 * Opens the provider's sign-in page in a new tab and polls until the local callback completes.
 * The tab is opened synchronously on click (before any await) so popup blockers allow it.
 */
export function useSignIn(onDone: (connectionId: string, result: Result) => void) {
  const [state, setState] = useState<SignInState>({ phase: "idle" });
  const cancelled = useRef(false);
  useEffect(() => () => void (cancelled.current = true), []);

  async function start(begin: () => Promise<StartResult>) {
    cancelled.current = false;
    const popup = window.open("", "_blank");
    popup?.document.write("<p style='font-family:system-ui;padding:2rem'>Opening sign-in…</p>");
    setState({ phase: "waiting", message: "Opening sign-in…" });
    const r = await begin();
    if (!r.ok || !r.data) {
      popup?.close();
      setState({ phase: "error", message: r.ok ? "Could not start sign-in" : r.error });
      return;
    }
    const { flowId, authorizeUrl } = r.data;
    if (popup && !popup.closed) popup.location.href = authorizeUrl;
    setState({ phase: "waiting", message: "Finish signing in in the new tab…", authorizeUrl });

    const deadline = Date.now() + 10 * 60_000;
    while (!cancelled.current && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 1500));
      const s = await signInStatusAction(flowId);
      if (!s.ok) {
        setState({ phase: "error", message: s.error });
        return;
      }
      if (s.data?.status === "done") {
        setState({ phase: "done", message: s.message ?? "Signed in" });
        onDone(s.data.connectionId!, s);
        return;
      }
    }
    if (!cancelled.current) setState({ phase: "error", message: "Sign-in timed out. Try again." });
  }

  return { state, start, reset: () => setState({ phase: "idle" }) };
}
