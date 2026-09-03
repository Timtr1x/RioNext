import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../../src/domain/errors.ts";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { ArtifactStore } from "../../src/storage/artifacts.ts";
import { Store } from "../../src/storage/db.ts";
import { StorageService } from "../../src/storage/service.ts";
import { buildContextPack } from "../../src/context/builder.ts";

function open(dir: string): Engine {
  return new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
}

test("create does not start work", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const engine = open(dir);
  const spec = loadDemoSpec("camp_create_only");
  const rec = engine.createCampaign(spec);
  assert.equal(rec.state, "created");
  const runs = engine.storage.list("task_runs", rec.id);
  assert.equal(runs.length, 0);
  engine.close();
});

test("T08/T09 idempotent submit and conflict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const store = new Store(join(dir, "db.sqlite"));
  const artifacts = new ArtifactStore(join(dir, "art"));
  const svc = new StorageService(store, artifacts);
  const engine = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 2 });
  const spec = loadDemoSpec("camp_idem");
  engine.createCampaign(spec);
  const run = engine.storage.claimDecide(spec.campaign_id, "t");
  assert.ok(run);
  const payload = {
    campaign_id: spec.campaign_id,
    producer_id: "p1",
    submission_id: "sub-1",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "desk",
    body: { ok: true },
    artifact_refs: [] as string[],
    conditions: {},
    env_rev: "env-1",
  };
  const a = engine.storage.recordObservation(payload);
  const b = engine.storage.recordObservation(payload);
  const c = engine.storage.recordObservation(payload);
  assert.equal(a.canonical_ids.observation_id, b.canonical_ids.observation_id);
  assert.equal(b.canonical_ids.observation_id, c.canonical_ids.observation_id);
  assert.equal(b.status, "replayed");
  const obs = engine.storage.list("observations", spec.campaign_id);
  assert.equal(obs.length, 1);
  assert.throws(
    () => engine.storage.recordObservation({ ...payload, body: { ok: false } }),
    (e: unknown) => e instanceof DomainError && e.code === "submission_conflict",
  );
  engine.close();
  svc.close();
});

test("T10 cross-campaign fact ref is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const engine = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const a = loadDemoSpec("camp_a");
  const b = loadDemoSpec("camp_b");
  engine.createCampaign(a);
  engine.createCampaign(b);
  const runA = engine.storage.claimDecide(a.campaign_id, "t");
  const runB = engine.storage.claimDecide(b.campaign_id, "t");
  assert.ok(runA && runB);
  const art = { campaign_id: a.campaign_id, producer_id: "p", submission_id: "o1", run_id: runA.run_id, attempt_id: runA.run_id, subject: "x", body: {}, artifact_refs: [] as string[], conditions: {}, env_rev: "e" };
  const obs = engine.storage.recordObservation(art);
  engine.storage.submitFact({
    campaign_id: a.campaign_id,
    producer_id: "p",
    submission_id: "f1",
    run_id: runA.run_id,
    proposition: "p",
    fact_key: "k",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
  });
  const fact = engine.storage.list("facts", a.campaign_id)[0]!;
  assert.throws(
    () =>
      engine.storage.proposeStepDirect({
        campaign_id: b.campaign_id,
        producer_id: "p",
        submission_id: "s1",
        run_id: runB.run_id,
        question: "use foreign fact",
        kind: "explore",
        goal_refs: [String(engine.storage.list("goals", b.campaign_id)[0]!.id)],
        preconditions: { op: "atom", fact_id: String(fact.id) },
        method_family: "x",
        expected_observations: [],
        completion_criteria: "x",
        fingerprint: "ffff",
        reopen_rule: { kind: "never" },
        input_refs: [{ id: String(fact.id), revision: 1 }],
      }),
    (e: unknown) => e instanceof DomainError && e.code === "cross_campaign_ref",
  );
  engine.close();
});

test("T22 crash reload keeps committed graph", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const spec = loadDemoSpec("camp_crash");
  const e1 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  e1.createCampaign(spec);
  const run = e1.storage.claimDecide(spec.campaign_id, "t")!;
  const obs = e1.storage.recordObservation({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "o1",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "desk",
    body: { v: 1 },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  const step = e1.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "st1",
    run_id: run.run_id,
    question: "inspect desk and note",
    kind: "explore",
    goal_refs: [String(e1.storage.list("goals", spec.campaign_id)[0]!.id)],
    preconditions: { op: "all", of: [] },
    method_family: "inspect-desk",
    expected_observations: ["desk"],
    completion_criteria: "seen",
    fingerprint: "desk1",
    reopen_rule: { kind: "never" },
  });
  const obsId = obs.canonical_ids.observation_id;
  const stepId = step.canonical_ids.step_id;
  const seq = e1.storage.getCampaign(spec.campaign_id).event_head;
  e1.close();
  const e2 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const obs2 = e2.storage.list("observations", spec.campaign_id);
  const steps = e2.storage.list("steps", spec.campaign_id);
  assert.equal(obs2[0]!.id, obsId);
  assert.equal(steps[0]!.id, stepId);
  assert.equal(e2.storage.getCampaign(spec.campaign_id).event_head, seq);
  e2.close();
});

test("context pack observations are newest first; graph_query defaults to oldest", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const e = open(dir);
  const spec = loadDemoSpec("camp_obs_order");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  for (let i = 0; i < 25; i++) {
    e.storage.recordObservation({
      campaign_id: spec.campaign_id,
      producer_id: "p",
      submission_id: `obs-${i}`,
      run_id: run.run_id,
      attempt_id: run.run_id,
      subject: `obs-${String(i).padStart(2, "0")}`,
      body: { i },
      artifact_refs: [],
      conditions: {},
      env_rev: "env-1",
    });
  }
  const oldest = e.storage.graphQuery(spec.campaign_id, { entity: "observations", limit: 20 });
  const newest = e.storage.graphQuery(spec.campaign_id, { entity: "observations", limit: 20, order: "desc" });
  assert.equal((oldest.items[0] as { subject: string }).subject, "obs-00");
  assert.equal((newest.items[0] as { subject: string }).subject, "obs-24");
  const pack = buildContextPack(e.storage, {
    run_id: run.run_id,
    campaign_id: spec.campaign_id,
    step_id: null,
    mode: "decide",
    kind: "decide",
    attempt_no: 1,
    fence: run.fence,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 1000,
    lease_owner: "t",
    continuation_of: null,
  });
  const packed = JSON.stringify(pack.user_payload);
  assert.match(packed, /obs-24/);
  assert.match(packed, /obs-05/);
  assert.equal(packed.includes("obs-00"), false);
  e.close();
});
