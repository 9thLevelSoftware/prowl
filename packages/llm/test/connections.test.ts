import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jh-llm-"));
process.env.JH_DATA_DIR = tmp;
process.env.JH_SECRETS_NO_KEYCHAIN = "1";
process.env.JH_CATALOG_OFFLINE = "1";
delete process.env.JH_LLM_PROVIDER;

/* ------------------------------ mock servers ----------------------------- */

interface Captured {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
const captured: Captured[] = [];
let refreshCount = 0;
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body: any = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const url = new URL(req.url!, "http://x");
    captured.push({ path: url.pathname, headers: req.headers, body });
    const json = (code: number, j: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(j));

    if (url.pathname === "/oauth/token") {
      if (body.grant_type === "authorization_code") {
        if (body.code !== "good-code" || !body.code_verifier) return json(400, { error: "invalid_grant" });
        return json(200, {
          id_token: jwt({ email: "sam@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "plus" } }),
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, n: 1 }),
          refresh_token: "refresh-1",
        });
      }
      refreshCount++;
      if (body.refresh_token === "revoked") return json(400, { error: "invalid_grant", error_description: "refresh token revoked" });
      return json(200, { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, n: 2 }), refresh_token: `refresh-${refreshCount + 1}` });
    }
    if (url.pathname === "/codex/models") {
      // Like the real backend: an outdated client_version only gets hidden internal models.
      const hiddenOnly = [{ slug: "hidden-model", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [] }];
      if (url.searchParams.get("client_version") !== "99.0.0") return json(200, { models: hiddenOnly });
      return json(200, {
        models: [
          { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }], default_reasoning_level: "medium" },
          { slug: "hidden-model", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [] },
        ],
      });
    }
    if (url.pathname === "/google/token") {
      if (body.grant_type === "authorization_code") {
        if (body.code !== "g-code" || body.client_secret !== "g-secret" || !body.code_verifier) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: "g-access-1", refresh_token: "g-refresh", expires_in: 3599, id_token: jwt({ email: "sam@gmail.com" }) });
      }
      return json(200, { access_token: "g-access-2", expires_in: 3599 });
    }
    if (url.pathname === "/gemini/models") {
      return json(200, {
        models: [
          { name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"], thinking: true },
          { name: "models/text-embedding-005", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
        ],
      });
    }
    if (url.pathname === "/compat/models") return json(200, { data: [{ id: "gpt-5.6-luna" }, { id: "text-embedding-3-small" }, { id: "plain-mock" }] });
    if (url.pathname === "/compat/chat/completions") {
      return json(200, { id: "c1", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
    }
    // Everything else (Responses, Gemini generateContent): record the request and refuse it.
    return json(400, { error: { message: "mock refuses", type: "invalid_request_error" } });
  });
});

let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JH_OPENAI_AUTH_BASE = base;
  process.env.JH_CHATGPT_BASE_URL = `${base}/codex`;
  // A free port for the ChatGPT callback so the test never collides with a real `codex login`.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  process.env.JH_OPENAI_OAUTH_PORT = String((probe.address() as AddressInfo).port);
  await new Promise((r) => probe.close(r));
});
afterAll(() => server.close());

const load = async () => {
  const db = await import("@jh/db");
  const llm = await import("../src");
  const database = db.openDb(path.join(tmp, "llm.sqlite"));
  db.runMigrations(database);
  return { db, llm, database };
};

/* --------------------------------- tests --------------------------------- */

describe("effort resolution", () => {
  it("uses catalog effort values, toggles, budgets, and SDK defaults", async () => {
    const { llm } = await load();
    expect(llm.effortInfo("openai", "x", { id: "x", name: "x", reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "low", "high", "xhigh"] }] })).toEqual({
      effortKind: "effort",
      efforts: ["none", "low", "high", "xhigh"],
      defaultEffort: "high",
    });
    expect(llm.effortInfo("google", "g", { id: "g", name: "g", reasoning: true, reasoning_options: [{ type: "toggle" }] }).efforts).toEqual(["off", "on"]);
    expect(llm.effortInfo("anthropic", "c", { id: "c", name: "c", reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "budget_tokens" }] }).effortKind).toBe("budget");
    expect(llm.effortInfo("openai", "gpt-4o", { id: "gpt-4o", name: "4o", reasoning: false }).efforts).toEqual([]);
    expect(llm.effortInfo("openai-chatgpt", "gpt-5.9-new").efforts).toContain("high");
  });

  it("maps effort to provider options for each SDK", async () => {
    const { llm } = await load();
    expect(llm.providerOptionsFor("openai", "effort", "xhigh")).toEqual({ openai: { reasoningEffort: "xhigh" } });
    expect(llm.providerOptionsFor("anthropic", "effort", "max")).toEqual({ anthropic: { effort: "max" } });
    expect(llm.providerOptionsFor("anthropic", "budget", "off")).toEqual({ anthropic: { thinking: { type: "disabled" } } });
    expect(llm.providerOptionsFor("google", "effort", "xhigh")).toEqual({ google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: false } } });
    expect(llm.providerOptionsFor("google", "budget", "low")).toEqual({ google: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: false } } });
    expect(llm.providerOptionsFor("openai-compatible", "effort", "high")).toEqual({ compatible: { reasoningEffort: "high" } });
    expect(llm.providerOptionsFor("openai", "none", "high")).toBeUndefined();
  });

  it("rewrites ChatGPT backend bodies with instructions, store=false, stream, and reasoning effort", async () => {
    const { llm } = await load();
    const out = JSON.parse(llm.chatgptBodyRewrite(JSON.stringify({ input: [{ role: "system", content: "Be brief" }, { role: "user", content: "hi" }], max_output_tokens: 10 }), "xhigh")!);
    expect(out).toMatchObject({ instructions: "Be brief", store: false, stream: true, reasoning: { effort: "xhigh", summary: "auto" } });
    expect(out.input).toEqual([{ role: "user", content: "hi" }]);
    expect(out.max_output_tokens).toBeUndefined();
  });
});

describe("automatic effort", () => {
  it("picks effort per task and maps it onto each model's own levels", async () => {
    const { llm } = await load();
    const luna = ["low", "medium", "high", "xhigh", "max"];
    expect(llm.pickEffort(luna, llm.effortForTask("extract_profile"))).toBe("low");
    expect(llm.pickEffort(luna, llm.effortForTask("cover_letter"))).toBe("medium");
    expect(llm.pickEffort(luna, llm.effortForTask("tailor"))).toBe("high");
    expect(llm.pickEffort(luna, llm.effortForTask("audit_resume"))).toBe("high");
    expect(llm.pickEffort(["off", "on"], "low")).toBe("on");
    expect(llm.pickEffort(["minimal", "high"], "low")).toBe("minimal");
    expect(llm.pickEffort(["none", "high", "max"], "medium")).toBe("high");
    expect(llm.pickEffort([], "high")).toBeNull();
    expect(llm.effortForTask("something_new")).toBe("medium");

    const conn = { sdk: "openai-chatgpt", kind: "openai-chatgpt", label: "c", catalogProviderId: "openai", selections: { main: { model: "gpt-5.6-luna", effort: "auto" }, fast: null, effortByModel: {} }, modelsCache: [{ id: "gpt-5.6-luna", name: "Luna", contextWindow: null, reasoning: true, effortKind: "effort", efforts: luna, defaultEffort: "medium", costIn: null, costOut: null, costCachedIn: null, source: "live" }] } as any;
    const sel = llm.resolveSelection(conn, "main");
    expect(sel.effort).toBe("auto");
    expect(llm.effectiveEffort(sel, "extract_requirements")).toBe("low");
    expect(llm.effectiveEffort(sel, "tailor")).toBe("high");
    // An explicit choice is used for every task; a never-set effort means Automatic.
    expect(llm.effectiveEffort(llm.resolveSelection({ ...conn, selections: { ...conn.selections, main: { model: "gpt-5.6-luna", effort: "xhigh" } } }, "main"), "extract_profile")).toBe("xhigh");
    expect(llm.resolveSelection({ ...conn, selections: { ...conn.selections, main: { model: "gpt-5.6-luna", effort: null } } }, "main").effort).toBe("auto");
  });
});

describe("catalog", () => {
  it("resolves provider support from the bundled snapshot", async () => {
    const { llm } = await load();
    const providers = llm.listProviders();
    expect(providers.length).toBeGreaterThan(100);
    const by = Object.fromEntries(providers.map((p) => [p.id, p]));
    expect(by.openai).toMatchObject({ supported: true, sdk: "openai" });
    expect(by.anthropic).toMatchObject({ supported: true, sdk: "anthropic" });
    expect(by.groq).toMatchObject({ supported: true, sdk: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" });
    expect(by["amazon-bedrock"]?.supported).toBe(false);
    expect(llm.findCatalogModel("openai", "gpt-5.6-luna")?.reasoning).toBe(true);
  });
});

describe("secrets", () => {
  it("round-trips encrypted values and never writes plaintext", async () => {
    const { llm } = await load();
    await llm.setSecret("conn-a", "api_key", "sk-test-1234567890");
    expect(await llm.getSecret("conn-a", "api_key")).toBe("sk-test-1234567890");
    expect(fs.readFileSync(path.join(tmp, "secrets.json"), "utf8")).not.toContain("sk-test");
    expect(await llm.keyStorage()).toBe("file");
    await llm.deleteSecrets("conn-a");
    expect(await llm.getSecret("conn-a", "api_key")).toBeNull();
    expect(llm.maskKey("sk-proj-abcdefghijkl9876")).toBe("sk-…9876");
  });
});

describe("selection memory", () => {
  it("restores each connection's model and effort, and effort per model", async () => {
    const { db, database } = await load();
    const a = db.createConnection(database, { kind: "openai-chatgpt", sdk: "openai-chatgpt", label: "ChatGPT", authType: "oauth" });
    const b = db.createConnection(database, { kind: "api-key", sdk: "anthropic", label: "Anthropic", authType: "api_key" });
    db.saveSelection(database, a.id, "main", "gpt-5.6-luna", "xhigh");
    db.saveSelection(database, b.id, "main", "claude-opus-5", "high");
    db.saveSelection(database, a.id, "main", "gpt-5.6-sol", "low");
    db.saveSelection(database, a.id, "main", "gpt-5.6-luna", "xhigh");
    expect(db.getConnection(database, a.id)!.selections).toMatchObject({ main: { model: "gpt-5.6-luna", effort: "xhigh" }, effortByModel: { "gpt-5.6-luna": "xhigh", "gpt-5.6-sol": "low" } });
    expect(db.getConnection(database, b.id)!.selections.main).toEqual({ model: "claude-opus-5", effort: "high" });
    db.setActiveConnection(database, b.id);
    expect(db.getActiveConnection(database)!.id).toBe(b.id);
    db.deleteConnectionRow(database, b.id);
    expect(db.getActiveConnection(database)!.id).toBe(a.id);
  });
});

describe("ChatGPT sign-in", () => {
  it("completes PKCE sign-in, lists models with efforts, refreshes tokens, and flags revoked sign-ins", async () => {
    const { db, llm, database } = await load();
    const before = db.listConnections(database).length;
    const start = await llm.startOpenAiSignIn(database);
    expect(start.connectionId).toBeNull();
    const auth = new URL(start.authorizeUrl);
    expect(auth.origin + auth.pathname).toBe(`${base}/oauth/authorize`);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    const redirect = new URL(auth.searchParams.get("redirect_uri")!);

    // Wrong state is rejected.
    const bad = await fetch(`${redirect}?code=good-code&state=nope`);
    expect(bad.status).toBe(400);
    expect(llm.getFlow(start.flowId)!.status).toBe("error");
    // An abandoned or failed sign-in leaves no connection behind.
    expect(db.listConnections(database).length).toBe(before);

    // A fresh flow with the right state succeeds and creates the connection.
    const retry = await llm.startOpenAiSignIn(database);
    const u = new URL(retry.authorizeUrl);
    const ok = await fetch(`${u.searchParams.get("redirect_uri")}?code=good-code&state=${u.searchParams.get("state")}`);
    expect(ok.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(llm.getFlow(retry.flowId)!.status).toBe("done");

    const conn = db.getConnection(database, llm.getFlow(retry.flowId)!.connectionId)!;
    expect(conn).toMatchObject({ status: "ok", accountId: "acct_123", accountLabel: "sam@example.com · Plus" });
    const firstToken = await llm.getSecret(conn.id, "access_token");
    expect(firstToken).toBeTruthy();

    const { models, error } = await llm.refreshModels(database, conn);
    expect(error).toBeNull();
    expect(models.map((m) => m.id)).toEqual(["gpt-5.6-luna"]);
    expect(models[0]).toMatchObject({ efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", source: "live" });
    const modelsReq = captured.filter((c) => c.path === "/codex/models").at(-1)!;
    expect(modelsReq.headers["chatgpt-account-id"]).toBe("acct_123");

    // Expired token triggers a refresh; refresh tokens rotate.
    db.updateConnection(database, conn.id, { tokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const refreshed = await llm.getAccessToken(database, conn.id);
    expect(refreshed).not.toBe(firstToken);
    expect(await llm.getSecret(conn.id, "refresh_token")).toBe("refresh-2");

    // A revoked refresh token marks the connection as needing sign-in.
    await llm.setSecret(conn.id, "refresh_token", "revoked");
    await expect(llm.getAccessToken(database, conn.id, { force: true })).rejects.toThrow(/Sign in again/);
    expect(db.getConnection(database, conn.id)!.status).toBe("needs_signin");
  });
});

describe("Gemini Google sign-in", () => {
  it("creates the connection only after sign-in, then lists models with the project header", async () => {
    process.env.JH_GOOGLE_TOKEN_URL = `${base}/google/token`;
    process.env.JH_GOOGLE_AUTH_URL = `${base}/google/auth`;
    const { db, llm, database } = await load();
    const before = db.listConnections(database).length;
    const start = await llm.startGoogleSignIn(database, { clientId: "1-abc.apps.googleusercontent.com", clientSecret: "g-secret", project: "my-proj" });
    const u = new URL(start.authorizeUrl);
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/cloud-platform");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(db.listConnections(database).length).toBe(before);

    const res = await fetch(`${u.searchParams.get("redirect_uri")}?code=g-code&state=${u.searchParams.get("state")}`);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const flow = llm.getFlow(start.flowId)!;
    expect(flow.status).toBe("done");
    let conn = db.getConnection(database, flow.connectionId)!;
    expect(conn).toMatchObject({ kind: "gemini-oauth", status: "ok", accountLabel: "sam@gmail.com", googleProject: "my-proj" });
    expect(await llm.getSecret(conn.id, "client_secret")).toBe("g-secret");

    conn = db.updateConnection(database, conn.id, { baseUrl: `${base}/gemini` });
    const { models, error } = await llm.refreshModels(database, conn);
    expect(error).toBeNull();
    expect(models.map((m) => m.id)).toEqual(["gemini-3-pro"]);
    expect(models[0]!.efforts.length).toBeGreaterThan(0);
    const req = captured.filter((c) => c.path === "/gemini/models").at(-1)!;
    expect(req.headers.authorization).toBe("Bearer g-access-1");
    expect(req.headers["x-goog-user-project"]).toBe("my-proj");

    db.updateConnection(database, conn.id, { tokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await llm.getAccessToken(database, conn.id)).toBe("g-access-2");
    expect(await llm.getSecret(conn.id, "refresh_token")).toBe("g-refresh");
  });
});

describe("requests carry the chosen model and effort", () => {
  it("OpenAI-compatible: lists chat models, generates with reasoning_effort", async () => {
    const { db, llm, database } = await load();
    const conn = db.createConnection(database, { kind: "openai-compatible", sdk: "openai-compatible", label: "Mock", authType: "api_key", baseUrl: `${base}/compat` });
    await llm.setSecret(conn.id, "api_key", "mock-key");
    const { models } = await llm.refreshModels(database, conn);
    expect(models.map((m) => m.id).sort()).toEqual(["gpt-5.6-luna", "plain-mock"]);
    // Efforts come from catalog metadata for known model ids, even on third-party endpoints.
    expect(models.find((m) => m.id === "gpt-5.6-luna")!.efforts).toContain("xhigh");
    expect(models.find((m) => m.id === "plain-mock")!.efforts).toEqual([]);
    db.saveSelection(database, conn.id, "main", "gpt-5.6-luna", "xhigh");
    db.saveSelection(database, conn.id, "fast", "gpt-5.6-luna", "xhigh");
    db.setActiveConnection(database, conn.id);

    const client = new llm.LlmClient(database);
    const test = await client.testConnection(db.getConnection(database, conn.id)!);
    expect(test).toMatchObject({ ok: true, model: "gpt-5.6-luna", reply: "pong" });
    const req = captured.filter((c) => c.path === "/compat/chat/completions").at(-1)!;
    expect(req.body).toMatchObject({ model: "gpt-5.6-luna", reasoning_effort: "xhigh" });
    expect(req.headers.authorization).toBe("Bearer mock-key");
    expect(client.config).toMatchObject({ smartModel: "gpt-5.6-luna", smartEffort: "xhigh" });

    const call = database.select().from(db.schema.llmCalls).all().at(-1)!;
    expect(call.model).toBe("gpt-5.6-luna (xhigh)");
  });

  it("ChatGPT backend and Gemini receive effort in their native request shape", async () => {
    const { db, llm, database } = await load();
    const chat = db.listConnections(database).find((c) => c.accountId === "acct_123")!;
    await llm.setSecret(chat.id, "refresh_token", "refresh-ok");
    db.updateConnection(database, chat.id, { status: "ok", modelsCache: [{ id: "gpt-5.6-luna", name: "Luna", contextWindow: null, reasoning: true, effortKind: "effort", efforts: ["low", "xhigh"], defaultEffort: "low", costIn: null, costOut: null, costCachedIn: null, source: "live" }] });
    db.saveSelection(database, chat.id, "main", "gpt-5.6-luna", "xhigh");
    const sel = llm.resolveSelection(db.getConnection(database, chat.id)!, "main");
    const built = await llm.buildModel(database, db.getConnection(database, chat.id)!, sel, "smart");
    const { generateText } = await import("ai");
    await generateText({ model: built.model, prompt: "hi", providerOptions: built.providerOptions as any, maxRetries: 0 }).catch(() => undefined);
    const resp = captured.filter((c) => c.path === "/codex/responses").at(-1)!;
    expect(resp.body).toMatchObject({ model: "gpt-5.6-luna", store: false, stream: true, reasoning: { effort: "xhigh" } });
    expect(resp.headers["chatgpt-account-id"]).toBe("acct_123");

    const gem = db.createConnection(database, { kind: "api-key", sdk: "google", catalogProviderId: "google", label: "Gemini", authType: "api_key", baseUrl: `${base}/gemini` });
    await llm.setSecret(gem.id, "api_key", "g-key");
    const gsel = { model: "gemini-mock", effort: "low", effortKind: "effort" as const, info: null };
    const gbuilt = await llm.buildModel(database, gem, gsel, "smart");
    await generateText({ model: gbuilt.model, prompt: "hi", providerOptions: gbuilt.providerOptions as any, maxRetries: 0 }).catch(() => undefined);
    const greq = captured.filter((c) => c.path.startsWith("/gemini/models/gemini-mock")).at(-1)!;
    expect(greq.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: false });
  });
});
