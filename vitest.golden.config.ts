import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.golden.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    fileParallelism: false,
    env: { PROWL_LOG_LEVEL: "warn" },
  },
});
