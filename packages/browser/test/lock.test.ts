import { describe, expect, it } from "vitest";
import { withBrowserLock } from "../src/index";

/**
 * Lock-contract tests (C2-A05 / SEC-08 / PR 3).
 * Pure promise-chain serialization — no Chrome launch required.
 */
describe("withBrowserLock", () => {
  it("serializes concurrent locked work (login vs apply cannot overlap)", async () => {
    const order: string[] = [];
    const apply = withBrowserLock(async () => {
      order.push("apply:start");
      await new Promise((r) => setTimeout(r, 40));
      order.push("apply:end");
    });
    const login = withBrowserLock(async () => {
      order.push("login:start");
      order.push("login:end");
    });
    const discover = withBrowserLock(async () => {
      order.push("discover");
    });
    await Promise.all([apply, login, discover]);
    expect(order).toEqual(["apply:start", "apply:end", "login:start", "login:end", "discover"]);
  });

  it("returns the callback result and propagates errors", async () => {
    await expect(withBrowserLock(async () => "ok")).resolves.toBe("ok");
    await expect(
      withBrowserLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("continues the chain after a failed locked task", async () => {
    await expect(
      withBrowserLock(async () => {
        throw new Error("fail-first");
      }),
    ).rejects.toThrow("fail-first");
    const ran: string[] = [];
    await withBrowserLock(async () => {
      ran.push("second");
    });
    expect(ran).toEqual(["second"]);
  });

  it("openForLogin module documents lock usage without double-wrapping (source contract)", async () => {
    // openForLogin is locked internally; worker must call it directly (non-reentrant chain).
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"));
    expect(src).toMatch(/export async function openForLogin/);
    expect(src).toMatch(/return withBrowserLock\(/);
  });
});
