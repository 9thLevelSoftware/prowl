import type { AtsType } from "@jh/shared";

/** Identify the ATS behind a URL, and the board identifier where it can be derived. */
export function detectAts(url: string): { ats: AtsType; board?: string; jobId?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ats: "other" };
  }
  const host = u.host.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  if (host.endsWith("greenhouse.io")) {
    // boards.greenhouse.io/{token}/jobs/{id}, job-boards.greenhouse.io/{token}/jobs/{id}, boards.greenhouse.io/embed/job_app?for={token}&token={id}
    if (parts[0] === "embed") return { ats: "greenhouse", board: u.searchParams.get("for") ?? undefined, jobId: u.searchParams.get("token") ?? undefined };
    return { ats: "greenhouse", board: parts[0], jobId: parts[1] === "jobs" ? parts[2] : undefined };
  }
  if (u.searchParams.get("gh_jid")) return { ats: "greenhouse", jobId: u.searchParams.get("gh_jid") ?? undefined };
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return { ats: "lever", board: parts[0], jobId: parts[1] };
  if (host === "jobs.ashbyhq.com") return { ats: "ashby", board: parts[0], jobId: parts[1] };
  if (host.endsWith("myworkdayjobs.com") || host.endsWith("myworkdaysite.com")) return { ats: "workday" };
  if (host.endsWith("smartrecruiters.com")) return { ats: "smartrecruiters", board: parts[0] };
  if (host.endsWith("linkedin.com")) return { ats: "linkedin" };
  if (host.endsWith("indeed.com")) return { ats: "indeed" };
  return { ats: "other" };
}

/** Find embedded ATS boards in a career page's HTML. */
export function findEmbeddedBoards(html: string): { type: "greenhouse" | "lever" | "ashby"; token: string }[] {
  const found = new Map<string, { type: "greenhouse" | "lever" | "ashby"; token: string }>();
  const add = (type: "greenhouse" | "lever" | "ashby", token: string | undefined) => {
    if (!token || /^(embed|jobs|js|api|v\d)$/i.test(token)) return;
    found.set(`${type}:${token.toLowerCase()}`, { type, token });
  };
  for (const m of html.matchAll(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9_-]+)/g)) add("greenhouse", m[1]);
  for (const m of html.matchAll(/boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/g)) add("greenhouse", m[1]);
  for (const m of html.matchAll(/jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9_-]+)/g)) add("lever", m[1]);
  for (const m of html.matchAll(/api\.lever\.co\/v0\/postings\/([A-Za-z0-9_-]+)/g)) add("lever", m[1]);
  for (const m of html.matchAll(/jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/g)) add("ashby", m[1]);
  return [...found.values()];
}
