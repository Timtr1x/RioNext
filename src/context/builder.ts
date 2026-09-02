import { createHash } from "node:crypto";
import type { ContextPack } from "../contracts/worker-runtime.ts";
import { hashJson } from "../domain/fingerprint.ts";
import type { ContextManifest, RunLease } from "../domain/types.ts";
import type { StorageService } from "../storage/service.ts";
import { PROMPT_VERSION } from "../version.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadPrompt(mode: "decide" | "execute"): string {
  const name = mode === "decide" ? "decide.txt" : "execute.txt";
  const candidates = [
    join(here, "../../../prompts", name),
    join(process.cwd(), "prompts", name),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      // try next
    }
  }
  return mode === "decide"
    ? "Propose typed plan operations, then finish_decision. Do not complete the campaign."
    : "Solve the current step with approved tools, submit observations, then finish_step.";
}

export function buildContextPack(storage: StorageService, lease: RunLease, extra: Record<string, unknown> = {}): ContextPack {
  const camp = storage.getCampaign(lease.campaign_id);
  const facts = storage.graphQuery(lease.campaign_id, { entity: "facts", limit: 30 });
  const steps = storage.graphQuery(lease.campaign_id, { entity: "steps", limit: 30 });
  const goals = storage.graphQuery(lease.campaign_id, { entity: "goals", limit: 20 });
  const findings = storage.graphQuery(lease.campaign_id, { entity: "findings", limit: 20 });
  const coverage = storage.graphQuery(lease.campaign_id, { entity: "coverage", limit: 20 });
  const observations = storage.graphQuery(lease.campaign_id, { entity: "observations", limit: 20 });
  const payload: Record<string, unknown> = {
    campaign_id: lease.campaign_id,
    mode: lease.mode,
    run_id: lease.run_id,
    fence: lease.fence,
    cancel_epoch: lease.cancel_epoch,
    root_goal: camp.spec.root_goal,
    scope: camp.spec.scope,
    policy_version: camp.spec.policy_version,
    scope_version: camp.spec.scope_version,
    goal_version: camp.spec.goal_version,
    remaining_budget: {
      calls: storage.store.db.prepare("SELECT free_calls FROM budget_accounts WHERE campaign_id = ?").get(lease.campaign_id),
    },
    graph: { facts: facts.items, steps: steps.items, goals: goals.items, findings: findings.items, coverage: coverage.items, observations: observations.items },
    omitted: [facts, steps, goals, findings, coverage, observations].filter((g) => g.truncated).map((g) => ({ truncated: true })),
    ...extra,
  };
  if (lease.step_id) {
    const step = storage.store.db.prepare("SELECT * FROM steps WHERE id = ?").get(lease.step_id);
    payload.current_step = step;
  }
  const encoded = JSON.stringify(payload);
  if (encoded.length > 400_000) {
    throw new Error("context_capacity: required invariant content does not fit");
  }
  const manifest: ContextManifest = {
    run_id: lease.run_id,
    mode: lease.mode,
    prompt_version: PROMPT_VERSION,
    tool_schema_hash: hashJson(lease.mode),
    graph_snapshot_seq: camp.event_head,
    root_goal_version: camp.spec.goal_version,
    scope_version: camp.spec.scope_version,
    policy_version: camp.spec.policy_version,
    model_id: camp.spec.model_policy.model,
    selected_entity_revisions: [],
    artifact_slices: [],
    omitted_items: payload.omitted as ContextManifest["omitted_items"],
    estimated_tokens: Math.ceil(encoded.length / 4),
    context_hash: createHash("sha256").update(encoded).digest("hex"),
  };
  storage.saveManifest(lease.run_id, manifest);
  const tool_names =
    lease.mode === "decide"
      ? ["graph_query", "artifact_read", "propose_plan", "checkpoint", "finish_decision"]
      : [
          "graph_query",
          "artifact_read",
          "submit_observation",
          "submit_fact",
          "submit_finding",
          "propose_step",
          "checkpoint",
          "finish_step",
          "world_inspect",
          "world_act",
        ];
  return {
    manifest,
    system_prompt: loadPrompt(lease.mode),
    user_payload: payload,
    tool_names,
  };
}
