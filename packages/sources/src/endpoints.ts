/** Public ATS API bases. Overridable so tests can point at local mocks. */
export const greenhouseApi = () => process.env.PROWL_GREENHOUSE_API ?? "https://boards-api.greenhouse.io/v1";
export const leverApi = (region: "global" | "eu" = "global") => process.env.PROWL_LEVER_API ?? (region === "eu" ? "https://api.eu.lever.co/v0" : "https://api.lever.co/v0");
export const ashbyApi = () => process.env.PROWL_ASHBY_API ?? "https://api.ashbyhq.com/posting-api";
