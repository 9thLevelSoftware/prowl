// Refresh the bundled provider/model catalog snapshot from models.dev.
// The app also refreshes a cached copy at runtime; this snapshot is the offline fallback.
//   node scripts/update-catalog.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const res = await fetch("https://models.dev/api.json");
if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
const raw = await res.json();

export function trimCatalog(j) {
  const out = {};
  for (const [id, p] of Object.entries(j)) {
    out[id] = { id, name: p.name, api: p.api, env: p.env, npm: p.npm, doc: p.doc, models: {} };
    for (const [mid, m] of Object.entries(p.models ?? {})) {
      out[id].models[mid] = {
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        reasoning_options: m.reasoning_options,
        context: m.limit?.context,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output, cache_read: m.cost.cache_read } : undefined,
        tool_call: m.tool_call,
        release_date: m.release_date,
      };
    }
  }
  return out;
}

const trimmed = trimCatalog(raw);
const gz = zlib.gzipSync(JSON.stringify(trimmed), { level: 9 });
fs.writeFileSync("packages/llm/catalog-snapshot.json.gz", gz);
console.log(`Wrote ${Object.keys(trimmed).length} providers, ${gz.length} bytes gzipped`);
