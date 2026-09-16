import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@jh/shared", "@jh/db", "@jh/core", "@jh/documents", "@jh/llm", "@jh/sources", "@jh/applier", "@jh/browser"],
  // Native and very large server-only deps must not be bundled.
  serverExternalPackages: ["better-sqlite3", "playwright", "playwright-core", "@huggingface/transformers", "onnxruntime-node", "sharp", "unpdf", "mammoth", "docx", "cheerio", "robots-parser"],
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  experimental: {
    serverActions: { bodySizeLimit: "15mb" },
  },
  devIndicators: false,
  // Local-only app: typecheck runs separately via `pnpm typecheck`.
  typescript: { ignoreBuildErrors: false },
};

export default config;
