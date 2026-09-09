import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invalidInput } from "../domain/errors.ts";
import { buildKaliFlagSpec, looksLikeHttpUrl } from "../domain/quick-spec.ts";
import type { CampaignSpec } from "../domain/types.ts";
import { ProviderCatalog } from "../provider/catalog.ts";
import { resolveSlot } from "../provider/router.ts";
import { flagString } from "./args.ts";

export function pickRunSource(
  flags: Record<string, string | boolean>,
  positional: string[],
): { kind: "url"; url: string } | { kind: "spec"; path: string } {
  const fromFlag = flagString(flags, "url");
  const fromPos = positional.find((p) => looksLikeHttpUrl(p));
  const url = fromFlag ?? fromPos;
  const specPath = flagString(flags, "spec");
  if (url && specPath) {
    throw invalidInput("run_source_conflict", "--url and --spec cannot be used together");
  }
  if (url) {
    if (url === "true") throw invalidInput("invalid_url", "--url requires an http(s) address");
    return { kind: "url", url };
  }
  if (!specPath) {
    throw invalidInput("missing_run_source", "pass a URL or --spec <file>");
  }
  return { kind: "spec", path: specPath };
}

export function specFromUrl(url: string, dataDir: string, campaignId?: string): CampaignSpec {
  const catalog = new ProviderCatalog(dataDir);
  let route;
  try {
    route = resolveSlot(catalog, "solver");
  } catch (err) {
    throw invalidInput("solver_missing", err instanceof Error ? err.message : String(err));
  }
  return buildKaliFlagSpec({
    url,
    provider: route.provider.id,
    model: route.model.name,
    campaign_id: campaignId,
  });
}

export function loadCampaignSpec(
  flags: Record<string, string | boolean>,
  positional: string[],
  dataDir: string,
): unknown {
  const source = pickRunSource(flags, positional);
  if (source.kind === "spec") {
    return JSON.parse(readFileSync(resolve(source.path), "utf8")) as unknown;
  }
  return specFromUrl(source.url, dataDir, flagString(flags, "id"));
}
