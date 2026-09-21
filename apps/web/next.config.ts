import type { NextConfig } from "next";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

// One .env at the repository root serves both the web app and the worker.
loadEnvConfig(path.join(process.cwd(), "../.."));

const config: NextConfig = {
  // A second dev server (for example against demo data) needs its own build folder.
  distDir: process.env.PROWL_NEXT_DIST_DIR || ".next",
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@prowl/shared", "@prowl/db", "@prowl/core", "@prowl/documents", "@prowl/llm", "@prowl/sources"],
  // Native and very large server-only deps must not be bundled.
  serverExternalPackages: ["better-sqlite3", "@napi-rs/keyring", "playwright", "playwright-core", "@huggingface/transformers", "onnxruntime-node", "sharp", "unpdf", "mammoth", "docx", "cheerio", "robots-parser"],
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  experimental: {
    serverActions: { bodySizeLimit: "15mb" },
  },
  devIndicators: false,
  // Local-only app: typecheck runs separately via `pnpm typecheck`.
  typescript: { ignoreBuildErrors: false },
};

export default config;
