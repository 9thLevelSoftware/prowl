import { normalizeText } from "./text";

const STOP = new Set(["the", "and", "of", "for", "to", "in", "a", "an", "&"]);
/** Level words vary between employers for the same job, so they never have to match. */
const LEVEL = new Set(["senior", "junior", "lead", "staff", "principal", "i", "ii", "iii", "iv", "sr", "jr"]);
/** Role words that only mean something next to a function ("Head of Product", "Product Manager"). */
const ROLE = new Set(["head", "manager", "associate", "director", "vp", "svp", "evp", "avp", "chief", "president", "officer"]);

function words(text: string): string[] {
  return normalizeText(text)
    .replace(/senior vice president/g, "svp")
    .replace(/executive vice president/g, "evp")
    .replace(/vice president/g, "vp")
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
}

function hasWord(titleWords: Set<string>, term: string): boolean {
  if (titleWords.has(term) || titleWords.has(`${term}s`) || (term.endsWith("s") && titleWords.has(term.slice(0, -1)))) return true;
  // A VP target also fits SVP and EVP titles.
  return term === "vp" && (titleWords.has("svp") || titleWords.has("evp"));
}

/** The words of a target title that a job title must contain. */
export function titleTerms(target: string): string[] {
  const ws = words(target).filter((w) => !STOP.has(w));
  const core = ws.filter((w) => !LEVEL.has(w) && !ROLE.has(w));
  // "Head of Product" without its role word would match every product title.
  return core.length >= 2 ? core : ws.filter((w) => !LEVEL.has(w));
}

/** Keywords match on their own, so a bare role or level word ("head", "vp") is too broad to use. */
export function usableKeywords(keywords: string[]): string[][] {
  return keywords
    .map((k) => words(k).filter((w) => !STOP.has(w)))
    .filter((ws) => ws.length > 1 || (ws.length === 1 && ws[0]!.length > 2 && !LEVEL.has(ws[0]!) && !ROLE.has(ws[0]!)));
}

/**
 * Job functions that turn a matching title into a different job: "Head of Product Marketing" is a
 * marketing role, not a product role. A function counts only when no target title or keyword mentions it.
 */
const FUNCTIONS: string[][] = [
  ["marketing", "marketer"],
  ["legal", "counsel", "attorney", "paralegal", "lawyer"],
  ["design", "designer"],
  ["sales", "seller"],
  ["recruiter", "recruiting", "talent"],
  ["accountant", "accounting", "tax", "audit", "auditor", "controller"],
  ["engineer", "engineering", "developer"],
  ["support"],
];

function otherFunction(titleWords: Set<string>, targetWords: Set<string>): boolean {
  return FUNCTIONS.some((group) => group.some((w) => titleWords.has(w)) && !group.some((w) => targetWords.has(w)));
}

/** 2 = contains a whole target title, 1 = contains a keyword, 0 = no match. */
export function titleMatchStrength(title: string, prefs: { targetTitles: string[]; keywords: string[] }): number {
  const tw = new Set(words(title));
  const targetWords = new Set([...prefs.targetTitles, ...prefs.keywords].flatMap(words));
  // Keywords alone don't say which function the candidate works in, so the check needs target titles.
  if (prefs.targetTitles.length && otherFunction(tw, targetWords)) return 0;
  if (prefs.targetTitles.some((t) => {
    const terms = titleTerms(t);
    return terms.length > 0 && terms.every((w) => hasWord(tw, w));
  })) return 2;
  if (usableKeywords(prefs.keywords).some((ws) => ws.every((w) => hasWord(tw, w)))) return 1;
  return 0;
}

