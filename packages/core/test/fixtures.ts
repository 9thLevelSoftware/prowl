import { ProfileData, type JobRequirements, type Preferences } from "@jh/shared";
import { Preferences as PrefSchema } from "@jh/shared";

export const profile: ProfileData = ProfileData.parse({
  contact: { fullName: "Jordan Rivera", email: "jordan@example.com", phone: "555-0100", location: "Austin, TX", links: [] },
  headline: "Backend Engineer",
  summary: "Backend engineer building payment APIs in TypeScript and Go.",
  work: [
    {
      id: "w1",
      company: "Paylane",
      title: "Senior Software Engineer",
      location: "Remote",
      startDate: "2021-03",
      endDate: "present",
      bullets: [
        "Built a TypeScript payments API handling 2M requests per day",
        "Cut p95 latency by 40% by moving hot paths to Go",
        "Mentored 3 engineers",
      ],
    },
    {
      id: "w2",
      company: "ShopCo",
      title: "Software Engineer",
      location: "Austin, TX",
      startDate: "2018-06",
      endDate: "2021-02",
      bullets: ["Maintained PostgreSQL schemas for order service", "Wrote CI pipelines in GitHub Actions"],
    },
  ],
  education: [{ id: "e1", institution: "UT Austin", degree: "BS", field: "Computer Science", startDate: "2014", endDate: "2018" }],
  skills: [
    { name: "TypeScript", category: "Languages", confirmed: true },
    { name: "Go", category: "Languages", confirmed: true },
    { name: "Postgres", category: "Data", confirmed: true },
    { name: "K8s", category: "Infra", confirmed: true },
    { name: "Rust", category: "Languages", confirmed: false },
  ],
  certifications: [{ name: "AWS Certified Developer", issuer: "Amazon", date: "2022" }],
});

export const requirements: JobRequirements = {
  roleSummary: "Backend engineer for payments platform",
  mustHaveSkills: ["TypeScript", "PostgreSQL", "Kubernetes"],
  niceToHaveSkills: ["Go", "Kafka"],
  minYearsExperience: 5,
  seniority: "senior",
  educationRequirements: [],
  certifications: [],
  remote: "remote",
  locationConstraints: [],
  workAuthorization: null,
  sponsorshipAvailable: null,
  industry: "Fintech",
  salaryMin: 150000,
  salaryMax: 190000,
  keyResponsibilities: ["Build payment APIs", "Improve reliability"],
  atsKeywords: ["TypeScript", "PostgreSQL", "Kubernetes", "Kafka"],
};

export const prefs: Preferences = PrefSchema.parse({
  targetTitles: ["Senior Backend Engineer"],
  remotePolicy: "remote_only",
  salaryFloor: 140000,
});
