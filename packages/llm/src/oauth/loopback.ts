import http from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackResult {
  code: string;
}

export interface LoopbackServer {
  redirectUri: string;
  /** Resolves with the authorization code once the browser returns; rejects on error or timeout. */
  result: Promise<LoopbackResult>;
  close: () => void;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f7f7f5;color:#1c1c1a}main{text-align:center;max-width:420px}h1{font-size:20px}</style></head><body><main><h1>${title}</h1><p>${body}</p></main><script>setTimeout(()=>window.close(),1500)</script></body></html>`;

/**
 * One-shot HTTP server on 127.0.0.1 that receives the OAuth redirect, checks `state`,
 * and hands back the code. It shuts itself down after the first callback or on timeout.
 */
export async function startLoopback(opts: {
  host?: "localhost" | "127.0.0.1";
  port: number;
  path: string;
  state: string;
  timeoutMs?: number;
  /** Runs after the code arrives; its error (if any) is shown on the callback page. */
  onCode: (code: string) => Promise<void>;
}): Promise<LoopbackServer> {
  let resolve!: (r: LoopbackResult) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<LoopbackResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  result.catch(() => undefined);

  let finished = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== opts.path) {
      res.writeHead(404).end();
      return;
    }
    if (finished) {
      res.writeHead(200, { "content-type": "text/html" }).end(page("Already handled", "You can close this tab."));
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    finished = true;
    try {
      if (error) throw new Error(url.searchParams.get("error_description") ?? error);
      if (!code) throw new Error("No authorization code was returned");
      if (state !== opts.state) throw new Error("Sign-in state did not match. Start the sign-in again.");
      await opts.onCode(code);
      res.writeHead(200, { "content-type": "text/html" }).end(page("Signed in", "Prowl is connected. You can close this tab."));
      resolve({ code });
    } catch (err) {
      res.writeHead(400, { "content-type": "text/html" }).end(page("Sign-in failed", String((err as Error).message).replace(/</g, "&lt;")));
      reject(err as Error);
    } finally {
      close();
    }
  });

  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      reject(new Error("Sign-in timed out. Start it again."));
      close();
    }
  }, opts.timeoutMs ?? 10 * 60_000);

  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((res, rej) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      rej(err.code === "EADDRINUSE" ? new Error(`Port ${opts.port} is in use. Close other sign-in windows or apps using it (for example a running \`codex login\`) and try again.`) : err),
    );
    server.listen(opts.port, host === "localhost" ? "127.0.0.1" : host, () => res());
  });
  const { port } = server.address() as AddressInfo;
  return { redirectUri: `http://${host}:${port}${opts.path}`, result, close };
}
