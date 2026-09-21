import type { Db } from "@prowl/db";
import type { LlmClient } from "@prowl/llm";
import { logger } from "@prowl/shared";
import { Firecrawl } from "./firecrawl";

const log = logger("websearch");

export type SearchProvider = "native" | "firecrawl" | "none";

export interface WebSearch {
  provider: SearchProvider;
  /** Returns URLs found for the query. Results are leads and must be verified by the caller. */
  findUrls(query: string, purpose: string): Promise<string[]>;
}

/**
 * Pick the best available web search: the AI connection's built-in search tool, then a
 * Firecrawl server with search configured, else none.
 */
export async function getWebSearch(db: Db, llm: LlmClient): Promise<WebSearch> {
  if (llm.canSearchWeb()) {
    return {
      provider: "native",
      async findUrls(query, purpose) {
        const r = await llm.searchWeb(
          { task: "source_search" },
          `${purpose}\nSearch the web for: ${query}\nReply with a plain list of the exact URLs you found, one per line. Only include URLs that appeared in your search results.`,
        );
        return r.urls;
      },
    };
  }
  const fc = await Firecrawl.fromSettings(db);
  if (fc) {
    try {
      const probe = await fc.search("jobs", 1);
      if (probe.length) {
        return {
          provider: "firecrawl",
          async findUrls(query) {
            return (await fc.search(query, 20)).map((r) => r.url);
          },
        };
      }
    } catch (err) {
      log.info(`Firecrawl search not available: ${(err as Error).message}`);
    }
  }
  return { provider: "none", findUrls: async () => [] };
}
