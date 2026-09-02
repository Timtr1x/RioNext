import { DomainError } from "../domain/errors.ts";
import type { EffectClass, InvocationState, RunLease } from "../domain/types.ts";
import type { EffectAdapter } from "../tools/effect-adapter.ts";
import type { BudgetLedger } from "./budget-ledger.ts";
import type { InvocationBook } from "./invocation.ts";
import type { StorageService } from "../storage/service.ts";

export interface DispatchRequest {
  lease: RunLease;
  purpose: string;
  payload: unknown;
  effect: EffectClass;
  envTool: boolean;
}

export interface DispatchResult {
  status: "sent" | "rejected" | "in_flight";
  reason?: string;
  invocation_id: string;
  execution_id?: string;
}

/**
 * Linearization point: dispatching is written in the same transaction that
 * grants the send permit. Adapter send happens after that commit.
 */
export class DispatchGate {
  constructor(
    private readonly storage: StorageService,
    private readonly budget: BudgetLedger,
    private readonly invocations: InvocationBook,
    private readonly adapter: EffectAdapter,
  ) {}

  dispatch(req: DispatchRequest): DispatchResult {
    const permit = this.storage.store.transaction(() => {
      const camp = this.storage.getCampaign(req.lease.campaign_id);
      if (camp.cancel_epoch > req.lease.cancel_epoch || camp.state === "cancelled") {
        return { ok: false as const, reason: "cancel_epoch", invocation_id: "none" };
      }
      if (!this.storage.admissionOpen(req.lease.campaign_id) && req.envTool) {
        return { ok: false as const, reason: "admission_closed", invocation_id: "none" };
      }
      const run = this.storage.getRun(req.lease.run_id);
      if (Number(run.fence) !== req.lease.fence) {
        return { ok: false as const, reason: "stale_fence", invocation_id: "none" };
      }
      if (req.envTool && !this.storage.envAdmissionOpen(req.lease.run_id)) {
        return { ok: false as const, reason: "finish_closed_env", invocation_id: "none" };
      }
      if (!this.budget.canAdmit(req.lease.campaign_id, 1, 0, 0)) {
        throw new DomainError("budget_exhausted", "dispatch blocked", "budget");
      }
      const inv = this.invocations.prepare({
        campaign_id: req.lease.campaign_id,
        run_id: req.lease.run_id,
        kind: "tool",
        purpose: req.purpose,
        fence: req.lease.fence,
        cancel_epoch: req.lease.cancel_epoch,
        effect_class: req.effect,
        reserved_calls: 1,
      });
      this.budget.reserve(req.lease.campaign_id, inv.id, 1, 0, 0);
      this.invocations.mark(inv.id, "dispatching");
      return { ok: true as const, invocation_id: inv.id };
    });
    if (!permit.ok) {
      return { status: "rejected", reason: permit.reason, invocation_id: permit.invocation_id };
    }
    try {
      const sent = this.adapter.send(permit.invocation_id, req.payload);
      this.invocations.mark(permit.invocation_id, "running", { status: sent.execution_id });
      this.storage.store.db
        .prepare("UPDATE invocations SET external_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(sent.execution_id, permit.invocation_id);
      this.invocations.mark(permit.invocation_id, "completed");
      this.budget.settle(req.lease.campaign_id, permit.invocation_id, 1, 0, 0, 1, 0, 0);
      return { status: "sent", invocation_id: permit.invocation_id, execution_id: sent.execution_id };
    } catch (err) {
      this.invocations.mark(permit.invocation_id, "uncertain", { error: String(err) });
      this.budget.markLiability(req.lease.campaign_id, permit.invocation_id, 1, 0, 0);
      return { status: "in_flight", reason: String(err), invocation_id: permit.invocation_id };
    }
  }

  /** Record dispatching without sending. Used to simulate crash after permit, before adapter. */
  markDispatchingOnly(req: DispatchRequest): string {
    const r = this.storage.store.transaction(() => {
      const inv = this.invocations.prepare({
        campaign_id: req.lease.campaign_id,
        run_id: req.lease.run_id,
        kind: "tool",
        purpose: req.purpose,
        fence: req.lease.fence,
        cancel_epoch: req.lease.cancel_epoch,
        effect_class: req.effect,
        reserved_calls: 1,
      });
      this.budget.reserve(req.lease.campaign_id, inv.id, 1, 0, 0);
      this.invocations.mark(inv.id, "dispatching");
      return inv.id;
    });
    return r;
  }

  recover(campaignId: string): { prepared_released: number; marked_uncertain: number; reconciled: number } {
    const rows = this.invocations.nonTerminal(campaignId);
    let prepared_released = 0;
    let marked_uncertain = 0;
    let reconciled = 0;
    for (const row of rows) {
      const id = String(row.id);
      const state = String(row.state) as InvocationState;
      const reserved = Number(row.reserved_calls ?? 0);
      if (state === "prepared") {
        this.invocations.mark(id, "failed_known", { error: "never_sent" });
        this.budget.releasePrepared(campaignId, id, reserved, Number(row.reserved_tokens ?? 0), Number(row.reserved_cost ?? 0));
        prepared_released += 1;
      } else if (state === "dispatching" || state === "running") {
        const tokens = Number(row.reserved_tokens ?? 0);
        const cost = Number(row.reserved_cost ?? 0);
        this.budget.markLiability(campaignId, id, reserved, tokens, cost);
        const ext = row.external_id ? String(row.external_id) : null;
        if (ext && this.adapter.query(ext) === "completed") {
          this.invocations.mark(id, "reconciled");
          this.budget.reconcileLiability(campaignId, `rec:${id}`, reserved, reserved, tokens, tokens, cost, cost);
          reconciled += 1;
        } else if (ext && this.adapter.query(ext) === "failed") {
          this.invocations.mark(id, "failed_known");
          this.budget.reconcileLiability(campaignId, `rec:${id}`, 0, reserved, 0, tokens, 0, cost);
          reconciled += 1;
        } else {
          this.invocations.mark(id, "uncertain");
          marked_uncertain += 1;
        }
      } else if (state === "uncertain") {
        const ext = row.external_id ? String(row.external_id) : null;
        const reservedCalls = Number(row.reserved_calls ?? 0);
        if (ext && this.adapter.query(ext) === "completed") {
          this.invocations.mark(id, "reconciled");
          this.budget.reconcileLiability(campaignId, `rec:${id}`, reservedCalls, reservedCalls);
          reconciled += 1;
        }
      }
    }
    return { prepared_released, marked_uncertain, reconciled };
  }

  archiveLateResult(campaignId: string, invocationId: string, body: unknown): void {
    const inv = this.invocations.get(invocationId);
    if (String(inv.campaign_id) !== campaignId) throw new DomainError("cross_campaign_ref", "late result campaign mismatch", "denied");
    this.storage.store.db
      .prepare("UPDATE invocations SET error_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify({ late_archive: body, observed_at: new Date().toISOString() }), invocationId);
  }
}
