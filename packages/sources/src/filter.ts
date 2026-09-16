import { titleMatchStrength, titleTerms, usableKeywords, type Preferences, type RawJob } from "@jh/shared";

export { titleMatchStrength, titleTerms, usableKeywords };

/**
 * Cheap title/keyword prefilter applied before any LLM work. Company boards list every role
 * (engineering, legal, facilities...), so without this a single board could cost hundreds of calls.
 * With no usable target titles or keywords configured, everything passes.
 */
export function prefilter(jobs: RawJob[], prefs: Preferences): RawJob[] {
  const anyTargets = prefs.targetTitles.some((t) => titleTerms(t).length > 0) || usableKeywords(prefs.keywords).length > 0;
  if (!anyTargets) return jobs;
  return jobs.filter((j) => titleMatchStrength(j.title, prefs) > 0);
}

export function parseSalaryText(text: string): { min: number | null; max: number | null } {
  const m = text.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)\s*([kK])?\s*[-–to]+\s*\$?\s*(\d+(?:\.\d+)?)\s*([kK])?/);
  if (!m) return { min: null, max: null };
  const val = (n: string, k?: string) => Number(n) * (k ? 1000 : 1);
  const min = val(m[1]!, m[2] ?? m[4]);
  const max = val(m[3]!, m[4]);
  return min > 1000 && max >= min ? { min, max } : { min: null, max: null };
}
