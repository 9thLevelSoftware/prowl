import { dataPath, logger, normalizeText } from "@prowl/shared";

const log = logger("embed");

/**
 * Semantic similarity for matching and tailoring metrics.
 * Default: a small local sentence-embedding model (no API calls, no cost).
 * Fallback: TF-IDF cosine, used when the model cannot load (offline first run, unsupported CPU).
 */

type Extractor = (texts: string | string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

const MODEL_ID = process.env.PROWL_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
let extractorPromise: Promise<Extractor | null> | undefined;

async function getExtractor(): Promise<Extractor | null> {
  if (process.env.PROWL_EMBED_DISABLE === "1") return null;
  extractorPromise ??= (async () => {
    try {
      const t = await import("@huggingface/transformers");
      t.env.cacheDir = dataPath("models", ".keep").replace(/[\\/]\.keep$/, "");
      const pipe = await t.pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
      log.info(`loaded embedding model ${MODEL_ID}`);
      return pipe as unknown as Extractor;
    } catch (err) {
      log.warn(`embedding model unavailable, falling back to TF-IDF: ${(err as Error).message}`);
      return null;
    }
  })();
  return extractorPromise;
}

/** Chunk long text so the 256-token model window does not silently truncate it. */
function chunks(text: string, maxWords = 180): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) out.push(words.slice(i, i + maxWords).join(" "));
  return out.length ? out : [""];
}

function mean(vectors: number[][]): number[] {
  const dim = vectors[0]?.length ?? 0;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i]! += v[i]! / vectors.length;
  const norm = Math.sqrt(out.reduce((a, x) => a + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const STOP = new Set(
  "a an the and or of to in for on with at by from as is are be was were this that these those you your we our will can able using use including etc".split(" "),
);

function tokens(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function tfidfSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const df = new Map<string, number>();
  for (const t of new Set(ta)) df.set(t, (df.get(t) ?? 0) + 1);
  for (const t of new Set(tb)) df.set(t, (df.get(t) ?? 0) + 1);
  const vocab = [...df.keys()];
  const vec = (ts: string[]) => {
    const tf = new Map<string, number>();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    return vocab.map((t) => (tf.get(t) ?? 0) * Math.log(1 + 2 / (df.get(t) ?? 1)));
  };
  return cosine(vec(ta), vec(tb));
}

const cache = new Map<string, number[]>();

export async function embed(text: string): Promise<number[] | null> {
  const ex = await getExtractor();
  if (!ex) return null;
  const key = text.length > 200 ? `${text.length}:${text.slice(0, 100)}:${text.slice(-100)}` : text;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = await ex(chunks(text), { pooling: "mean", normalize: true });
  const v = mean(out.tolist());
  if (cache.size > 2000) cache.clear();
  cache.set(key, v);
  return v;
}

/** Similarity in [0, 1]. */
export async function semanticSimilarity(a: string, b: string): Promise<{ score: number; method: "embedding" | "tfidf" }> {
  const [va, vb] = await Promise.all([embed(a), embed(b)]);
  if (va && vb) {
    // MiniLM cosine for related professional text typically lands in 0.2-0.8; rescale to use the full range.
    const raw = cosine(va, vb);
    return { score: clamp01((raw - 0.15) / 0.65), method: "embedding" };
  }
  return { score: clamp01(tfidfSimilarity(a, b) * 1.6), method: "tfidf" };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
