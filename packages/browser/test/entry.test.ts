import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withBrowserLock } from "../src/index";

process.env.PROWL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-browser-pr8-"));

describe("browser entry (PR8 offline)", () => {
  it("exports lock helpers without launching Chrome", async () => {
    const mod = await import("../src/index");
    expect(typeof mod.withBrowserLock).toBe("function");
    expect(typeof mod.profileDir).toBe("function");
    expect(typeof mod.newPage).toBe("function");
    expect(typeof mod.closeContext).toBe("function");
    expect(mod.profileDir().includes(process.env.PROWL_DATA_DIR!)).toBe(true);
  });

  it("withBrowserLock still serializes after module load", async () => {
    const order: string[] = [];
    await Promise.all([
      withBrowserLock(async () => {
        order.push("a");
      }),
      withBrowserLock(async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a", "b"]);
  });
});
