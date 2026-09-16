import Link from "next/link";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ComponentProps, ReactNode } from "react";

export function cn(...args: Parameters<typeof clsx>) {
  return twMerge(clsx(...args));
}

/* ------------------------------ Layout ------------------------------ */

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border border-border bg-panel", className)} {...props} />;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="font-medium">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="max-w-md text-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* ------------------------------ Controls ----------------------------- */

const buttonVariants = {
  primary: "bg-accent text-white hover:opacity-90 border-transparent dark:text-[#10131c]",
  secondary: "bg-panel text-text border-border hover:bg-panel-2",
  ghost: "bg-transparent border-transparent text-muted hover:text-text hover:bg-panel-2",
  danger: "bg-panel text-bad border-border hover:bg-bad-soft",
  success: "bg-ok text-white border-transparent hover:opacity-90 dark:text-[#0d1a13]",
};
const buttonSizes = { sm: "h-7 px-2.5 text-[13px]", md: "h-8 px-3", lg: "h-10 px-4 text-[15px]" };

export type ButtonVariant = keyof typeof buttonVariants;

export function buttonClass(variant: ButtonVariant = "secondary", size: keyof typeof buttonSizes = "md", className?: string) {
  return cn(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    buttonVariants[variant],
    buttonSizes[size],
    className,
  );
}

export function Button({ variant = "secondary", size = "md", className, ...props }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: keyof typeof buttonSizes }) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

export function LinkButton({ variant = "secondary", size = "md", className, ...props }: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: keyof typeof buttonSizes }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

const field = "w-full rounded-md border border-border bg-panel px-2.5 text-text placeholder:text-muted/70 focus:border-accent focus:outline-none disabled:opacity-60";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(field, "h-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(field, "py-1.5 leading-relaxed", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(field, "h-8 pr-7", className)} {...props} />;
}

export function Label({ className, children, hint, ...props }: ComponentProps<"label"> & { hint?: ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1", className)} {...props}>
      {children}
      {hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function LabelText({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <span className="text-[13px] font-medium">
      {children}
      {required ? <span className="text-bad"> *</span> : null}
    </span>
  );
}

export function Checkbox({ label, hint, ...props }: ComponentProps<"input"> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" {...props} />
      <span>
        <span className="text-[13px] font-medium">{label}</span>
        {hint ? <span className="block text-[12px] text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/* ------------------------------- Status ------------------------------ */

const tones = {
  neutral: "bg-panel-2 text-muted border-border",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  bad: "bg-bad-soft text-bad border-transparent",
  busy: "bg-busy-soft text-busy border-transparent",
};
export type Tone = keyof typeof tones;

export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: Tone }) {
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px text-[12px] font-medium", tones[tone], className)} {...props} />;
}

export const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  matched: { label: "Matched", tone: "neutral" },
  tailoring: { label: "Tailoring", tone: "busy" },
  ready_for_review: { label: "Ready for review", tone: "accent" },
  approved: { label: "Approved", tone: "busy" },
  applying: { label: "Applying", tone: "busy" },
  needs_input: { label: "Needs you", tone: "warn" },
  submitted: { label: "Submitted", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  skipped: { label: "Skipped", tone: "neutral" },
  rejected_by_user: { label: "Rejected", tone: "neutral" },
};

export function StatusBadge({ status, dryRun }: { status: string; dryRun?: boolean }) {
  const m = STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge tone={m.tone}>
      {m.label}
      {dryRun && (status === "approved" || status === "applying") ? " (dry run)" : ""}
    </Badge>
  );
}

export const OUTCOME_META: Record<string, { label: string; tone: Tone }> = {
  none: { label: "No response yet", tone: "neutral" },
  acknowledged: { label: "Acknowledged", tone: "neutral" },
  recruiter_contact: { label: "Recruiter contact", tone: "accent" },
  interview: { label: "Interview", tone: "busy" },
  offer: { label: "Offer", tone: "ok" },
  rejected: { label: "Rejected", tone: "bad" },
  ghosted: { label: "No response", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

export function ScoreBadge({ score, vetoed }: { score: number | null | undefined; vetoed?: boolean }) {
  if (score == null) return <Badge>—</Badge>;
  if (vetoed) return <Badge tone="bad">Filtered</Badge>;
  const tone: Tone = score >= 75 ? "ok" : score >= 60 ? "accent" : score >= 45 ? "warn" : "neutral";
  return (
    <Badge tone={tone} className="tabular min-w-9 justify-center">
      {Math.round(score)}
    </Badge>
  );
}

export function Stat({ label, value, hint, href }: { label: string; value: ReactNode; hint?: ReactNode; href?: string }) {
  const body = (
    <div className="flex h-full flex-col gap-1 rounded-lg border border-border bg-panel p-4 transition-colors hover:border-accent/40">
      <span className="text-[12px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="tabular text-2xl font-semibold">{value}</span>
      {hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/* ------------------------------- Tables ------------------------------ */

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full border-collapse text-left", className)} {...props} />
    </div>
  );
}
export function Th({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("whitespace-nowrap border-b border-border px-3 py-2 text-[12px] font-medium uppercase tracking-wide text-muted", className)} {...props} />;
}
export function Td({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("border-b border-border px-3 py-2 align-top", className)} {...props} />;
}

export function Notice({ tone = "neutral", title, children, className }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-md border px-3 py-2.5", tones[tone], className)}>
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={cn("text-[13px]", title ? "mt-0.5" : "")}>{children}</div> : null}
    </div>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function money(n: number | null | undefined): string {
  if (n == null) return "";
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
}
