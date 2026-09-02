import { randomUUID } from "node:crypto";

export type IdPrefix =
  | "camp"
  | "goal"
  | "obs"
  | "fact"
  | "step"
  | "run"
  | "inv"
  | "find"
  | "cov"
  | "art"
  | "evt"
  | "sub"
  | "dec"
  | "ver"
  | "snap"
  | "corr"
  | "lock"
  | "op"
  | "br"
  | "prv"
  | "mdl";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

export function newCorrelationId(): string {
  return newId("corr");
}

export function assertSameCampaign(ownerCampaignId: string, refCampaignId: string, what: string): void {
  if (ownerCampaignId !== refCampaignId) {
    throw Object.assign(new Error(`cross_campaign_ref: ${what}`), {
      code: "cross_campaign_ref" as const,
    });
  }
}
