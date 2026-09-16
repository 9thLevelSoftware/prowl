import { WORKER_URL } from "@jh/shared";

export const dynamic = "force-dynamic";

/** Proxy the worker's server-sent events so the browser only talks to the web origin. */
export async function GET(req: Request) {
  try {
    const upstream = await fetch(`${WORKER_URL}/events`, { signal: req.signal, cache: "no-store" });
    if (!upstream.ok || !upstream.body) return new Response("worker unavailable", { status: 503 });
    return new Response(upstream.body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
    });
  } catch {
    return new Response("worker unavailable", { status: 503 });
  }
}
