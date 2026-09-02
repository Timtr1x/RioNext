import type { FindingStatus } from "../domain/types.ts";
import type { StorageService } from "../storage/service.ts";

export type VerifyFailClass = "refuted" | "missing_condition" | "stale_evidence" | "tool_error" | "inconclusive";

export function verdictFromFailClass(cls: VerifyFailClass): FindingStatus {
  if (cls === "refuted") return "refuted";
  if (cls === "stale_evidence") return "stale";
  return "inconclusive";
}

export function applyVerification(
  storage: StorageService,
  campaignId: string,
  findingId: string,
  cls: VerifyFailClass | "confirmed",
): FindingStatus {
  const finding = storage.store.db
    .prepare("SELECT status FROM findings WHERE id = ? AND campaign_id = ?")
    .get(findingId, campaignId) as { status: FindingStatus } | undefined;
  if (!finding) throw new Error("finding not found");
  if (finding.status === "suspected") {
    storage.setFindingStatus(campaignId, findingId, "validating", { kind: "controller", id: "verify" });
  }
  const next: FindingStatus = cls === "confirmed" ? "confirmed" : verdictFromFailClass(cls);
  const cur = (storage.store.db.prepare("SELECT status FROM findings WHERE id = ?").get(findingId) as { status: FindingStatus }).status;
  if (cur !== next) {
    storage.setFindingStatus(campaignId, findingId, next, { kind: "controller", id: "verify" });
  }
  if (cls === "missing_condition") {
    storage.updateCoverage(campaignId, "verify", { outcome: "inconclusive", execution_state: "blocked" });
  }
  return next;
}

export function confirmFindingIfCurrent(
  storage: StorageService,
  campaignId: string,
  findingId: string,
  currentEnv: string,
): FindingStatus {
  const f = storage.store.db
    .prepare("SELECT evidence_refs_json FROM findings WHERE id = ? AND campaign_id = ?")
    .get(findingId, campaignId) as { evidence_refs_json: string } | undefined;
  if (!f) throw new Error("finding not found");
  const refs = JSON.parse(f.evidence_refs_json) as string[];
  if (refs.length === 0) {
    return applyVerification(storage, campaignId, findingId, "missing_condition");
  }
  let artifactOk = false;
  for (const id of refs) {
    const obs = storage.store.db
      .prepare("SELECT env_rev, artifact_refs_json FROM observations WHERE id = ?")
      .get(id) as { env_rev: string; artifact_refs_json: string } | undefined;
    if (obs && obs.env_rev !== currentEnv) {
      return applyVerification(storage, campaignId, findingId, "stale_evidence");
    }
    const art = storage.store.db
      .prepare("SELECT id, integrity_state, truncated, path, hash FROM artifacts WHERE id = ? AND campaign_id = ?")
      .get(id, campaignId) as { id: string; integrity_state: string; truncated: number; path: string; hash: string } | undefined;
    if (art && art.integrity_state === "complete" && !art.truncated && storage.artifacts.verify(art.path, art.hash)) {
      artifactOk = true;
    }
    if (obs) {
      const nested = JSON.parse(obs.artifact_refs_json || "[]") as string[];
      for (const aid of nested) {
        const nestedArt = storage.store.db
          .prepare("SELECT integrity_state, truncated, path, hash FROM artifacts WHERE id = ? AND campaign_id = ?")
          .get(aid, campaignId) as { integrity_state: string; truncated: number; path: string; hash: string } | undefined;
        if (nestedArt && nestedArt.integrity_state === "complete" && !nestedArt.truncated && storage.artifacts.verify(nestedArt.path, nestedArt.hash)) {
          artifactOk = true;
        }
      }
    }
  }
  if (!artifactOk) {
    return applyVerification(storage, campaignId, findingId, "missing_condition");
  }
  return applyVerification(storage, campaignId, findingId, "confirmed");
}
