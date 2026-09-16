import type { SourceType } from "@jh/shared";
import type { SourceAdapter } from "./types";
import { greenhouse } from "./adapters/greenhouse";
import { lever } from "./adapters/lever";
import { ashby } from "./adapters/ashby";
import { adzuna } from "./adapters/adzuna";
import { careerpage } from "./adapters/careerpage";
import { linkedin, indeed } from "./adapters/browserboards";

export const ADAPTERS: Record<SourceType, SourceAdapter<any>> = {
  greenhouse,
  lever,
  ashby,
  adzuna,
  careerpage,
  linkedin,
  indeed,
};

export function getAdapter(type: SourceType): SourceAdapter<any> {
  const a = ADAPTERS[type];
  if (!a) throw new Error(`Unknown source type: ${type}`);
  return a;
}

export * from "./types";
export * from "./ats";
export * from "./filter";
export * from "./resolve";
export { greenhouseApplyUrl } from "./adapters/greenhouse";
export * from "./builder";
export * from "./web/firecrawl";
export * from "./web/search";
