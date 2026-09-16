"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button, type ButtonVariant, cn } from "./ui";

export type Result = { ok: true; message?: string; data?: unknown } | { ok: false; error: string };

export function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const run = (fn: () => Promise<Result>, onOk?: (r: Result) => void) =>
    start(async () => {
      try {
        const r = await fn();
        setResult(r);
        if (r.ok) {
          onOk?.(r);
          router.refresh();
        }
      } catch (err) {
        setResult({ ok: false, error: (err as Error).message });
      }
    });
  return { pending, result, setResult, run };
}

export function ResultMessage({ result, className }: { result: Result | null; className?: string }) {
  if (!result) return null;
  if (result.ok && !result.message) return null;
  return (
    <p role={result.ok ? "status" : "alert"} className={cn("text-[13px]", result.ok ? "text-ok" : "text-bad", className)}>
      {result.ok ? result.message : result.error}
    </p>
  );
}

export function ActionButton({
  action,
  children,
  variant,
  size,
  confirm,
  className,
  disabled,
  showResult = true,
}: {
  action: () => Promise<Result>;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  confirm?: string;
  className?: string;
  disabled?: boolean;
  showResult?: boolean;
}) {
  const { pending, result, run } = useAction();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant={variant}
        size={size}
        className={className}
        disabled={pending || disabled}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          run(action);
        }}
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {children}
      </Button>
      {showResult ? <ResultMessage result={result} /> : null}
    </span>
  );
}
