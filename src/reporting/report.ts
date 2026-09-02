import type { CampaignSpec } from "../domain/types.ts";

export function boundedConclusionText(spec: CampaignSpec, envRev: string, recovered: boolean, untestedMandatory: number): string {
  if (spec.mode === "assessment" && untestedMandatory > 0) {
    return `In scope ${spec.scope_version}, env=${envRev}, goal=${spec.goal_version}: ${untestedMandatory} mandatory coverage item(s) untested. This is not a safety claim.`;
  }
  if (recovered) {
    return `In scope ${spec.scope.profile}, env ${envRev}: sample recovered. Remaining uncertainty: synthetic world only.`;
  }
  return `In scope ${spec.scope.profile}, env ${envRev}: sample not recovered. No statement that the world is safe.`;
}
