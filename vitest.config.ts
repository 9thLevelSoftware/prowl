import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/worker/test/**/*.test.ts"],
    exclude: ["**/*.golden.test.ts", "**/node_modules/**"],
    environment: "node",
    testTimeout: 60_000,
    env: { PROWL_EMBED_DISABLE: "1", PROWL_LOG_LEVEL: "warn" },
  },
});
