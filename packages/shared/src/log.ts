type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.PROWL_LOG_LEVEL as Level) ?? "info"] ?? 20;

export type Logger = ReturnType<typeof logger>;

export function logger(scope: string) {
  const emit = (level: Level, msg: string, extra?: unknown) => {
    if (order[level] < min) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const out = level === "error" || level === "warn" ? console.error : console.log;
    if (extra === undefined) out(line);
    else out(line, extra instanceof Error ? (extra.stack ?? extra.message) : extra);
  };
  return {
    debug: (m: string, e?: unknown) => emit("debug", m, e),
    info: (m: string, e?: unknown) => emit("info", m, e),
    warn: (m: string, e?: unknown) => emit("warn", m, e),
    error: (m: string, e?: unknown) => emit("error", m, e),
  };
}
