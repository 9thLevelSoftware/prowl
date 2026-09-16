import { normalizeText, type Preferences, type RawJob } from "@jh/shared";

const GENERIC = new Set(["senior", "junior", "lead", "staff", "principal", "head", "the", "and", "of", "for", "i", "ii", "iii", "sr", "jr", "manager", "associate"]);

/**
 * Cheap title/keyword prefilter applied before any LLM work. Company boards list every role
 * (engineering, legal, facilities...), so without this a single board could cost hundreds of calls.
 * With no target titles or keywords configured, everything passes.
 */
export function prefilter(jobs: RawJob[], prefs: Preferences): RawJob[] {
  const titleTerms = prefs.targetTitles
    .map((t) => normalizeText(t).split(" ").filter((w) => w.length > 1 && !GENERIC.has(w)))
    .filter((ws) => ws.length);
  const keywords = prefs.keywords.map(normalizeText).filter(Boolean);
  if (!titleTerms.length && !keywords.length) return jobs;
  return jobs.filter((j) => {
    const title = normalizeText(j.title);
    if (titleTerms.some((ws) => ws.every((w) => title.includes(w)))) return true;
    if (keywords.some((k) => title.includes(k))) return true;
    return false;
  });
}

export function parseSalaryText(text: string): { min: number | null; max: number | null } {
  const m = text.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)\s*([kK])?\s*[-–to]+\s*\$?\s*(\d+(?:\.\d+)?)\s*([kK])?/);
  if (!m) return { min: null, max: null };
  const val = (n: string, k?: string) => Number(n) * (k ? 1000 : 1);
  const min = val(m[1]!, m[2] ?? m[4]);
  const max = val(m[3]!, m[4]);
  return min > 1000 && max >= min ? { min, max } : { min: null, max: null };
}
