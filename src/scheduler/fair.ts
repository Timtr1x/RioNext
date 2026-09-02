import type { StorageService } from "../storage/service.ts";

export function pickFairReadyStep(storage: StorageService, campaignId: string): string | null {
  const steps = storage.store.db
    .prepare(
      `SELECT id, branch_id, kind, priority, ready_since FROM steps
       WHERE campaign_id = ? AND status = 'ready'`,
    )
    .all(campaignId) as { id: string; branch_id: string; kind: string; priority: number; ready_since: string | null }[];
  if (steps.length === 0) return null;
  const last = storage.store.db.prepare("SELECT execute_lock_owner FROM campaigns WHERE id = ?").get(campaignId) as
    | { execute_lock_owner: string | null }
    | undefined;
  void last;
  const wait = (s: (typeof steps)[0]) => (s.ready_since ? Date.parse(s.ready_since) : 0);
  const byBranch = new Map<string, (typeof steps)[0][]>();
  for (const s of steps) {
    const arr = byBranch.get(s.branch_id) ?? [];
    arr.push(s);
    byBranch.set(s.branch_id, arr);
  }
  const branches = [...byBranch.entries()].map(([id, list]) => ({
    id,
    oldest: Math.min(...list.map(wait)),
    best: list.slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.priority - b.priority || wait(a) - wait(b))[0]!,
  }));
  branches.sort((a, b) => a.oldest - b.oldest);
  return branches[0]!.best.id;
}

function kindRank(kind: string): number {
  if (kind === "verify") return 0;
  if (kind === "reconcile") return 1;
  if (kind === "acquire_prerequisite") return 2;
  return 3;
}
