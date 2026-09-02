import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "../contracts/config.ts";
import { configFingerprint, makeRuntimeConfig, printStartupBanner, validateStartupInput } from "../contracts/config.ts";
import { buildContextPack } from "../context/builder.ts";
import { evaluateCompletion, type CompletionSnapshot, type CoverageRow } from "../domain/completion.ts";
import { DomainError } from "../domain/errors.ts";
import type { CampaignSpec, CampaignState, RunLease, TaskOutcome } from "../domain/types.ts";
import { decideChooser, executeChooser } from "../eval/demo-policy.ts";
import { commitCompletion, enterClosing } from "./close.ts";
import { BudgetLedger } from "../gateway/budget-ledger.ts";
import { DispatchGate } from "../gateway/dispatch.ts";
import { ModelGateway, ToolGateway } from "../gateway/gateways.ts";
import { InvocationBook } from "../gateway/invocation.ts";
import { PiWorkerFactory, type PiWorker } from "../runtime/pi/factory.ts";
import type { TurnChooser } from "../runtime/pi/scripted-stream.ts";
import { FileEffectAdapter, type EffectAdapter } from "../tools/effect-adapter.ts";
import { ArtifactStore } from "../storage/artifacts.ts";
import { backupStore, restoreStore, type BackupReport, type RestoreReport } from "../storage/backup.ts";
import { Store } from "../storage/db.ts";
import { StorageService } from "../storage/service.ts";
import { freshWorld, oracleGoalSatisfied, type LabWorld } from "../tools/synthetic.ts";
import { SCHEMA_VERSION } from "../version.ts";

export interface EngineOptions {
  chooseDecide?: TurnChooser;
  chooseExecute?: TurnChooser;
  maxCycles?: number;
  silent?: boolean;
  effectAdapter?: EffectAdapter;
}

export class Engine {
  readonly storage: StorageService;
  readonly budget: BudgetLedger;
  readonly invocations: InvocationBook;
  readonly factory: PiWorkerFactory;
  readonly config: RuntimeConfig;
  readonly dispatchGate: DispatchGate;
  readonly logs: string[] = [];
  lastWorker: PiWorker | null = null;
  modelSends = 0;
  toolSends = 0;
  envSends = 0;

  constructor(
    readonly configIn: RuntimeConfig,
    private readonly options: EngineOptions = {},
  ) {
    this.config = configIn;
    mkdirSync(configIn.artifact_root, { recursive: true });
    const store = new Store(configIn.db_path);
    const artifacts = new ArtifactStore(configIn.artifact_root);
    this.storage = new StorageService(store, artifacts);
    this.budget = new BudgetLedger(this.storage);
    this.invocations = new InvocationBook(this.storage);
    const adapter = options.effectAdapter ?? new FileEffectAdapter(join(configIn.artifact_root, "effects"));
    this.dispatchGate = new DispatchGate(this.storage, this.budget, this.invocations, adapter);
    this.factory = new PiWorkerFactory({
      storage: this.storage,
      modelGatewayFor: (lease, inner) => new ModelGateway(this.storage, this.budget, this.invocations, inner, lease, "scripted"),
      toolGatewayFor: (lease) => new ToolGateway(this.storage, this.budget, this.invocations, lease, this.dispatchGate),
      chooseDecide: options.chooseDecide ?? decideChooser(),
      chooseExecute: options.chooseExecute ?? executeChooser(),
      getMaxTurns: () => ({
        decide: this.config.max_decide_turns,
        execute: this.config.max_execute_turns_per_run,
      }),
    });
  }

  log(msg: string): void {
    this.logs.push(msg);
    if (!this.options.silent) console.log(msg);
  }

  banner(): Record<string, unknown> {
    printStartupBanner(this.config, (s) => this.log(s));
    return configFingerprint(this.config);
  }

  createCampaign(specInput: unknown): { id: string; state: CampaignState } {
    const spec = validateStartupInput(specInput, this.config);
    const existing = this.storage.store.db.prepare("SELECT id FROM campaigns WHERE id = ?").get(spec.campaign_id);
    if (existing) throw new DomainError("campaign_exists", "campaign already exists", "conflict");
    const rec = this.storage.createCampaign(spec);
    this.storage.saveWorld(spec.campaign_id, freshWorld());
    this.log(`created campaign ${rec.id} state=${rec.state}`);
    return { id: rec.id, state: rec.state };
  }

  async start(campaignId: string): Promise<void> {
    this.banner();
    this.storage.acquireControllerLock(campaignId, this.config.instance_id);
    const camp0 = this.storage.getCampaign(campaignId);
    if (camp0.state === "created") {
      this.storage.setCampaignState(campaignId, "active", { kind: "user", id: "cli" });
    }
    if (camp0.state === "cancelled") return;
    this.dispatchGate.recover(campaignId);
    await this.runLoop(campaignId);
  }

  cancel(campaignId: string): number {
    const epoch = this.storage.persistCancel(campaignId, { kind: "user", id: "cli" });
    this.log(`cancelled campaign ${campaignId} cancel_epoch=${epoch}`);
    return epoch;
  }

  pause(campaignId: string): void {
    this.storage.persistPause(campaignId, { kind: "user", id: "cli" }, "paused");
  }

  resume(campaignId: string): void {
    this.storage.persistResume(campaignId, { kind: "user", id: "cli" });
  }

  hint(campaignId: string, text: string): number {
    return this.storage.persistHint(campaignId, text, { kind: "user", id: "cli" });
  }

  reviseBudget(campaignId: string, patch: { max_calls?: number; max_tokens?: number; max_cost_micro?: number }): number {
    return this.storage.persistReviseBudget(campaignId, patch, { kind: "user", id: "cli" });
  }

  reviseScope(campaignId: string, scope_version: string): number {
    return this.storage.persistReviseScope(campaignId, scope_version, { kind: "user", id: "cli" });
  }

  explainStep(campaignId: string, stepId: string): Record<string, unknown> {
    return this.storage.explainStep(campaignId, stepId);
  }

  async runLoop(campaignId: string): Promise<void> {
    const maxCycles = this.options.maxCycles ?? 48;
    for (let i = 0; i < maxCycles; i++) {
      const camp = this.storage.getCampaign(campaignId);
      if (camp.state === "cancelled" || camp.state === "completed" || camp.state === "paused") break;
      this.storage.consumeEvents(campaignId);
      this.storage.recomputeStepReadiness(campaignId);
      if (!this.budget.canAdmit(campaignId, 1, 0, 0)) {
        if (camp.state !== "budget_paused") {
          this.storage.persistPause(campaignId, { kind: "controller", id: "engine" }, "budget_paused");
        }
        break;
      }
      const counts = this.storage.counts(campaignId);
      const needDecide =
        (camp.requested_seq > camp.reviewed_seq && counts.ready === 0) ||
        counts.ready + counts.blocked + counts.deferred === 0 ||
        i === 0;
      const decideLock = this.storage.store.db.prepare("SELECT decide_lock_owner FROM campaigns WHERE id = ?").get(campaignId) as {
        decide_lock_owner: string | null;
      };
      if (needDecide && !decideLock.decide_lock_owner && camp.state !== "budget_paused") {
        await this.runDecide(campaignId);
      }
      const afterDecide = this.storage.getCampaign(campaignId);
      if (afterDecide.state === "cancelled") break;
      if (this.budget.canAdmit(campaignId, 1, 0, 0)) {
        await this.runExecuteSlot(campaignId);
      }
      this.storage.consumeEvents(campaignId);
      this.storage.recomputeStepReadiness(campaignId);
      const snap = this.snapshot(campaignId);
      const decision = evaluateCompletion(snap);
      if (decision.canClose) {
        const { H } = enterClosing(this, campaignId);
        this.storage.consumeEvents(campaignId);
        const committed = commitCompletion(this, campaignId, H);
        if (!committed.ok) {
          const now = this.storage.getCampaign(campaignId);
          if (now.state === "closing") {
            this.storage.setCampaignState(campaignId, "active", { kind: "controller", id: "engine" });
          }
          continue;
        }
        try {
          this.writeReportFile(join(this.config.data_dir, "reports", `${campaignId}.json`), this.storage.latestReport(campaignId));
        } catch {
          // snapshot already in DB
        }
        break;
      }
      if (decision.suggestedState === "plateau") {
        this.storage.setCampaignState(campaignId, "plateau", { kind: "controller", id: "engine" });
        this.writeReport(campaignId, "plateau");
        break;
      }
      if (decision.suggestedState === "blocked" && snap.ready_steps === 0) {
        const stillNeed = this.storage.getCampaign(campaignId);
        if (stillNeed.empty_reviews >= stillNeed.spec.stop_policy.max_empty_reviews_per_progress_epoch) {
          this.storage.setCampaignState(campaignId, "blocked", { kind: "controller", id: "engine" });
          this.writeReport(campaignId, "blocked");
          break;
        }
      }
      if (decision.suggestedState === "budget_paused") {
        this.storage.persistPause(campaignId, { kind: "controller", id: "engine" }, "budget_paused");
        this.writeReport(campaignId, "budget_paused");
        break;
      }
    }
    const final = this.storage.getCampaign(campaignId);
    if (!this.storage.latestReport(campaignId)) {
      this.writeReport(campaignId, final.state);
    }
  }

  async runDecide(campaignId: string): Promise<TaskOutcome | null> {
    const claimed = this.storage.claimDecide(campaignId, this.config.instance_id);
    if (!claimed) return null;
    const camp = this.storage.getCampaign(campaignId);
    const lease: RunLease = {
      run_id: claimed.run_id,
      campaign_id: campaignId,
      step_id: null,
      mode: "decide",
      kind: "decide",
      attempt_no: 1,
      fence: claimed.fence,
      cancel_epoch: camp.cancel_epoch,
      deadline_ms: Date.now() + this.config.lease_ttl_ms,
      lease_owner: this.config.instance_id,
      continuation_of: null,
    };
    return this.runWorker(lease);
  }

  async runExecuteSlot(campaignId: string): Promise<TaskOutcome | null> {
    const camp = this.storage.getCampaign(campaignId);
    const claimed = this.storage.claimNextStep(campaignId, this.config.instance_id, camp.epoch);
    if (!claimed) return null;
    const lease: RunLease = {
      run_id: claimed.run_id,
      campaign_id: campaignId,
      step_id: claimed.step_id,
      mode: "execute",
      kind: claimed.kind,
      attempt_no: claimed.attempt_no,
      fence: claimed.fence,
      cancel_epoch: camp.cancel_epoch,
      deadline_ms: Date.now() + this.config.lease_ttl_ms,
      lease_owner: this.config.instance_id,
      continuation_of: null,
    };
    return this.runWorker(lease);
  }

  async runWorker(lease: RunLease): Promise<TaskOutcome> {
    const worker = this.factory.create(lease.mode, lease.run_id) as unknown as PiWorker;
    this.lastWorker = worker;
    const ctx = buildContextPack(this.storage, lease, { schema_version: SCHEMA_VERSION });
    const ctrl = new AbortController();
    await worker.start(lease, ctx, ctrl.signal);
    const outcome = await worker.settle();
    this.storage.finishRun(lease.campaign_id, lease.run_id, outcome);
    if (worker.modelGateway) this.modelSends += worker.modelGateway.modelSends;
    if (worker.toolGateway) {
      this.toolSends += worker.toolGateway.toolSends;
      this.envSends += worker.toolGateway.envSends;
    }
    return outcome;
  }

  snapshot(campaignId: string): CompletionSnapshot {
    const camp = this.storage.getCampaign(campaignId);
    const counts = this.storage.counts(campaignId);
    const findings = this.storage.list("findings", campaignId).map((f) => ({ status: f.status as never }));
    const coverage = this.storage.list("coverage_items", campaignId).map(
      (c) =>
        ({
          id: String(c.id),
          mandatory: Boolean(c.mandatory),
          applicability: c.applicability,
          execution_state: c.execution_state,
          outcome: c.outcome,
          evidence_state: c.evidence_state,
        }) as CoverageRow,
    );
    const world = this.storage.getWorld<LabWorld>(campaignId, freshWorld());
    const inFlightRuns = Number(
      (this.storage.store.db.prepare("SELECT COUNT(*) AS c FROM task_runs WHERE campaign_id = ? AND state IN ('claimed','running')").get(campaignId) as { c: number }).c,
    );
    const inFlightInv = this.invocations.nonTerminal(campaignId).length;
    return {
      mode: camp.spec.mode,
      state: camp.state,
      cancel_epoch: camp.cancel_epoch,
      in_flight_runs: inFlightRuns,
      in_flight_invocations: inFlightInv,
      unconsumed_events: this.storage.unconsumedCount(campaignId),
      pending_important_proposals: 0,
      uncertain_invocations: this.invocations
        .nonTerminal(campaignId)
        .filter((i) => i.state === "uncertain").length,
      empty_reviews: camp.empty_reviews,
      max_empty_reviews: camp.spec.stop_policy.max_empty_reviews_per_progress_epoch,
      ready_steps: counts.ready,
      blocked_steps: counts.blocked,
      frontier_size: counts.frontier,
      new_observation_since_progress: false,
      findings,
      coverage,
      root_goal_satisfied: oracleGoalSatisfied(world) && camp.spec.mode === "goal_seeking",
    };
  }

  writeReport(campaignId: string, stopReason: string): Record<string, unknown> {
    const camp = this.storage.getCampaign(campaignId);
    const world = this.storage.getWorld<LabWorld>(campaignId, freshWorld());
    const budget = this.budget.snapshot(campaignId);
    const findings = this.storage.list("findings", campaignId);
    const coverage = this.storage.list("coverage_items", campaignId);
    const facts = this.storage.list("facts", campaignId);
    const steps = this.storage.list("steps", campaignId);
    const unresolved = steps.filter((s) => !["resolved", "retired"].includes(String(s.status)));
    const report = {
      campaign_id: campaignId,
      mode: camp.spec.mode,
      state: camp.state,
      scope: camp.spec.scope,
      scope_version: camp.spec.scope_version,
      goal_version: camp.spec.goal_version,
      policy_version: camp.spec.policy_version,
      environment_revision: world.env_rev,
      findings: findings.map((f) => ({
        id: f.id,
        claim: f.claim,
        status: f.status,
        evidence_refs: f.evidence_refs_json,
      })),
      coverage: coverage.map((c) => ({
        obligation: c.obligation,
        applicability: c.applicability,
        execution_state: c.execution_state,
        outcome: c.outcome,
        evidence_state: c.evidence_state,
        mandatory: c.mandatory,
      })),
      observations: this.storage.list("observations", campaignId).map((o) => ({
        id: o.id,
        subject: o.subject,
        env_rev: o.env_rev,
      })),
      facts: facts.map((f) => ({ id: f.id, proposition: f.proposition, status: f.epistemic_status, grade: f.source_grade })),
      cost: {
        calls_spent: budget.spent_calls,
        calls_free: budget.free_calls,
        tokens_spent: budget.spent_tokens,
        cost_spent_micro: budget.spent_cost,
        unknown_liability_calls: budget.liability_calls,
        unknown_cost: Number(budget.liability_cost) > 0 || camp.spec.budget.price_version === "unknown",
      },
      stop_reason: stopReason,
      unresolved: unresolved.map((s) => ({ id: s.id, question: s.question, status: s.status, blocked_reason: s.blocked_reason })),
      bounded_conclusion: boundedConclusion(camp.spec, world, coverage),
    };
    this.storage.saveReport(campaignId, report);
    return report;
  }

  writeReportFile(destPath: string, report: unknown): void {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, JSON.stringify(report, null, 2));
  }

  status(campaignId: string): Record<string, unknown> {
    const camp = this.storage.getCampaign(campaignId);
    const counts = this.storage.counts(campaignId);
    const budget = this.budget.snapshot(campaignId);
    const activeRun = this.storage.store.db
      .prepare("SELECT id, mode, state FROM task_runs WHERE campaign_id = ? AND state IN ('claimed','running') LIMIT 1")
      .get(campaignId);
    return {
      campaign_id: campaignId,
      state: camp.state,
      active_run: activeRun ?? null,
      candidates_ready: counts.ready,
      blocked: counts.blocked,
      budget,
      progress_epoch: camp.progress_epoch,
      stop_reason: camp.state,
      schema_version: SCHEMA_VERSION,
    };
  }

  async backupTo(destDir: string): Promise<BackupReport> {
    return backupStore({
      db: this.storage.store.db,
      dbPath: this.storage.store.path,
      artifactRoot: this.config.artifact_root,
      destDir,
    });
  }

  close(): void {
    this.storage.close();
  }
}

export function restoreEngineData(backupDir: string, destDir: string): RestoreReport {
  return restoreStore({ backupDir, destDir });
}

function boundedConclusion(spec: CampaignSpec, world: LabWorld, coverage: Record<string, unknown>[]): string {
  const untested = coverage.filter((c) => c.execution_state !== "tested" && c.mandatory);
  if (spec.mode === "assessment" && untested.length) {
    return `In scope ${spec.scope_version}, condition env=${world.env_rev}, version goal=${spec.goal_version}, completed checks that have current evidence; ${untested.length} mandatory coverage item(s) untested. This is not a safety claim.`;
  }
  if (world.cabinet_open) {
    return `In scope ${spec.scope.profile}, env ${world.env_rev}: recovered sample ${world.sample_id}. Remaining uncertainty: synthetic world only.`;
  }
  return `In scope ${spec.scope.profile}, env ${world.env_rev}: sample not recovered. No statement that the world is safe.`;
}

export function openEngine(dataDir: string, options?: EngineOptions): Engine {
  return new Engine(makeRuntimeConfig(dataDir, `local-${randomUUID().slice(0, 8)}`), options);
}
