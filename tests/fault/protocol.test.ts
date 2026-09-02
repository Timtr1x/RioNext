import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { buildContextPack } from "../../src/context/builder.ts";
import { evaluateCompletion } from "../../src/domain/completion.ts";
import type { RunLease } from "../../src/domain/types.ts";
import { loadAssessmentSpec, loadDemoSpec } from "../../src/eval/helpers.ts";
import { createQueuedStreamFn, SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";
import type { TurnChooser } from "../../src/runtime/pi/scripted-stream.ts";
import type { LabWorld } from "../../src/tools/synthetic.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "rn-p-"));
}

function engine(data: string, extra?: ConstructorParameters<typeof Engine>[1]): Engine {
  return new Engine(makeRuntimeConfig(data), { silent: true, maxCycles: 24, ...extra });
}

function toolResultNames(messages: unknown[]): string[] {
  return (messages as { role?: string; toolName?: string }[])
    .filter((m) => m.role === "toolResult")
    .map((m) => String(m.toolName));
}

function userText(message: { role?: string; content?: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return (c as { text?: string }[]).map((x) => x.text ?? "").join("");
  return JSON.stringify(c ?? "");
}

function toolCallIds(messages: unknown[]): string[] {
  const ids: string[] = [];
  for (const m of messages as { role?: string; content?: unknown }[]) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as { type?: string; id?: string }[]) {
      if (block.type === "toolCall" && block.id) ids.push(block.id);
    }
  }
  return ids;
}

function oneStepDecide(question: string): TurnChooser {
  return (ctx) => {
    const names = toolResultNames(ctx.messages);
    if (!names.includes("propose_plan")) {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "propose_plan",
            arguments: {
              operations: [
                {
                  op: "propose_step",
                  step: {
                    kind: "explore",
                    question,
                    methodFamily: "t-protocol",
                    expectedObservations: ["marker"],
                    completionCriteria: "observe",
                    preconditions: { op: "all", of: [] },
                    goalRefs: [],
                    inputRefs: [],
                    resourceClaims: [],
                    budgetHint: {},
                    reopenRule: { kind: "always" },
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return { type: "tool_calls", calls: [{ name: "finish_decision", arguments: { summary: "one step" } }] };
  };
}

test("T01 first execute without finding does not complete campaign", async () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t01");
  e.createCampaign(spec);
  await e.runDecide(spec.campaign_id);
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.notEqual(e.storage.getCampaign(spec.campaign_id).state, "completed");
  const steps = e.storage.list("steps", spec.campaign_id);
  assert.ok(steps.some((s) => s.status === "ready" || s.status === "blocked" || s.status === "deferred"));
  e.close();
});

test("T02 same fingerprint rewrite does not reset attempt_count", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t02");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  const a = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "s1",
    run_id: run.run_id,
    question: "use badge reader to unlock drawer",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "badge",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "badge-fp",
    reopen_rule: { kind: "never" },
  });
  e.storage.store.db.prepare("UPDATE steps SET attempt_count = 3 WHERE id = ?").run(a.canonical_ids.step_id!);
  const b = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "s2",
    run_id: run.run_id,
    question: "please use the badge reader again, pretty please",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "badge",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "badge-fp",
    reopen_rule: { kind: "never" },
  });
  assert.equal(a.canonical_ids.step_id, b.canonical_ids.step_id);
  const step = e.storage.list("steps", spec.campaign_id).find((s) => s.id === a.canonical_ids.step_id)!;
  assert.equal(step.attempt_count, 3);
  e.close();
});

test("T03 blocked then ready after missing precondition fact", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t03");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  const blocked = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "cab",
    run_id: run.run_id,
    question: "open cabinet with key",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "atom", key: "has_key" },
    method_family: "open-cabinet",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "cab",
    reopen_rule: { kind: "fact_key", key: "has_key" },
  });
  assert.equal(blocked.extra?.step_status, "blocked");
  const obs = e.storage.recordObservation({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "o",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "key",
    body: { has_key: true },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  e.storage.submitFact({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "f",
    run_id: run.run_id,
    proposition: "operator holds cabinet key",
    fact_key: "has_key",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
  });
  const step = e.storage.list("steps", spec.campaign_id).find((s) => s.id === blocked.canonical_ids.step_id)!;
  assert.equal(step.status, "ready");
  e.close();
});

test("T04 deferred reopen after env revision change", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t04");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  const st = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "side",
    run_id: run.run_id,
    question: "open side panel",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "atom", key: "clock_seen" },
    method_family: "side",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "side",
    reopen_rule: { kind: "env_revision", env_revision: "env-2" },
  });
  e.storage.store.db.prepare("UPDATE steps SET status = 'deferred' WHERE id = ?").run(st.canonical_ids.step_id!);
  const obs = e.storage.recordObservation({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "clock",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "clock",
    body: { env: "env-2" },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-2",
  });
  e.storage.submitFact({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "fc",
    run_id: run.run_id,
    proposition: "clock observed",
    fact_key: "clock_seen",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
    env_rev: "env-2",
  });
  const step = e.storage.list("steps", spec.campaign_id).find((s) => s.id === st.canonical_ids.step_id)!;
  assert.equal(step.status, "ready");
  e.close();
});

test("T05 limited retries count cost and do not refute the direction", async () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t05");
  spec.budget.max_calls = 80;
  e.createCampaign(spec);
  await e.start(spec.campaign_id);
  const facts = e.storage.list("facts", spec.campaign_id);
  assert.equal(facts.some((f) => String(f.proposition).includes("NOT") && String(f.fact_key) === "drawer_open"), false);
  const spent = Number(e.budget.snapshot(spec.campaign_id).spent_calls);
  assert.ok(spent >= 1);
  e.close();
});

test("T06 submit_fact without evidence never verified", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t06");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const r = e.storage.submitFact({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "bare",
    run_id: run.run_id,
    proposition: "cabinet is open",
    fact_key: "open",
    support_refs: [],
    conditions: {},
  });
  assert.equal(r.extra?.submit_status, "rejected");
  const facts = e.storage.list("facts", spec.campaign_id);
  assert.equal(facts.length, 0);
  e.close();
});

test("T07 tool success does not mark coverage tested", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t07");
  e.createCampaign(spec);
  const cov = e.storage.list("coverage_items", spec.campaign_id);
  assert.ok(cov.length >= 1);
  assert.equal(cov[0]!.execution_state, "untested");
  e.storage.updateCoverage(spec.campaign_id, String(cov[0]!.obligation), { outcome: "inconclusive" });
  const after = e.storage.list("coverage_items", spec.campaign_id)[0]!;
  assert.equal(after.execution_state, "untested");
  assert.equal(after.outcome, "inconclusive");
  e.close();
});

test("T11 opposite observations leave disputed facts", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t11");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const o1 = e.storage.recordObservation({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "o1", run_id: run.run_id, attempt_id: run.run_id,
    subject: "x", body: { v: 1 }, artifact_refs: [], conditions: {}, env_rev: "e",
  });
  const o2 = e.storage.recordObservation({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "o2", run_id: run.run_id, attempt_id: run.run_id,
    subject: "x", body: { v: 2 }, artifact_refs: [], conditions: {}, env_rev: "e",
  });
  e.storage.submitFact({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "f1", run_id: run.run_id,
    proposition: "door is open", fact_key: "door", support_refs: [o1.canonical_ids.observation_id!], conditions: {},
  });
  e.storage.submitFact({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "f2", run_id: run.run_id,
    proposition: "door is closed", fact_key: "door", support_refs: [o2.canonical_ids.observation_id!], conditions: {},
  });
  const facts = e.storage.list("facts", spec.campaign_id);
  assert.equal(facts.length, 2);
  assert.ok(facts.every((f) => f.epistemic_status === "disputed"));
  e.close();
});

test("T12 unknown AND/OR does not admit ready", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t12");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  const r = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "and",
    run_id: run.run_id,
    question: "needs unknown",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [{ op: "atom", key: "ghost" }] },
    method_family: "x",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "unk",
    reopen_rule: { kind: "never" },
  });
  assert.equal(r.extra?.step_status, "blocked");
  e.close();
});

test("T13 mutual blocked steps do not spawn isomorphic extras", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t13");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "a", run_id: run.run_id,
    question: "A needs B", kind: "explore", goal_refs: [root],
    preconditions: { op: "atom", key: "b" }, method_family: "cycle", expected_observations: [],
    completion_criteria: "x", fingerprint: "A", reopen_rule: { kind: "never" },
  });
  e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "b", run_id: run.run_id,
    question: "B needs A", kind: "explore", goal_refs: [root],
    preconditions: { op: "atom", key: "a" }, method_family: "cycle", expected_observations: [],
    completion_criteria: "x", fingerprint: "B", reopen_rule: { kind: "never" },
  });
  const again = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "a2", run_id: run.run_id,
    question: "A needs B rewritten", kind: "explore", goal_refs: [root],
    preconditions: { op: "atom", key: "b" }, method_family: "cycle", expected_observations: [],
    completion_criteria: "x", fingerprint: "A", reopen_rule: { kind: "never" },
  });
  assert.equal(again.extra?.merged, true);
  const steps = e.storage.list("steps", spec.campaign_id);
  assert.equal(steps.length, 2);
  assert.ok(steps.every((s) => s.status === "blocked"));
  e.close();
});

test("T14 empty decide reviews plateau without infinite LLM calls", async () => {
  const chooseDecide: TurnChooser = (ctx) => {
    const names = (ctx.messages as { role?: string; toolName?: string }[])
      .filter((m) => m.role === "toolResult")
      .map((m) => m.toolName);
    if (!names.includes("propose_plan")) {
      return { type: "tool_calls", calls: [{ name: "propose_plan", arguments: { operations: [], no_change_reason: "nothing" } }] };
    }
    return { type: "tool_calls", calls: [{ name: "finish_decision", arguments: { summary: "no change" } }] };
  };
  const e = engine(dir(), { chooseDecide, maxCycles: 8 });
  const spec = loadDemoSpec("t14");
  spec.stop_policy.max_empty_reviews_per_progress_epoch = 2;
  spec.budget.max_calls = 80;
  e.createCampaign(spec);
  await e.start(spec.campaign_id);
  assert.equal(e.storage.getCampaign(spec.campaign_id).state, "plateau");
  assert.ok(e.modelSends <= 12);
  e.close();
});

test("T15 retire subgoal keeps history", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t15");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  e.storage.applyProposalBatch({
    campaign_id: spec.campaign_id,
    producer_id: run.run_id,
    submission_id: "g1",
    run_id: run.run_id,
    operations: [{ op: "propose_subgoal", statement: "get key", parent_id: root }],
  });
  const sub = e.storage.list("goals", spec.campaign_id).find((g) => !g.is_root)!;
  e.storage.applyProposalBatch({
    campaign_id: spec.campaign_id,
    producer_id: run.run_id,
    submission_id: "g2",
    run_id: run.run_id,
    operations: [{ op: "retire_subgoal", goal_id: sub.id, expected_revision: 1, reason: "absorbed" }],
  });
  const after = e.storage.list("goals", spec.campaign_id).find((g) => g.id === sub.id)!;
  assert.equal(after.status, "retired");
  assert.equal(after.retired_reason, "absorbed");
  const ev = e.storage.list("events", spec.campaign_id).filter((x) => x.type === "goal.retired");
  assert.equal(ev.length, 1);
  e.close();
});

test("T16 new run rebuilds from structured state not Pi history", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const names = toolResultNames(ctx.messages);
    if (!names.includes("submit_observation")) {
      return {
        type: "tool_calls",
        calls: [{ name: "submit_observation", arguments: { subject: "t16-memory", body: { marker: "keep-me" } } }],
      };
    }
    return {
      type: "tool_calls",
      calls: [{ name: "finish_step", arguments: { reason: "deferred", summary: "t16-last-failure" } }],
    };
  };
  const e = engine(dir(), { chooseDecide: oneStepDecide("t16 memory step"), chooseExecute, maxCycles: 4 });
  const spec = loadDemoSpec("t16");
  e.createCampaign(spec);
  await e.runDecide(spec.campaign_id);
  const firstOutcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(firstOutcome);
  assert.ok(firstOutcome.observation_ids.length >= 1, "first run must record observation ids on TaskOutcome");
  const obsId = firstOutcome.observation_ids[0]!;
  const firstWorker = e.lastWorker;
  assert.ok(firstWorker?.agent);
  const firstIds = toolCallIds(firstWorker.agent.state.messages);
  assert.ok(firstIds.length >= 1);
  const step = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.equal(step.last_failure, "t16-last-failure");
  const previewLease: RunLease = {
    run_id: "preview-t16",
    campaign_id: spec.campaign_id,
    step_id: String(step.id),
    mode: "execute",
    kind: "explore",
    attempt_no: 2,
    fence: 2,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "t16",
    continuation_of: firstOutcome.run_id,
  };
  const pack = buildContextPack(e.storage, previewLease);
  const payload = pack.user_payload as {
    graph: { observations: { id: string; subject?: string }[]; steps: { id: string; last_failure?: string }[] };
    current_step: { last_failure?: string };
  };
  assert.ok(payload.graph.observations.some((o) => o.id === obsId && o.subject === "t16-memory"));
  assert.equal(payload.current_step.last_failure, "t16-last-failure");
  assert.ok(payload.graph.steps.some((s) => s.id === step.id && s.last_failure === "t16-last-failure"));

  const secondOutcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(secondOutcome);
  const secondWorker = e.lastWorker;
  assert.ok(secondWorker?.agent);
  assert.notEqual(secondWorker, firstWorker);
  assert.notEqual(secondWorker.agent, firstWorker.agent);
  const msgs = secondWorker.agent.state.messages;
  assert.equal(msgs[0]?.role, "user");
  const prompt = userText(msgs[0] as { role?: string; content?: unknown });
  assert.ok(prompt.includes(obsId), "new prompt must carry the persisted observation id");
  assert.ok(prompt.includes("t16-last-failure"), "new prompt must carry last_failure from SQLite");
  for (const id of firstIds) {
    assert.equal(
      JSON.stringify(msgs).includes(id),
      false,
      `second Agent reused Pi history toolCall ${id}`,
    );
  }
  e.close();
});

test("T17 run stop on turn cap keeps observations", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const names = toolResultNames(ctx.messages);
    if (!names.includes("submit_observation")) {
      return {
        type: "tool_calls",
        calls: [{ name: "submit_observation", arguments: { subject: "t17-kept", body: { kept: true } } }],
      };
    }
    return {
      type: "tool_calls",
      calls: [{ name: "finish_step", arguments: { reason: "resolved", summary: "should not run after cap" } }],
    };
  };
  const e = engine(dir(), { chooseDecide: oneStepDecide("t17 cap step"), chooseExecute });
  e.config.max_execute_turns_per_run = 1;
  const spec = loadDemoSpec("t17");
  e.createCampaign(spec);
  await e.runDecide(spec.campaign_id);
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.finish_requested, false);
  assert.equal(outcome.reason, "incomplete_protocol");
  assert.ok(outcome.observation_ids.length >= 1, "turn cap must not drop submitted observation ids");
  const obsId = outcome.observation_ids[0]!;
  const rows = e.storage.list("observations", spec.campaign_id);
  assert.ok(rows.some((r) => r.id === obsId && r.subject === "t17-kept"));
  const run = e.storage.getRun(outcome.run_id);
  const stored = JSON.parse(String(run.outcome_json)) as { observation_ids: string[] };
  assert.ok(stored.observation_ids.includes(obsId));
  e.close();
});

test("T18 truncated tool calls are not executed", async () => {
  let executed = 0;
  const boom: AgentTool = {
    name: "world_act",
    label: "act",
    description: "act",
    parameters: Type.Object({ action: Type.String() }),
    execute: async () => {
      executed += 1;
      return { content: [{ type: "text", text: "nope" }], details: {} };
    },
  };
  const agent = new Agent({
    initialState: { systemPrompt: "t", model: SCRIPTED_MODEL, tools: [boom] },
    streamFn: createQueuedStreamFn([{ type: "truncated_tools", calls: [{ name: "world_act", arguments: { action: "open_cabinet" } }] }]),
    toolExecution: "sequential",
  });
  await agent.prompt("go");
  assert.equal(executed, 0);
});

test("T19 finish then env tool is not dispatched", async () => {
  const chooseExecute: TurnChooser = () => ({
    type: "tool_calls",
    calls: [
      { name: "finish_step", arguments: { reason: "resolved", summary: "done" } },
      { name: "world_act", arguments: { action: "open_cabinet" } },
    ],
  });
  const e = engine(dir(), { chooseExecute, maxCycles: 4 });
  const spec = loadDemoSpec("t19");
  e.createCampaign(spec);
  await e.runDecide(spec.campaign_id);
  await e.runExecuteSlot(spec.campaign_id);
  assert.ok((e.lastWorker?.finishThenBlocked ?? 0) >= 1 || (e.lastWorker?.toolGateway?.blockedAfterFinish ?? 0) >= 1);
  const world = e.storage.getWorld<LabWorld>(spec.campaign_id, { cabinet_open: false } as LabWorld);
  assert.equal(world.cabinet_open, false);
  e.close();
});

test("T21 new TaskRun cannot mint free quota after cap", async () => {
  const e = engine(dir(), { maxCycles: 12 });
  const spec = loadDemoSpec("t21");
  spec.budget.max_calls = 4;
  spec.budget.max_tokens = null;
  spec.budget.max_cost_micro = null;
  e.createCampaign(spec);
  await e.start(spec.campaign_id);
  const snap = e.budget.snapshot(spec.campaign_id);
  assert.ok(Number(snap.spent_calls) + Number(snap.reserved_calls) >= 4 || e.storage.getCampaign(spec.campaign_id).state === "budget_paused");
  assert.equal(e.budget.canAdmit(spec.campaign_id, 1, 0, 0), false);
  e.close();
});

test("T23 cancel stays cancelled despite follow-up", async () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t23");
  e.createCampaign(spec);
  e.cancel(spec.campaign_id);
  await e.start(spec.campaign_id);
  assert.equal(e.storage.getCampaign(spec.campaign_id).state, "cancelled");
  const runs = e.storage.list("task_runs", spec.campaign_id);
  assert.equal(runs.length, 0);
  e.close();
});

test("T24 confirmed finding does not complete assessment with untested coverage", () => {
  const e = engine(dir());
  const spec = loadAssessmentSpec("t24");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const o = e.storage.recordObservation({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "o", run_id: run.run_id, attempt_id: run.run_id,
    subject: "note", body: { clue: "0000" }, artifact_refs: [], conditions: {}, env_rev: "e",
  });
  const f = e.storage.submitFinding({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "f", run_id: run.run_id,
    claim: "misleading code", evidence_refs: [o.canonical_ids.observation_id!], dedup_key: "code-0000",
    model_confidence: 0.99,
  });
  e.storage.setFindingStatus(spec.campaign_id, f.canonical_ids.finding_id!, "validating", { kind: "controller", id: "oracle" });
  e.storage.setFindingStatus(spec.campaign_id, f.canonical_ids.finding_id!, "confirmed", { kind: "controller", id: "oracle" });
  e.storage.finishRun(spec.campaign_id, run.run_id, {
    run_id: run.run_id,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "seeded",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [f.canonical_ids.finding_id!],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  e.storage.consumeEvents(spec.campaign_id);
  const finding = e.storage.list("findings", spec.campaign_id)[0]!;
  assert.equal(finding.status, "confirmed");
  const snap = e.snapshot(spec.campaign_id);
  const r = evaluateCompletion(snap);
  assert.equal(r.canClose, false);
  assert.ok(r.blockers.includes("mandatory_coverage_untested"));
  e.close();
});

test("T22 child process boundary reload", () => {
  const data = dir();
  const specPath = join(data, "spec.json");
  writeFileSync(specPath, JSON.stringify(loadDemoSpec("t22c")));
  const childJs = join(process.cwd(), "dist/tests/fault/child-commit.js");
  const childTs = join(process.cwd(), "tests/fault/child-commit.ts");
  const r = spawnSync(
    process.execPath,
    existsSync(childJs) ? [childJs, data, specPath] : ["--experimental-strip-types", childTs, data, specPath],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const e = engine(data);
  const camp = e.storage.getCampaign("t22c");
  assert.ok(e.storage.list("observations", camp.id).length >= 1);
  e.close();
});
