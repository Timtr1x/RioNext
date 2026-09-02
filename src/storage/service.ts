import { createHash } from "node:crypto";
import { DomainError, conflict, denied, invalidInput } from "../domain/errors.ts";
import { newId, newCorrelationId } from "../domain/ids.ts";
import { evalPredicate, type FactLookup } from "../domain/predicates.ts";
import { parseProposalOps } from "../domain/proposals.ts";
import { hashJson } from "../domain/fingerprint.ts";
import { transitionCampaign, transitionFinding, transitionStep } from "../domain/states.ts";
import type {
  Actor,
  CampaignRecord,
  CampaignSpec,
  CampaignState,
  CoverageApplicability,
  CoverageEvidenceState,
  CoverageExecutionState,
  CoverageOutcome,
  DomainEvent,
  EpistemicStatus,
  FactSourceGrade,
  FactValidity,
  FindingStatus,
  PredicateExpr,
  ProposalOp,
  StepKind,
  StepStatus,
  SubmitFactResultStatus,
  TaskOutcome,
  WakeCondition,
  WorkerMode,
} from "../domain/types.ts";
import { SCHEMA_VERSION } from "../version.ts";
import { pickFairReadyStep } from "../scheduler/fair.ts";
import { ArtifactStore, type StoredArtifact } from "./artifacts.ts";
import { Store, asJson, fromJson, nowIso } from "./db.ts";

export interface IdempotentResult {
  status: "ok" | "replayed" | "conflict";
  canonical_ids: Record<string, string>;
  seq: number;
  reason?: string;
  extra?: Record<string, unknown>;
}

export class StorageService {
  constructor(
    readonly store: Store,
    readonly artifacts: ArtifactStore,
  ) {}

  close(): void {
    this.store.close();
  }

  acquireControllerLock(campaignId: string, owner: string): void {
    this.store.transaction(() => {
      const existing = this.store.db.prepare("SELECT owner FROM controller_locks WHERE campaign_id = ?").get(campaignId) as
        | { owner: string }
        | undefined;
      if (existing && existing.owner !== owner) {
        throw denied("controller_lock_held", "another controller owns this campaign", { owner: existing.owner });
      }
      if (!existing) {
        this.store.db
          .prepare("INSERT INTO controller_locks(campaign_id, owner, acquired_at) VALUES (?, ?, ?)")
          .run(campaignId, owner, nowIso());
      }
    });
  }

  createCampaign(spec: CampaignSpec): CampaignRecord {
    const now = nowIso();
    this.store.transaction(() => {
      this.store.db
        .prepare(
          `INSERT INTO campaigns(id, spec_json, state, epoch, cancel_epoch, event_head, progress_epoch, reviewed_seq, requested_seq, empty_reviews, admission_open, created_at, updated_at)
           VALUES (?, ?, 'created', 0, 0, 0, 0, 0, 0, 0, 1, ?, ?)`,
        )
        .run(spec.campaign_id, asJson(spec), now, now);
      const seq = this.appendEvent(spec.campaign_id, "campaign.created", { spec }, { kind: "user", id: "cli" }, spec.campaign_id);
      const goalId = newId("goal");
      this.store.db
        .prepare(
          `INSERT INTO goals(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, statement, parent_id, is_root, success_predicate_ref, mandatory, status, evidence_refs_json)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, 1, ?, 1, 'active', '[]')`,
        )
        .run(goalId, spec.campaign_id, SCHEMA_VERSION, now, seq, seq, spec.root_goal.statement, spec.root_goal.success_predicate_ref);
      this.store.db
        .prepare(
          `INSERT INTO budget_accounts(
            campaign_id, currency, price_version,
            total_cost_micro, free_cost, reserved_cost, liability_cost, spent_cost, overrun_cost,
            total_tokens, free_tokens, reserved_tokens, liability_tokens, spent_tokens, overrun_tokens,
            total_calls, free_calls, reserved_calls, liability_calls, spent_calls, overrun_calls
          ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, 0, 0, 0, 0, ?, ?, 0, 0, 0, 0)`,
        )
        .run(
          spec.campaign_id,
          spec.budget.currency,
          spec.budget.price_version,
          spec.budget.max_cost_micro ?? 0,
          spec.budget.max_cost_micro ?? 0,
          spec.budget.max_tokens ?? 0,
          spec.budget.max_tokens ?? 0,
          spec.budget.max_calls ?? 0,
          spec.budget.max_calls ?? 0,
        );
      for (const obligation of spec.coverage_policy.mandatory_ids) {
        const covId = newId("cov");
        this.store.db
          .prepare(
            `INSERT INTO coverage_items(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, obligation, dimensions_json, applicability, execution_state, outcome, evidence_state, mandatory)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, '{}', 'applicable', 'untested', 'none', 'missing', 1)`,
          )
          .run(covId, spec.campaign_id, SCHEMA_VERSION, now, seq, seq, obligation);
      }
    });
    return this.getCampaign(spec.campaign_id);
  }

  getCampaign(id: string): CampaignRecord {
    const row = this.store.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw invalidInput("campaign_not_found", `campaign ${id} not found`);
    return {
      id: String(row.id),
      spec: fromJson<CampaignSpec>(String(row.spec_json), null as unknown as CampaignSpec),
      state: row.state as CampaignState,
      epoch: Number(row.epoch),
      cancel_epoch: Number(row.cancel_epoch),
      event_head: Number(row.event_head),
      progress_epoch: Number(row.progress_epoch),
      reviewed_seq: Number(row.reviewed_seq),
      requested_seq: Number(row.requested_seq),
      empty_reviews: Number(row.empty_reviews),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  setCampaignState(id: string, to: CampaignState, actor: Actor): void {
    this.store.transaction(() => {
      const camp = this.getCampaign(id);
      transitionCampaign(camp.state, to);
      this.store.db.prepare("UPDATE campaigns SET state = ?, updated_at = ? WHERE id = ?").run(to, nowIso(), id);
      this.appendEvent(id, "campaign.state_changed", { from: camp.state, to }, actor);
    });
  }

  persistCancel(id: string, actor: Actor): number {
    return this.store.transaction(() => {
      const camp = this.getCampaign(id);
      const cancelEpoch = camp.cancel_epoch + 1;
      const nextState = camp.state === "cancelled" ? "cancelled" : "cancelled";
      if (camp.state !== "cancelled") {
        transitionCampaign(camp.state, "cancelled");
      }
      this.store.db
        .prepare("UPDATE campaigns SET state = ?, cancel_epoch = ?, admission_open = 0, epoch = epoch + 1, updated_at = ? WHERE id = ?")
        .run(nextState, cancelEpoch, nowIso(), id);
      this.appendEvent(id, "control.changed", { command: "cancel", cancel_epoch: cancelEpoch }, actor);
      if (camp.state !== "cancelled") {
        this.appendEvent(id, "campaign.state_changed", { from: camp.state, to: "cancelled" }, actor);
      }
      return cancelEpoch;
    });
  }

  persistPause(id: string, actor: Actor, kind: "paused" | "budget_paused"): void {
    this.store.transaction(() => {
      const camp = this.getCampaign(id);
      transitionCampaign(camp.state, kind);
      this.store.db
        .prepare("UPDATE campaigns SET state = ?, admission_open = 0, epoch = epoch + 1, updated_at = ? WHERE id = ?")
        .run(kind, nowIso(), id);
      this.appendEvent(id, "control.changed", { command: kind }, actor);
      this.appendEvent(id, "campaign.state_changed", { from: camp.state, to: kind }, actor);
    });
  }

  persistResume(id: string, actor: Actor): void {
    this.store.transaction(() => {
      const camp = this.getCampaign(id);
      if (camp.state === "cancelled") {
        throw denied("cancelled_no_autoresume", "cancelled campaigns do not auto-resume");
      }
      transitionCampaign(camp.state, "active");
      this.store.db
        .prepare("UPDATE campaigns SET state = ?, admission_open = 1, epoch = epoch + 1, updated_at = ? WHERE id = ?")
        .run("active", nowIso(), id);
      this.appendEvent(id, "control.changed", { command: "resume" }, actor);
      this.appendEvent(id, "campaign.state_changed", { from: camp.state, to: "active" }, actor);
    });
  }

  persistHint(id: string, text: string, actor: Actor): number {
    return this.store.transaction(() => {
      const seq = this.appendEvent(id, "control.changed", { command: "hint", text }, actor);
      this.markRequested(id, seq);
      this.store.db.prepare("UPDATE campaigns SET epoch = epoch + 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
      return this.getCampaign(id).epoch;
    });
  }

  persistReviseBudget(id: string, patch: { max_calls?: number; max_tokens?: number; max_cost_micro?: number }, actor: Actor): number {
    return this.store.transaction(() => {
      const camp = this.getCampaign(id);
      if (patch.max_calls !== undefined && patch.max_calls < 0) throw invalidInput("negative_budget", "max_calls < 0");
      if (patch.max_tokens !== undefined && patch.max_tokens < 0) throw invalidInput("negative_budget", "max_tokens < 0");
      if (patch.max_cost_micro !== undefined && patch.max_cost_micro < 0) throw invalidInput("negative_budget", "max_cost_micro < 0");
      const spec = camp.spec;
      if (patch.max_calls !== undefined) spec.budget.max_calls = patch.max_calls;
      if (patch.max_tokens !== undefined) spec.budget.max_tokens = patch.max_tokens;
      if (patch.max_cost_micro !== undefined) spec.budget.max_cost_micro = patch.max_cost_micro;
      this.store.db.prepare("UPDATE campaigns SET spec_json = ?, epoch = epoch + 1, updated_at = ? WHERE id = ?").run(asJson(spec), nowIso(), id);
      if (patch.max_calls !== undefined) {
        this.store.db
          .prepare("UPDATE budget_accounts SET total_calls = ?, free_calls = MAX(0, ? - spent_calls - reserved_calls - liability_calls) WHERE campaign_id = ?")
          .run(patch.max_calls, patch.max_calls, id);
      }
      if (patch.max_tokens !== undefined) {
        this.store.db
          .prepare("UPDATE budget_accounts SET total_tokens = ?, free_tokens = MAX(0, ? - spent_tokens - reserved_tokens - liability_tokens) WHERE campaign_id = ?")
          .run(patch.max_tokens, patch.max_tokens, id);
      }
      const seq = this.appendEvent(id, "control.changed", { command: "revise_budget", patch }, actor);
      this.markRequested(id, seq);
      return this.getCampaign(id).epoch;
    });
  }

  persistReviseScope(id: string, scope_version: string, actor: Actor): number {
    return this.store.transaction(() => {
      const camp = this.getCampaign(id);
      camp.spec.scope_version = scope_version;
      this.store.db.prepare("UPDATE campaigns SET spec_json = ?, epoch = epoch + 1, updated_at = ? WHERE id = ?").run(asJson(camp.spec), nowIso(), id);
      const seq = this.appendEvent(id, "control.changed", { command: "revise_scope", scope_version }, actor);
      this.markRequested(id, seq);
      return this.getCampaign(id).epoch;
    });
  }

  haltAdmission(campaignId: string, reason: string): void {
    this.store.db
      .prepare("UPDATE campaigns SET admission_open = 0, updated_at = ? WHERE id = ?")
      .run(nowIso(), campaignId);
    this.appendEvent(campaignId, "control.changed", { command: "halt_admission", reason }, { kind: "controller", id: "fault" });
  }

  registerOperation(campaignId: string, invocationId: string, executionId: string): void {
    this.store.db
      .prepare(
        "INSERT INTO operations(execution_id, campaign_id, invocation_id, state, next_poll_at, created_at) VALUES (?, ?, ?, 'running', NULL, ?)",
      )
      .run(executionId, campaignId, invocationId, nowIso());
  }

  getOperation(executionId: string): Record<string, unknown> | undefined {
    return this.store.db.prepare("SELECT * FROM operations WHERE execution_id = ?").get(executionId) as Record<string, unknown> | undefined;
  }

  acquireResourceLock(campaignId: string, lockKey: string, invocationId: string, effectKnown: boolean): boolean {
    try {
      this.store.db
        .prepare("INSERT INTO resource_locks(lock_key, campaign_id, invocation_id, effect_known, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(lockKey, campaignId, invocationId, effectKnown ? 1 : 0, nowIso());
      return true;
    } catch {
      return false;
    }
  }

  explainStep(campaignId: string, stepId: string): Record<string, unknown> {
    const step = this.store.db.prepare("SELECT * FROM steps WHERE id = ? AND campaign_id = ?").get(stepId, campaignId) as
      | Record<string, unknown>
      | undefined;
    if (!step) throw invalidInput("step_not_found", "step not found");
    const runs = this.store.db
      .prepare("SELECT id, state, end_reason, outcome_json, attempt_no FROM task_runs WHERE step_id = ? ORDER BY attempt_no")
      .all(stepId) as Record<string, unknown>[];
    return {
      step_id: stepId,
      status: step.status,
      blocked_reason: step.blocked_reason,
      last_failure: step.last_failure,
      reopen_rule: step.reopen_rule_json,
      attempt_count: step.attempt_count,
      ready_since: step.ready_since,
      preconditions: step.preconditions_json,
      eligible: step.status === "ready",
      runs,
    };
  }

  admissionOpen(campaignId: string): boolean {
    const row = this.store.db.prepare("SELECT admission_open, state, cancel_epoch FROM campaigns WHERE id = ?").get(campaignId) as
      | { admission_open: number; state: string; cancel_epoch: number }
      | undefined;
    if (!row) return false;
    return row.admission_open === 1 && row.state !== "cancelled" && row.state !== "paused" && row.state !== "completed";
  }

  submit(
    campaignId: string,
    producerId: string,
    submissionId: string,
    payload: unknown,
    apply: () => IdempotentResult,
  ): IdempotentResult {
    return this.store.transaction(() => {
      const payloadHash = hashJson(payload);
      const existing = this.store.db
        .prepare("SELECT payload_hash, result_json FROM submissions WHERE campaign_id = ? AND producer_id = ? AND submission_id = ?")
        .get(campaignId, producerId, submissionId) as { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw conflict("submission_conflict", "same submission_id with different payload", {
            campaignId,
            producerId,
            submissionId,
          });
        }
        const replayed = fromJson<IdempotentResult>(existing.result_json, { status: "ok", canonical_ids: {}, seq: 0 });
        return { ...replayed, status: "replayed" };
      }
      const result = apply();
      this.store.db
        .prepare(
          "INSERT INTO submissions(campaign_id, producer_id, submission_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(campaignId, producerId, submissionId, payloadHash, asJson(result), nowIso());
      return result;
    });
  }

  async putArtifact(campaignId: string, body: string | Buffer, mime: string, producerAttempt?: string): Promise<StoredArtifact> {
    const stored = await this.artifacts.put(campaignId, body, mime);
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO artifacts(id, campaign_id, hash, size, mime, path, producer_attempt, integrity_state, truncated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', 0, ?)`,
      )
      .run(stored.id, campaignId, stored.hash, stored.size, stored.mime, stored.path, producerAttempt ?? null, nowIso());
    return stored;
  }

  recordObservation(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id: string;
    attempt_id: string;
    subject: string;
    body: unknown;
    artifact_refs: string[];
    conditions: Record<string, unknown>;
    env_rev: string;
    identity_ref?: string;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, () => {
      this.assertRun(args.campaign_id, args.run_id);
      const now = nowIso();
      const id = newId("obs");
      const seq = this.appendEvent(
        args.campaign_id,
        "observation.recorded",
        { observation_id: id, subject: args.subject },
        { kind: "worker", id: args.run_id },
        id,
        args.submission_id,
      );
      this.store.db
        .prepare(
          `INSERT INTO observations(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, source_run_id, source_submission_id, attempt_id, artifact_refs_json, observed_at, subject, identity_ref, conditions_json, env_rev, collector_version, body_json)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'p0', ?)`,
        )
        .run(
          id,
          args.campaign_id,
          SCHEMA_VERSION,
          now,
          seq,
          seq,
          args.run_id,
          args.submission_id,
          args.attempt_id,
          asJson(args.artifact_refs),
          now,
          args.subject,
          args.identity_ref ?? null,
          asJson(args.conditions),
          args.env_rev,
          asJson(args.body),
        );
      this.bumpProgress(args.campaign_id);
      this.markRequested(args.campaign_id, seq);
      return { status: "ok", canonical_ids: { observation_id: id }, seq };
    });
  }

  submitFact(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id: string;
    proposition: string;
    fact_key?: string;
    support_refs: string[];
    conditions: Record<string, unknown>;
    env_rev?: string;
    identity_ref?: string;
    source_grade?: FactSourceGrade;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, (): IdempotentResult => {
      this.assertRun(args.campaign_id, args.run_id);
      const supportOk = args.support_refs.length > 0 && this.refsExist(args.campaign_id, args.support_refs);
      if (!supportOk) {
        return {
          status: "ok" as const,
          canonical_ids: {} as Record<string, string>,
          seq: this.getCampaign(args.campaign_id).event_head,
          reason: "rejected",
          extra: { submit_status: "rejected" satisfies SubmitFactResultStatus, detail: "missing_evidence" },
        };
      }
      const grade: FactSourceGrade = args.source_grade ?? "observed";
      if (grade === "verified") {
        throw denied("fact_verified_forbidden", "submit_fact cannot mark verified");
      }
      const now = nowIso();
      const id = newId("fact");
      let epistemic: EpistemicStatus = "accepted";
      let submitStatus: SubmitFactResultStatus = "accepted_as_observation";
      if (grade === "derived") {
        epistemic = "proposed";
        submitStatus = "pending_verification";
      }
      const opposite = this.findOpposite(args.campaign_id, args.proposition, args.fact_key);
      if (opposite) {
        epistemic = "disputed";
        this.store.db.prepare("UPDATE facts SET epistemic_status = 'disputed', revision = revision + 1 WHERE id = ?").run(opposite);
      }
      const seq = this.appendEvent(
        args.campaign_id,
        "fact.accepted",
        { fact_id: id, epistemic, grade, submit_status: submitStatus },
        { kind: "worker", id: args.run_id },
        id,
        args.submission_id,
      );
      this.store.db
        .prepare(
          `INSERT INTO facts(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, source_run_id, source_submission_id, proposition, fact_key, epistemic_status, source_grade, validity, support_refs_json, counter_refs_json, conditions_json, env_rev, observed_at, identity_ref)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          args.campaign_id,
          SCHEMA_VERSION,
          now,
          seq,
          seq,
          args.run_id,
          args.submission_id,
          args.proposition,
          args.fact_key ?? null,
          epistemic,
          grade,
          asJson(args.support_refs),
          asJson(opposite ? [opposite] : []),
          asJson(args.conditions),
          args.env_rev ?? null,
          now,
          args.identity_ref ?? null,
        );
      this.bumpProgress(args.campaign_id);
      this.markRequested(args.campaign_id, seq);
      this.recomputeStepReadiness(args.campaign_id);
      return {
        status: "ok",
        canonical_ids: { fact_id: id },
        seq,
        extra: { submit_status: submitStatus, epistemic },
      };
    });
  }

  submitFinding(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id: string;
    claim: string;
    evidence_refs: string[];
    dedup_key: string;
    impact?: string;
    conditions?: Record<string, unknown>;
    model_confidence?: number;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, (): IdempotentResult => {
      this.assertRun(args.campaign_id, args.run_id);
      if (args.evidence_refs.length === 0 || !this.refsExist(args.campaign_id, args.evidence_refs)) {
        return {
          status: "ok" as const,
          canonical_ids: {} as Record<string, string>,
          seq: this.getCampaign(args.campaign_id).event_head,
          reason: "rejected",
          extra: { status: "rejected", detail: "missing_evidence" },
        };
      }
      const existing = this.store.db
        .prepare("SELECT id, status FROM findings WHERE campaign_id = ? AND dedup_key = ?")
        .get(args.campaign_id, args.dedup_key) as { id: string; status: string } | undefined;
      if (existing) {
        return {
          status: "ok",
          canonical_ids: { finding_id: existing.id },
          seq: this.getCampaign(args.campaign_id).event_head,
          extra: { status: existing.status, deduped: true },
        };
      }
      const id = newId("find");
      const now = nowIso();
      const seq = this.appendEvent(
        args.campaign_id,
        "finding.proposed",
        { finding_id: id, claim: args.claim },
        { kind: "worker", id: args.run_id },
        id,
        args.submission_id,
      );
      this.store.db
        .prepare(
          `INSERT INTO findings(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, source_run_id, source_submission_id, claim, scope_json, conditions_json, evidence_refs_json, verification_refs_json, status, dedup_key, impact, confidence_model)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '{}', ?, ?, '[]', 'suspected', ?, ?, ?)`,
        )
        .run(
          id,
          args.campaign_id,
          SCHEMA_VERSION,
          now,
          seq,
          seq,
          args.run_id,
          args.submission_id,
          args.claim,
          asJson(args.conditions ?? {}),
          asJson(args.evidence_refs),
          args.dedup_key,
          args.impact ?? null,
          args.model_confidence != null ? String(args.model_confidence) : null,
        );
      this.markRequested(args.campaign_id, seq);
      return { status: "ok", canonical_ids: { finding_id: id }, seq, extra: { status: "suspected" } };
    });
  }

  setFindingStatus(campaignId: string, findingId: string, to: FindingStatus, actor: Actor): void {
    this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT status FROM findings WHERE id = ? AND campaign_id = ?").get(findingId, campaignId) as
        | { status: FindingStatus }
        | undefined;
      if (!row) throw invalidInput("finding_not_found", "finding not found");
      transitionFinding(row.status, to);
      this.store.db.prepare("UPDATE findings SET status = ?, revision = revision + 1 WHERE id = ?").run(to, findingId);
      this.appendEvent(campaignId, "finding.status_changed", { finding_id: findingId, from: row.status, to }, actor, findingId);
    });
  }

  proposeStepDirect(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id?: string;
    question: string;
    kind: StepKind;
    goal_refs: string[];
    preconditions: PredicateExpr;
    method_family: string;
    expected_observations: string[];
    completion_criteria: string;
    fingerprint: string;
    reopen_rule: WakeCondition;
    branch_id?: string;
    input_refs?: { id: string; revision: number }[];
    priority?: number;
    retry_reason?: string;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, (): IdempotentResult => {
      this.assertRefsSameCampaign(args.campaign_id, args.goal_refs);
      if (args.input_refs) {
        for (const ref of args.input_refs) {
          this.assertEntityCampaign(args.campaign_id, ref.id);
        }
      }
      const dup = this.store.db
        .prepare("SELECT id, status, attempt_count FROM steps WHERE campaign_id = ? AND fingerprint = ? AND status != 'retired'")
        .get(args.campaign_id, args.fingerprint) as { id: string; status: string; attempt_count: number } | undefined;
      if (dup) {
        if (args.retry_reason) {
          this.store.db
            .prepare("UPDATE steps SET retry_reason = ?, revision = revision + 1 WHERE id = ?")
            .run(args.retry_reason, dup.id);
        }
        return {
          status: "ok" as const,
          canonical_ids: { step_id: dup.id } as Record<string, string>,
          seq: this.getCampaign(args.campaign_id).event_head,
          extra: { merged: true, attempt_count: dup.attempt_count },
        };
      }
      const id = newId("step");
      const branch = args.branch_id ?? newId("br");
      const now = nowIso();
      const seq = this.appendEvent(
        args.campaign_id,
        "step.proposed",
        { step_id: id, question: args.question, kind: args.kind },
        { kind: "worker", id: args.run_id ?? args.producer_id },
        id,
        args.submission_id,
      );
      const ready = this.preconditionValue(args.campaign_id, args.preconditions);
      let status: StepStatus = "proposed";
      let blocked: string | null = null;
      if (ready === "true") status = "ready";
      else if (ready === "unknown" || ready === "false") {
        status = "blocked";
        blocked = ready === "unknown" ? "unknown_precondition" : "precondition_false";
      }
      this.store.db
        .prepare(
          `INSERT INTO steps(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, source_run_id, source_submission_id, branch_id, kind, question, goal_refs_json, input_refs_json, preconditions_json, method_family, expected_observations_json, completion_criteria, resource_claims_json, budget_hint_json, fingerprint, reopen_rule_json, status, priority, ready_since, attempt_count, retry_reason, blocked_reason)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          args.campaign_id,
          SCHEMA_VERSION,
          now,
          seq,
          seq,
          args.run_id ?? null,
          args.submission_id,
          branch,
          args.kind,
          args.question,
          asJson(args.goal_refs),
          asJson(args.input_refs ?? []),
          asJson(args.preconditions),
          args.method_family,
          asJson(args.expected_observations),
          args.completion_criteria,
          args.fingerprint,
          asJson(args.reopen_rule),
          status,
          args.priority ?? 100,
          status === "ready" ? now : null,
          args.retry_reason ?? null,
          blocked,
        );
      if (status === "ready") {
        this.appendEvent(args.campaign_id, "step.ready", { step_id: id }, { kind: "controller", id: "scheduler" }, id);
      } else if (status === "blocked") {
        this.appendEvent(args.campaign_id, "step.blocked", { step_id: id, reason: blocked }, { kind: "controller", id: "scheduler" }, id);
      }
      this.markRequested(args.campaign_id, seq);
      return { status: "ok", canonical_ids: { step_id: id, branch_id: branch }, seq, extra: { step_status: status } };
    });
  }

  applyProposalBatch(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id: string;
    operations: unknown;
    no_change_reason?: string;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, () => {
      const camp = this.getCampaign(args.campaign_id);
      const ops = parseProposalOps(args.operations);
      if (ops.length === 0) {
        const seq = camp.event_head;
        this.store.db
          .prepare(
            "INSERT INTO decision_runs(id, campaign_id, run_id, read_set_json, operations_json, committed, reviewed_seq, reason, created_at) VALUES (?, ?, ?, '[]', '[]', 1, ?, ?, ?)",
          )
          .run(newId("dec"), args.campaign_id, args.run_id, camp.requested_seq, args.no_change_reason ?? "no_change", nowIso());
        this.store.db
          .prepare("UPDATE campaigns SET reviewed_seq = requested_seq, empty_reviews = empty_reviews + 1, updated_at = ? WHERE id = ?")
          .run(nowIso(), args.campaign_id);
        this.appendEvent(args.campaign_id, "decision.committed", { no_change: true }, { kind: "worker", id: args.run_id });
        return { status: "ok", canonical_ids: {}, seq, extra: { no_change: true } };
      }
      const ids: Record<string, string> = {};
      let seq = camp.event_head;
      for (const op of ops) {
        seq = this.applyOneOp(args.campaign_id, args.run_id, args.submission_id, op, ids);
      }
      this.store.db
        .prepare(
          "INSERT INTO decision_runs(id, campaign_id, run_id, read_set_json, operations_json, committed, reviewed_seq, reason, created_at) VALUES (?, ?, ?, '[]', ?, 1, ?, NULL, ?)",
        )
        .run(newId("dec"), args.campaign_id, args.run_id, asJson(ops), this.getCampaign(args.campaign_id).requested_seq, nowIso());
      this.store.db
        .prepare("UPDATE campaigns SET reviewed_seq = requested_seq, empty_reviews = 0, updated_at = ? WHERE id = ?")
        .run(nowIso(), args.campaign_id);
      this.appendEvent(args.campaign_id, "decision.committed", { ops: ops.map((o) => o.op) }, { kind: "worker", id: args.run_id });
      return { status: "ok", canonical_ids: ids, seq };
    });
  }

  failDecision(campaignId: string, runId: string, reason: string): void {
    this.store.db
      .prepare(
        "INSERT INTO decision_runs(id, campaign_id, run_id, read_set_json, operations_json, committed, reviewed_seq, reason, created_at) VALUES (?, ?, ?, '[]', '[]', 0, NULL, ?, ?)",
      )
      .run(newId("dec"), campaignId, runId, reason, nowIso());
  }

  claimNextStep(campaignId: string, owner: string, fenceSeed: number): { step_id: string; run_id: string; fence: number; kind: StepKind; question: string; attempt_no: number } | null {
    return this.store.transaction(() => {
      if (!this.admissionOpen(campaignId)) return null;
      const camp = this.getCampaign(campaignId);
      if (camp.state === "cancelled" || camp.state === "paused" || camp.state === "budget_paused" || camp.state === "completed") {
        return null;
      }
      const lock = this.store.db.prepare("SELECT execute_lock_owner FROM campaigns WHERE id = ?").get(campaignId) as
        | { execute_lock_owner: string | null }
        | undefined;
      if (lock?.execute_lock_owner) return null;
      this.recomputeStepReadiness(campaignId);
      const fairId = pickFairReadyStep(this, campaignId);
      const step = fairId
        ? (this.store.db
            .prepare("SELECT id, kind, question, attempt_count, revision FROM steps WHERE id = ?")
            .get(fairId) as { id: string; kind: StepKind; question: string; attempt_count: number; revision: number } | undefined)
        : (this.store.db
            .prepare(
              `SELECT id, kind, question, attempt_count, revision FROM steps
           WHERE campaign_id = ? AND status = 'ready'
           ORDER BY CASE kind WHEN 'verify' THEN 0 WHEN 'reconcile' THEN 1 WHEN 'acquire_prerequisite' THEN 2 ELSE 3 END,
                    priority ASC, ready_since ASC
           LIMIT 1`,
            )
            .get(campaignId) as { id: string; kind: StepKind; question: string; attempt_count: number; revision: number } | undefined);
      if (!step) return null;
      transitionStep("ready", "leased");
      const now = nowIso();
      const attempt = step.attempt_count + 1;
      this.store.db
        .prepare("UPDATE steps SET status = 'leased', attempt_count = ?, revision = revision + 1, updated_seq = updated_seq WHERE id = ?")
        .run(attempt, step.id);
      const runId = newId("run");
      const fence = fenceSeed + attempt;
      this.store.db
        .prepare(
          `INSERT INTO task_runs(id, campaign_id, step_id, mode, kind, attempt_no, lease_owner, fence, deadline_ms, state, continuation_of, finish_requested, env_admission, created_at, updated_at)
           VALUES (?, ?, ?, 'execute', ?, ?, ?, ?, ?, 'claimed', NULL, 0, 1, ?, ?)`,
        )
        .run(runId, campaignId, step.id, step.kind, attempt, owner, fence, Date.now() + 60_000, now, now);
      this.store.db.prepare("UPDATE campaigns SET execute_lock_owner = ?, updated_at = ? WHERE id = ?").run(owner, now, campaignId);
      this.appendEvent(campaignId, "run.claimed", { run_id: runId, step_id: step.id }, { kind: "controller", id: owner }, runId);
      this.store.db.prepare("UPDATE steps SET status = 'running', revision = revision + 1 WHERE id = ?").run(step.id);
      this.store.db.prepare("UPDATE task_runs SET state = 'running', updated_at = ? WHERE id = ?").run(now, runId);
      return { step_id: step.id, run_id: runId, fence, kind: step.kind, question: step.question, attempt_no: attempt };
    });
  }

  claimDecide(campaignId: string, owner: string): { run_id: string; fence: number } | null {
    return this.store.transaction(() => {
      const camp = this.getCampaign(campaignId);
      if (camp.state === "cancelled" || camp.state === "paused" || camp.state === "completed") return null;
      const row = this.store.db.prepare("SELECT decide_lock_owner, requested_seq, reviewed_seq FROM campaigns WHERE id = ?").get(campaignId) as
        | { decide_lock_owner: string | null; requested_seq: number; reviewed_seq: number }
        | undefined;
      if (!row) return null;
      if (row.decide_lock_owner) return null;
      if (row.requested_seq <= row.reviewed_seq && camp.state !== "created" && camp.state !== "active") {
        // still allow first decide
      }
      const runId = newId("run");
      const now = nowIso();
      this.store.db.prepare("UPDATE campaigns SET decide_lock_owner = ?, updated_at = ? WHERE id = ?").run(owner, now, campaignId);
      this.store.db
        .prepare(
          `INSERT INTO task_runs(id, campaign_id, step_id, mode, kind, attempt_no, lease_owner, fence, deadline_ms, state, continuation_of, finish_requested, env_admission, created_at, updated_at)
           VALUES (?, ?, NULL, 'decide', 'decide', 1, ?, 1, ?, 'running', NULL, 0, 0, ?, ?)`,
        )
        .run(runId, campaignId, owner, Date.now() + 60_000, now, now);
      this.appendEvent(campaignId, "run.claimed", { run_id: runId, mode: "decide" }, { kind: "controller", id: owner }, runId);
      return { run_id: runId, fence: 1 };
    });
  }

  finishRun(campaignId: string, runId: string, outcome: TaskOutcome): void {
    this.store.transaction(() => {
      const run = this.store.db.prepare("SELECT * FROM task_runs WHERE id = ? AND campaign_id = ?").get(runId, campaignId) as
        | Record<string, unknown>
        | undefined;
      if (!run) throw invalidInput("run_not_found", "run not found");
      const now = nowIso();
      this.store.db
        .prepare("UPDATE task_runs SET state = 'finished', end_reason = ?, outcome_json = ?, updated_at = ? WHERE id = ?")
        .run(outcome.reason, asJson(outcome), now, runId);
      if (run.mode === "decide") {
        this.store.db.prepare("UPDATE campaigns SET decide_lock_owner = NULL, updated_at = ? WHERE id = ?").run(now, campaignId);
      } else {
        this.store.db.prepare("UPDATE campaigns SET execute_lock_owner = NULL, updated_at = ? WHERE id = ?").run(now, campaignId);
        const stepId = run.step_id as string | null;
        if (stepId) {
          const next = outcomeToStepStatus(outcome.reason);
          const step = this.store.db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: StepStatus };
          if (step.status === "running" || step.status === "leased") {
            transitionStep(step.status === "leased" ? "running" : "running", next);
            this.store.db
              .prepare("UPDATE steps SET status = ?, blocked_reason = ?, last_failure = ?, ready_since = CASE WHEN ? = 'ready' THEN ? ELSE ready_since END, revision = revision + 1 WHERE id = ?")
              .run(next, outcome.blocked_on, outcome.summary, next, now, stepId);
            if (next === "ready") {
              this.appendEvent(campaignId, "step.ready", { step_id: stepId }, { kind: "controller", id: "scheduler" }, stepId);
            }
          }
        }
      }
      this.appendEvent(campaignId, "run.finished", { run_id: runId, outcome }, { kind: "controller", id: "engine" }, runId);
      this.markRequested(campaignId, this.getCampaign(campaignId).event_head);
    });
  }

  markFinishRequested(campaignId: string, runId: string, fence: number): void {
    const run = this.store.db.prepare("SELECT fence FROM task_runs WHERE id = ? AND campaign_id = ?").get(runId, campaignId) as
      | { fence: number }
      | undefined;
    if (!run || run.fence !== fence) {
      throw denied("stale_fence", "finish rejected due to stale fence");
    }
    this.store.db
      .prepare("UPDATE task_runs SET finish_requested = 1, env_admission = 0, updated_at = ? WHERE id = ?")
      .run(nowIso(), runId);
  }

  envAdmissionOpen(runId: string): boolean {
    const row = this.store.db.prepare("SELECT env_admission, finish_requested FROM task_runs WHERE id = ?").get(runId) as
      | { env_admission: number; finish_requested: number }
      | undefined;
    return !!row && row.env_admission === 1 && row.finish_requested === 0;
  }

  getRun(runId: string): Record<string, unknown> {
    const row = this.store.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row) throw invalidInput("run_not_found", "run not found");
    return row;
  }

  saveManifest(runId: string, manifest: unknown): void {
    this.store.db.prepare("UPDATE task_runs SET context_manifest_json = ?, updated_at = ? WHERE id = ?").run(asJson(manifest), nowIso(), runId);
  }

  recomputeStepReadiness(campaignId: string): void {
    const steps = this.store.db
      .prepare("SELECT id, status, preconditions_json, reopen_rule_json FROM steps WHERE campaign_id = ? AND status IN ('proposed','blocked','deferred','ready')")
      .all(campaignId) as { id: string; status: StepStatus; preconditions_json: string; reopen_rule_json: string }[];
    const now = nowIso();
    for (const s of steps) {
      const pred = fromJson<PredicateExpr>(s.preconditions_json, { op: "all", of: [] });
      const value = this.preconditionValue(campaignId, pred);
      if (value === "true" && (s.status === "blocked" || s.status === "proposed" || s.status === "deferred")) {
        const from = s.status;
        this.store.db
          .prepare("UPDATE steps SET status = 'ready', blocked_reason = NULL, ready_since = COALESCE(ready_since, ?), revision = revision + 1 WHERE id = ?")
          .run(now, s.id);
        this.appendEvent(campaignId, "step.ready", { step_id: s.id, from }, { kind: "controller", id: "scheduler" }, s.id);
      } else if (value !== "true" && s.status === "ready") {
        this.store.db
          .prepare("UPDATE steps SET status = 'blocked', blocked_reason = ?, revision = revision + 1 WHERE id = ?")
          .run(value === "unknown" ? "unknown_precondition" : "precondition_false", s.id);
        this.appendEvent(campaignId, "step.blocked", { step_id: s.id, reason: value }, { kind: "controller", id: "scheduler" }, s.id);
      }
    }
  }

  graphQuery(campaignId: string, args: { entity: string; limit?: number; offset?: number; q?: string; depth?: number }): {
    items: unknown[];
    truncated: boolean;
    omitted: number;
    snapshot_seq: number;
  } {
    const limit = Math.min(args.limit ?? 20, 50);
    const offset = args.offset ?? 0;
    const camp = this.getCampaign(campaignId);
    let rows: unknown[] = [];
    switch (args.entity) {
      case "facts":
        rows = this.store.db
          .prepare(
            "SELECT id, proposition, fact_key, epistemic_status, source_grade, validity, support_refs_json, counter_refs_json, conditions_json FROM facts WHERE campaign_id = ? ORDER BY created_seq LIMIT ? OFFSET ?",
          )
          .all(campaignId, limit + 1, offset);
        break;
      case "steps":
        rows = this.store.db
          .prepare(
            "SELECT id, kind, question, status, priority, blocked_reason, last_failure, fingerprint, attempt_count, branch_id, preconditions_json FROM steps WHERE campaign_id = ? ORDER BY created_seq LIMIT ? OFFSET ?",
          )
          .all(campaignId, limit + 1, offset);
        break;
      case "goals":
        rows = this.store.db
          .prepare("SELECT id, statement, is_root, status, parent_id FROM goals WHERE campaign_id = ? ORDER BY created_seq LIMIT ? OFFSET ?")
          .all(campaignId, limit + 1, offset);
        break;
      case "findings":
        rows = this.store.db
          .prepare("SELECT id, claim, status, evidence_refs_json, dedup_key FROM findings WHERE campaign_id = ? ORDER BY created_seq LIMIT ? OFFSET ?")
          .all(campaignId, limit + 1, offset);
        break;
      case "coverage":
        rows = this.store.db
          .prepare("SELECT id, obligation, applicability, execution_state, outcome, evidence_state, mandatory FROM coverage_items WHERE campaign_id = ? LIMIT ? OFFSET ?")
          .all(campaignId, limit + 1, offset);
        break;
      case "observations":
        rows = this.store.db
          .prepare("SELECT id, subject, body_json, env_rev, observed_at FROM observations WHERE campaign_id = ? ORDER BY created_seq LIMIT ? OFFSET ?")
          .all(campaignId, limit + 1, offset);
        break;
      default:
        throw invalidInput("unknown_entity", `graph_query entity ${args.entity} not allowed`);
    }
    const truncated = rows.length > limit;
    const items = truncated ? rows.slice(0, limit) : rows;
    return { items, truncated, omitted: truncated ? 1 : 0, snapshot_seq: camp.event_head };
  }

  list(table: string, campaignId: string): Record<string, unknown>[] {
    const allowed = new Set(["steps", "facts", "findings", "events", "observations", "coverage_items", "task_runs", "invocations", "goals"]);
    if (!allowed.has(table)) throw denied("table_not_allowed", table);
    return this.store.db.prepare(`SELECT * FROM ${table} WHERE campaign_id = ? ORDER BY rowid`).all(campaignId) as Record<
      string,
      unknown
    >[];
  }

  consumeEvents(campaignId: string): DomainEvent[] {
    const rows = this.store.db
      .prepare("SELECT * FROM events WHERE campaign_id = ? AND consumed = 0 ORDER BY seq")
      .all(campaignId) as Record<string, unknown>[];
    this.store.db.prepare("UPDATE events SET consumed = 1 WHERE campaign_id = ? AND consumed = 0").run(campaignId);
    return rows.map(rowToEvent);
  }

  unconsumedCount(campaignId: string): number {
    const row = this.store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE campaign_id = ? AND consumed = 0").get(campaignId) as {
      c: number;
    };
    return Number(row.c);
  }

  counts(campaignId: string): {
    ready: number;
    blocked: number;
    deferred: number;
    running: number;
    frontier: number;
  } {
    const ready = (this.store.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE campaign_id = ? AND status = 'ready'").get(campaignId) as { c: number }).c;
    const blocked = (this.store.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE campaign_id = ? AND status = 'blocked'").get(campaignId) as { c: number }).c;
    const deferred = (this.store.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE campaign_id = ? AND status = 'deferred'").get(campaignId) as { c: number }).c;
    const running = (this.store.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE campaign_id = ? AND status IN ('leased','running')").get(campaignId) as { c: number }).c;
    return { ready: Number(ready), blocked: Number(blocked), deferred: Number(deferred), running: Number(running), frontier: Number(ready) + Number(blocked) + Number(deferred) + Number(running) };
  }

  updateCoverage(
    campaignId: string,
    obligation: string,
    patch: Partial<{
      execution_state: CoverageExecutionState;
      outcome: CoverageOutcome;
      evidence_state: CoverageEvidenceState;
      applicability: CoverageApplicability;
    }>,
  ): void {
    const row = this.store.db
      .prepare("SELECT id, execution_state FROM coverage_items WHERE campaign_id = ? AND obligation = ?")
      .get(campaignId, obligation) as { id: string; execution_state: string } | undefined;
    if (!row) return;
    this.store.db
      .prepare(
        `UPDATE coverage_items SET
          execution_state = COALESCE(?, execution_state),
          outcome = COALESCE(?, outcome),
          evidence_state = COALESCE(?, evidence_state),
          applicability = COALESCE(?, applicability),
          revision = revision + 1
         WHERE id = ?`,
      )
      .run(patch.execution_state ?? null, patch.outcome ?? null, patch.evidence_state ?? null, patch.applicability ?? null, row.id);
    this.appendEvent(campaignId, "coverage.updated", { obligation, patch }, { kind: "controller", id: "engine" }, row.id);
  }

  saveWorld(campaignId: string, world: unknown): void {
    this.store.db
      .prepare("INSERT INTO world_state(campaign_id, json) VALUES (?, ?) ON CONFLICT(campaign_id) DO UPDATE SET json = excluded.json")
      .run(campaignId, asJson(world));
  }

  getWorld<T>(campaignId: string, fallback: T): T {
    const row = this.store.db.prepare("SELECT json FROM world_state WHERE campaign_id = ?").get(campaignId) as { json: string } | undefined;
    return row ? fromJson<T>(row.json, fallback) : fallback;
  }

  saveReport(campaignId: string, report: unknown): string {
    const id = newId("snap");
    const seq = this.getCampaign(campaignId).event_head;
    this.store.db
      .prepare("INSERT INTO report_snapshots(id, campaign_id, seq, json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, campaignId, seq, asJson(report), nowIso());
    return id;
  }

  latestReport(campaignId: string): unknown | null {
    const row = this.store.db
      .prepare("SELECT json FROM report_snapshots WHERE campaign_id = ? ORDER BY seq DESC LIMIT 1")
      .get(campaignId) as { json: string } | undefined;
    return row ? fromJson(row.json, null) : null;
  }

  incrementEmptyReviews(campaignId: string): number {
    this.store.db.prepare("UPDATE campaigns SET empty_reviews = empty_reviews + 1, updated_at = ? WHERE id = ?").run(nowIso(), campaignId);
    return this.getCampaign(campaignId).empty_reviews;
  }

  resetEmptyReviews(campaignId: string): void {
    this.store.db.prepare("UPDATE campaigns SET empty_reviews = 0, updated_at = ? WHERE id = ?").run(nowIso(), campaignId);
  }

  bumpProgress(campaignId: string): void {
    this.store.db
      .prepare("UPDATE campaigns SET progress_epoch = progress_epoch + 1, empty_reviews = 0, updated_at = ? WHERE id = ?")
      .run(nowIso(), campaignId);
  }

  markRequested(campaignId: string, seq: number): void {
    this.store.db.prepare("UPDATE campaigns SET requested_seq = MAX(requested_seq, ?), updated_at = ? WHERE id = ?").run(seq, nowIso(), campaignId);
  }

  appendEvent(campaignId: string, type: string, payload: unknown, actor: Actor, entityId?: string, submissionId?: string): number {
    const camp = this.store.db.prepare("SELECT event_head FROM campaigns WHERE id = ?").get(campaignId) as { event_head: number };
    const seq = camp.event_head + 1;
    const eventId = newId("evt");
    const now = nowIso();
    this.store.db.prepare("UPDATE campaigns SET event_head = ?, updated_at = ? WHERE id = ?").run(seq, now, campaignId);
    this.store.db
      .prepare(
        `INSERT INTO events(event_id, campaign_id, seq, schema_version, type, actor_json, entity_id, correlation_id, submission_id, recorded_at, payload_json, consumed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        eventId,
        campaignId,
        seq,
        SCHEMA_VERSION,
        type,
        asJson(actor),
        entityId ?? null,
        newCorrelationId(),
        submissionId ?? null,
        now,
        asJson(payload),
      );
    this.store.db.prepare("INSERT INTO outbox(campaign_id, event_seq, created_at, processed) VALUES (?, ?, ?, 0)").run(campaignId, seq, now);
    return seq;
  }

  private applyOneOp(campaignId: string, runId: string, submissionId: string, op: ProposalOp, ids: Record<string, string>): number {
    const camp = this.getCampaign(campaignId);
    const root = this.store.db.prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1").get(campaignId) as { id: string };
    switch (op.op) {
      case "propose_step": {
        const step = op.step;
        if (!step.question || !step.kind || !step.methodFamily) {
          throw invalidInput("step_incomplete", "propose_step missing fields");
        }
        const fp =
          step.fingerprint ??
          createHash("sha256")
            .update(`${step.kind}|${step.methodFamily}|${step.question}`)
            .digest("hex")
            .slice(0, 32);
        const result = this.proposeStepDirect({
          campaign_id: campaignId,
          producer_id: `inner-${runId}`,
          submission_id: `${submissionId}:${fp}`,
          run_id: runId,
          question: step.question,
          kind: step.kind,
          goal_refs: step.goalRefs?.length ? step.goalRefs : [root.id],
          preconditions: step.preconditions ?? { op: "all", of: [] },
          method_family: step.methodFamily,
          expected_observations: step.expectedObservations ?? [],
          completion_criteria: step.completionCriteria ?? "observe",
          fingerprint: fp,
          reopen_rule: step.reopenRule ?? { kind: "never" },
          branch_id: step.branchId,
          input_refs: step.inputRefs,
        });
        Object.assign(ids, result.canonical_ids);
        return result.seq;
      }
      case "revise_step_priority": {
        const row = this.store.db.prepare("SELECT revision FROM steps WHERE id = ? AND campaign_id = ?").get(op.step_id, campaignId) as
          | { revision: number }
          | undefined;
        if (!row) throw invalidInput("step_not_found", "step not found");
        if (row.revision !== op.expected_revision) throw conflict("revision_conflict", "step revision mismatch");
        this.store.db.prepare("UPDATE steps SET priority = ?, revision = revision + 1 WHERE id = ?").run(op.priority, op.step_id);
        return camp.event_head;
      }
      case "retire_step": {
        const row = this.store.db.prepare("SELECT revision, status FROM steps WHERE id = ? AND campaign_id = ?").get(op.step_id, campaignId) as
          | { revision: number; status: StepStatus }
          | undefined;
        if (!row) throw invalidInput("step_not_found", "step not found");
        if (row.revision !== op.expected_revision) throw conflict("revision_conflict", "step revision mismatch");
        this.store.db.prepare("UPDATE steps SET status = 'retired', revision = revision + 1, blocked_reason = ? WHERE id = ?").run(op.reason, op.step_id);
        return this.appendEvent(campaignId, "step.retired", { step_id: op.step_id, reason: op.reason }, { kind: "worker", id: runId }, op.step_id);
      }
      case "propose_subgoal": {
        this.assertEntityCampaign(campaignId, op.parent_id);
        const parent = this.store.db.prepare("SELECT is_root, id FROM goals WHERE id = ? AND campaign_id = ?").get(op.parent_id, campaignId) as
          | { is_root: number; id: string }
          | undefined;
        if (!parent) throw invalidInput("parent_missing", "parent goal not in campaign");
        const id = newId("goal");
        const seq = this.appendEvent(campaignId, "goal.created", { goal_id: id, parent: op.parent_id }, { kind: "worker", id: runId }, id);
        this.store.db
          .prepare(
            `INSERT INTO goals(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, statement, parent_id, is_root, success_predicate_ref, mandatory, status, evidence_refs_json)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, 0, 'active', '[]')`,
          )
          .run(id, campaignId, SCHEMA_VERSION, nowIso(), seq, seq, op.statement, op.parent_id, op.success_predicate_ref ?? "none");
        ids[id] = id;
        return seq;
      }
      case "retire_subgoal": {
        const g = this.store.db.prepare("SELECT is_root, revision FROM goals WHERE id = ? AND campaign_id = ?").get(op.goal_id, campaignId) as
          | { is_root: number; revision: number }
          | undefined;
        if (!g) throw invalidInput("goal_not_found", "goal not found");
        if (g.is_root) throw denied("root_goal_protected", "root goal cannot be retired by worker");
        this.store.db
          .prepare("UPDATE goals SET status = 'retired', retired_reason = ?, revision = revision + 1 WHERE id = ?")
          .run(op.reason, op.goal_id);
        return this.appendEvent(campaignId, "goal.retired", { goal_id: op.goal_id, reason: op.reason }, { kind: "worker", id: runId }, op.goal_id);
      }
      case "propose_hypothesis": {
        return this.submitFact({
          campaign_id: campaignId,
          producer_id: `hyp-${runId}`,
          submission_id: `${submissionId}:hyp:${hashJson(op.proposition)}`,
          run_id: runId,
          proposition: op.proposition,
          support_refs: op.support_refs,
          conditions: op.conditions,
          source_grade: "derived",
        }).seq;
      }
      case "request_verification": {
        const id = newId("step");
        void id;
        const result = this.proposeStepDirect({
          campaign_id: campaignId,
          producer_id: `ver-${runId}`,
          submission_id: `${submissionId}:ver:${op.finding_or_fact_id}`,
          run_id: runId,
          question: `verify ${op.finding_or_fact_id} via ${op.method}`,
          kind: "verify",
          goal_refs: [root.id],
          preconditions: { op: "all", of: [] },
          method_family: op.method,
          expected_observations: ["verification"],
          completion_criteria: "verdict",
          fingerprint: createHash("sha256").update(`verify|${op.finding_or_fact_id}|${op.method}`).digest("hex").slice(0, 32),
          reopen_rule: { kind: "never" },
          priority: 10,
        });
        Object.assign(ids, result.canonical_ids);
        return result.seq;
      }
      case "propose_coverage_item": {
        const id = newId("cov");
        const seq = this.appendEvent(campaignId, "coverage.updated", { obligation: op.obligation }, { kind: "worker", id: runId }, id);
        this.store.db
          .prepare(
            `INSERT INTO coverage_items(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, obligation, dimensions_json, applicability, execution_state, outcome, evidence_state, mandatory)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'applicable', 'untested', 'none', 'missing', ?)`,
          )
          .run(id, campaignId, SCHEMA_VERSION, nowIso(), seq, seq, op.obligation, asJson(op.dimensions), op.mandatory ? 1 : 0);
        ids[id] = id;
        return seq;
      }
      case "recommend_state":
        this.appendEvent(campaignId, "control.changed", { recommend_state: op.state, reason: op.reason }, { kind: "worker", id: runId });
        return this.getCampaign(campaignId).event_head;
    }
  }

  private preconditionValue(campaignId: string, expr: PredicateExpr): ReturnType<FactLookup> {
    const lookup: FactLookup = ({ fact_id, key }) => {
      if (fact_id) {
        const row = this.store.db
          .prepare("SELECT epistemic_status, validity, campaign_id FROM facts WHERE id = ?")
          .get(fact_id) as { epistemic_status: string; validity: string; campaign_id: string } | undefined;
        if (!row) return "unknown";
        if (row.campaign_id !== campaignId) throw denied("cross_campaign_ref", "fact belongs to another campaign");
        if (row.validity !== "current") return "unknown";
        if (row.epistemic_status === "accepted") return "true";
        if (row.epistemic_status === "disputed" || row.epistemic_status === "retracted" || row.epistemic_status === "stale") {
          return "unknown";
        }
        return "unknown";
      }
      if (key) {
        const row = this.store.db
          .prepare(
            "SELECT epistemic_status, validity FROM facts WHERE campaign_id = ? AND fact_key = ? AND epistemic_status IN ('accepted','disputed') ORDER BY created_seq DESC LIMIT 1",
          )
          .get(campaignId, key) as { epistemic_status: string; validity: string } | undefined;
        if (!row) return "unknown";
        if (row.validity !== "current") return "unknown";
        if (row.epistemic_status === "accepted") return "true";
        return "unknown";
      }
      return "true";
    };
    return evalPredicate(expr, lookup);
  }

  private assertRun(campaignId: string, runId: string): void {
    const run = this.store.db.prepare("SELECT campaign_id FROM task_runs WHERE id = ?").get(runId) as { campaign_id: string } | undefined;
    if (!run) throw invalidInput("unknown_run", "execution id does not exist");
    if (run.campaign_id !== campaignId) throw denied("cross_campaign_ref", "run belongs to another campaign");
  }

  private refsExist(campaignId: string, ids: string[]): boolean {
    for (const id of ids) {
      const obs = this.store.db.prepare("SELECT campaign_id FROM observations WHERE id = ?").get(id) as { campaign_id: string } | undefined;
      const art = this.store.db.prepare("SELECT campaign_id FROM artifacts WHERE id = ?").get(id) as { campaign_id: string } | undefined;
      const fact = this.store.db.prepare("SELECT campaign_id FROM facts WHERE id = ?").get(id) as { campaign_id: string } | undefined;
      const hit = obs ?? art ?? fact;
      if (!hit) return false;
      if (hit.campaign_id !== campaignId) throw denied("cross_campaign_ref", "reference belongs to another campaign");
    }
    return true;
  }

  private assertRefsSameCampaign(campaignId: string, ids: string[]): void {
    for (const id of ids) this.assertEntityCampaign(campaignId, id);
  }

  private assertEntityCampaign(campaignId: string, id: string): void {
    const tables = ["facts", "goals", "steps", "observations", "findings", "coverage_items", "artifacts"];
    for (const t of tables) {
      const row = this.store.db.prepare(`SELECT campaign_id FROM ${t} WHERE id = ?`).get(id) as { campaign_id: string } | undefined;
      if (row) {
        if (row.campaign_id !== campaignId) throw denied("cross_campaign_ref", `${t} ${id} belongs to another campaign`);
        return;
      }
    }
    throw invalidInput("unknown_ref", `unknown reference ${id}`);
  }

  private findOpposite(campaignId: string, proposition: string, factKey?: string): string | undefined {
    if (factKey) {
      const row = this.store.db
        .prepare("SELECT id, proposition FROM facts WHERE campaign_id = ? AND fact_key = ? AND epistemic_status = 'accepted'")
        .get(campaignId, factKey) as { id: string; proposition: string } | undefined;
      if (row && normalizeProp(row.proposition) !== normalizeProp(proposition)) return row.id;
    }
    const notForm = proposition.startsWith("NOT ") ? proposition.slice(4) : `NOT ${proposition}`;
    const row = this.store.db
      .prepare("SELECT id FROM facts WHERE campaign_id = ? AND proposition = ?")
      .get(campaignId, notForm) as { id: string } | undefined;
    return row?.id;
  }
}

function normalizeProp(s: string): string {
  return s.trim().toLowerCase();
}

function outcomeToStepStatus(reason: TaskOutcome["reason"]): StepStatus {
  switch (reason) {
    case "resolved":
      return "resolved";
    case "deferred":
    case "budget":
    case "context_limit":
    case "protocol_error":
    case "incomplete_protocol":
      return "deferred";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "retired";
    default:
      return "deferred";
  }
}

function rowToEvent(row: Record<string, unknown>): DomainEvent {
  return {
    eventId: String(row.event_id),
    campaignId: String(row.campaign_id),
    seq: Number(row.seq),
    schemaVersion: Number(row.schema_version),
    type: String(row.type),
    actor: fromJson(String(row.actor_json), { kind: "controller", id: "?" }),
    entityId: row.entity_id ? String(row.entity_id) : undefined,
    correlationId: String(row.correlation_id),
    submissionId: row.submission_id ? String(row.submission_id) : undefined,
    recordedAt: String(row.recorded_at),
    payload: fromJson(String(row.payload_json), {}),
  };
}
