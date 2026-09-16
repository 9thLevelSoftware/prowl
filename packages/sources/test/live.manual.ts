import { ADAPTERS } from "@jh/sources";
import { Preferences } from "@jh/shared";
const prefs = Preferences.parse({ targetTitles: ["Software Engineer"] });
const ctx = { prefs, progress: (m: string) => console.log("  ·", m) };
for (const [type, cfg] of [["greenhouse", { boardToken: "stripe", companyName: "Stripe" }], ["lever", { company: "palantir", companyName: "Palantir" }], ["ashby", { org: "ramp", companyName: "Ramp" }]] as const) {
  const a = ADAPTERS[type];
  const r = await a.discover(a.validate(cfg as any), ctx);
  const j = r.jobs[0]!;
  console.log(type, "jobs:", r.jobs.length, "| sample:", j.title, "|", j.location, "|", j.applyUrl, "| desc chars:", j.descriptionText.length, "| salary:", j.salaryMin, j.salaryMax);
}
