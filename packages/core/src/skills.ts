import { normalizeText, type Skill } from "@jh/shared";

/**
 * Small built-in synonym table. Used to (a) match job requirements to profile skills and
 * (b) let tailoring use the posting's exact spelling for a skill the user genuinely has.
 * Each group lists equivalent spellings; the first entry is the canonical form.
 */
const GROUPS: string[][] = [
  ["JavaScript", "JS", "ECMAScript"],
  ["TypeScript", "TS"],
  ["Node.js", "Node", "NodeJS"],
  ["React", "React.js", "ReactJS"],
  ["Next.js", "NextJS", "Next"],
  ["Vue.js", "Vue", "VueJS"],
  ["Angular", "AngularJS"],
  ["Kubernetes", "K8s", "k8s"],
  ["Amazon Web Services", "AWS"],
  ["Google Cloud Platform", "GCP", "Google Cloud"],
  ["Microsoft Azure", "Azure"],
  ["PostgreSQL", "Postgres", "psql"],
  ["Microsoft SQL Server", "MSSQL", "SQL Server"],
  ["MongoDB", "Mongo"],
  ["Continuous Integration/Continuous Delivery", "CI/CD", "CICD", "CI CD"],
  ["Machine Learning", "ML"],
  ["Artificial Intelligence", "AI"],
  ["Large Language Models", "LLM", "LLMs"],
  ["Natural Language Processing", "NLP"],
  ["Python", "Python3", "Python 3"],
  ["C#", "CSharp", "C Sharp"],
  ["C++", "CPP"],
  ["Go", "Golang"],
  ["Infrastructure as Code", "IaC"],
  ["Terraform", "HashiCorp Terraform"],
  ["REST APIs", "REST", "RESTful APIs", "RESTful"],
  ["GraphQL", "GQL"],
  ["User Experience", "UX"],
  ["User Interface", "UI"],
  ["Search Engine Optimization", "SEO"],
  ["Customer Relationship Management", "CRM"],
  ["Salesforce", "SFDC"],
  ["Project Management Professional", "PMP"],
  ["Certified Information Systems Security Professional", "CISSP"],
  ["Agile", "Agile methodologies", "Scrum", "Agile/Scrum"],
  ["Microsoft Excel", "Excel", "MS Excel"],
  ["Power BI", "PowerBI", "Microsoft Power BI"],
  ["Extract, Transform, Load", "ETL"],
  ["Site Reliability Engineering", "SRE"],
  ["Quality Assurance", "QA"],
  ["Software Development Life Cycle", "SDLC"],
  ["Key Performance Indicators", "KPIs", "KPI"],
  ["Objectives and Key Results", "OKRs", "OKR"],
  ["Docker", "Docker containers", "containerization"],
  ["Git", "GitHub", "GitLab"],
];

const index = new Map<string, string[]>();
for (const g of GROUPS) for (const term of g) index.set(normalizeText(term), g);

export function equivalents(term: string): string[] {
  const g = index.get(normalizeText(term));
  return g ?? [term];
}

export function termsEquivalent(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ga = index.get(na);
  return !!ga && ga.some((t) => normalizeText(t) === nb);
}

/** Every spelling a profile skill is known by: name, user aliases, and built-in synonyms. */
export function skillSpellings(s: Skill): string[] {
  const out = new Set<string>();
  for (const t of [s.name, ...s.aliases]) for (const e of equivalents(t)) out.add(e);
  return [...out];
}

/** Find the profile skill (if any) that satisfies a requirement term. */
export function findSkill(skills: Skill[], term: string): Skill | undefined {
  const nt = normalizeText(term);
  if (!nt) return undefined;
  for (const s of skills) {
    for (const sp of skillSpellings(s)) {
      const ns = normalizeText(sp);
      if (ns === nt || termsEquivalent(sp, term)) return s;
      // Multi-word requirement containing the exact skill as a whole word ("experience with Kubernetes").
      if (ns.length >= 3 && new RegExp(`(^| )${escapeRe(ns)}( |$)`).test(nt)) return s;
    }
  }
  return undefined;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does the text mention the term (or an equivalent) as a whole word? */
export function textMentions(text: string, term: string): boolean {
  const nt = normalizeText(text);
  return equivalents(term).some((t) => {
    const n = normalizeText(t);
    return n.length > 0 && new RegExp(`(^| )${escapeRe(n)}( |$)`).test(nt);
  });
}
