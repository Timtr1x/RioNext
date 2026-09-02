import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCompletion } from "../../src/domain/completion.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { parseProposalOps } from "../../src/domain/proposals.ts";
import { validateCampaignSpec } from "../../src/domain/spec.ts";
import { transitionCampaign } from "../../src/domain/states.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";

test("missing root_goal is rejected", () => {
  const spec = loadDemoSpec("x");
  const bad = { ...spec, root_goal: { statement: "", success_predicate_ref: "x" } };
  assert.throws(() => validateCampaignSpec(bad), (e: unknown) => e instanceof DomainError && e.code === "missing_root_goal");
});

test("negative budget is rejected", () => {
  const spec = loadDemoSpec("x");
  spec.budget.max_calls = -1;
  assert.throws(() => validateCampaignSpec(spec), (e: unknown) => e instanceof DomainError && e.code === "negative_budget");
});

test("omitted thinking_level defaults to high", () => {
  const spec = loadDemoSpec("think-default");
  const raw = JSON.parse(JSON.stringify(spec)) as { model_policy: { thinking_level?: string } };
  delete raw.model_policy.thinking_level;
  const parsed = validateCampaignSpec(raw);
  assert.equal(parsed.model_policy.thinking_level, "high");
});

test("unknown model is rejected", () => {
  const spec = loadDemoSpec("x");
  spec.model_policy.model = "gpt-secret";
  assert.throws(() => validateCampaignSpec(spec), (e: unknown) => e instanceof DomainError && e.code === "unknown_model");
});

test("illegal campaign complete from created is rejected", () => {
  assert.throws(() => transitionCampaign("created", "completed"));
});

test("model cannot submit complete_campaign op", () => {
  assert.throws(() => parseProposalOps([{ op: "complete_campaign" }]));
  assert.throws(() => parseProposalOps([{ op: "recommend_state", state: "completed", reason: "done" }]));
});

test("assessment with untested mandatory coverage cannot close", () => {
  const r = evaluateCompletion({
    mode: "assessment",
    state: "active",
    cancel_epoch: 0,
    in_flight_runs: 0,
    in_flight_invocations: 0,
    unconsumed_events: 0,
    pending_important_proposals: 0,
    uncertain_invocations: 0,
    empty_reviews: 2,
    max_empty_reviews: 2,
    ready_steps: 0,
    blocked_steps: 0,
    frontier_size: 0,
    new_observation_since_progress: false,
    findings: [{ status: "confirmed" }],
    coverage: [
      {
        id: "c1",
        mandatory: true,
        applicability: "applicable",
        execution_state: "untested",
        outcome: "none",
        evidence_state: "missing",
      },
    ],
    root_goal_satisfied: false,
  });
  assert.equal(r.canClose, false);
  assert.ok(r.blockers.includes("mandatory_coverage_untested"));
});

test("empty frontier without new observation is plateau not completed", () => {
  const r = evaluateCompletion({
    mode: "goal_seeking",
    state: "active",
    cancel_epoch: 0,
    in_flight_runs: 0,
    in_flight_invocations: 0,
    unconsumed_events: 0,
    pending_important_proposals: 0,
    uncertain_invocations: 0,
    empty_reviews: 2,
    max_empty_reviews: 2,
    ready_steps: 0,
    blocked_steps: 0,
    frontier_size: 0,
    new_observation_since_progress: false,
    findings: [],
    coverage: [],
    root_goal_satisfied: false,
  });
  assert.equal(r.canClose, false);
  assert.equal(r.suggestedState, "plateau");
});
