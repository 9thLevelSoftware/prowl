import { Badge } from "@/components/ui";

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "ok":
      return <Badge tone="ok">Connected</Badge>;
    case "needs_signin":
      return <Badge tone="warn">Sign in needed</Badge>;
    case "error":
      return <Badge tone="bad">Problem</Badge>;
    default:
      return <Badge>Not checked</Badge>;
  }
}

export function StatusDot({ status }: { status: string }) {
  const color = status === "ok" ? "bg-ok" : status === "needs_signin" ? "bg-warn" : status === "error" ? "bg-bad" : "bg-border";
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${color}`} />;
}
