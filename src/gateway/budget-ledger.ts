import { DomainError } from "../domain/errors.ts";
import { nowIso } from "../storage/db.ts";
import type { StorageService } from "../storage/service.ts";

export type Resource = "cost" | "tokens" | "calls";

export class BudgetLedger {
  constructor(private readonly storage: StorageService) {}

  snapshot(campaignId: string): Record<string, number | string> {
    const row = this.storage.store.db.prepare("SELECT * FROM budget_accounts WHERE campaign_id = ?").get(campaignId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new DomainError("budget_missing", "no budget account", "protocol_error");
    return row as Record<string, number | string>;
  }

  remainingCalls(campaignId: string): number {
    const snap = this.snapshot(campaignId);
    return Number(snap.free_calls);
  }

  canAdmit(campaignId: string, calls = 1, tokens = 0, cost = 0): boolean {
    const snap = this.snapshot(campaignId);
    if (Number(snap.overrun_calls) > 0 || Number(snap.overrun_tokens) > 0 || Number(snap.overrun_cost) > 0) return false;
    const totalCalls = Number(snap.total_calls);
    const totalTokens = Number(snap.total_tokens);
    const totalCost = Number(snap.total_cost_micro);
    if (totalCalls > 0 && Number(snap.free_calls) < calls) return false;
    if (totalTokens > 0 && Number(snap.free_tokens) < tokens) return false;
    if (totalCost > 0 && Number(snap.free_cost) < cost) return false;
    if (totalCalls === 0 && totalTokens === 0 && totalCost === 0) return false;
    return true;
  }

  reserve(campaignId: string, idempotencyKey: string, calls: number, tokens: number, cost: number): void {
    this.storage.store.transaction(() => {
      const existing = this.storage.store.db
        .prepare("SELECT id FROM budget_entries WHERE campaign_id = ? AND idempotency_key = ?")
        .get(campaignId, idempotencyKey);
      if (existing) return;
      if (!this.canAdmit(campaignId, calls, tokens, cost)) {
        throw new DomainError("budget_exhausted", "root budget cap reached", "budget", { campaignId, calls, tokens, cost });
      }
      this.storage.store.db
        .prepare(
          `UPDATE budget_accounts SET
            free_calls = free_calls - ?, reserved_calls = reserved_calls + ?,
            free_tokens = free_tokens - ?, reserved_tokens = reserved_tokens + ?,
            free_cost = free_cost - ?, reserved_cost = reserved_cost + ?
           WHERE campaign_id = ?`,
        )
        .run(calls, calls, tokens, tokens, cost, cost, campaignId);
      this.storage.store.db
        .prepare(
          "INSERT INTO budget_entries(id, campaign_id, idempotency_key, kind, amount, resource, created_at) VALUES (?, ?, ?, 'reserve', ?, 'mixed', ?)",
        )
        .run(`bgt_${idempotencyKey}`, campaignId, idempotencyKey, calls, nowIso());
    });
  }

  tryReserve(campaignId: string, idempotencyKey: string, calls: number, tokens: number, cost: number): boolean {
    try {
      this.reserve(campaignId, idempotencyKey, calls, tokens, cost);
      return true;
    } catch (err) {
      if (err instanceof DomainError && err.code === "budget_exhausted") return false;
      throw err;
    }
  }

  releasePrepared(campaignId: string, idempotencyKey: string, calls: number, tokens: number, cost: number): void {
    this.settle(campaignId, idempotencyKey, 0, 0, 0, calls, tokens, cost);
  }

  markLiability(campaignId: string, idempotencyKey: string, calls: number, tokens: number, cost: number): void {
    this.storage.store.transaction(() => {
      const key = `liability:${idempotencyKey}`;
      const existing = this.storage.store.db
        .prepare("SELECT id FROM budget_entries WHERE campaign_id = ? AND idempotency_key = ?")
        .get(campaignId, key);
      if (existing) return;
      this.storage.store.db
        .prepare(
          `UPDATE budget_accounts SET
            reserved_calls = reserved_calls - ?, liability_calls = liability_calls + ?,
            reserved_tokens = reserved_tokens - ?, liability_tokens = liability_tokens + ?,
            reserved_cost = reserved_cost - ?, liability_cost = liability_cost + ?
           WHERE campaign_id = ?`,
        )
        .run(calls, calls, tokens, tokens, cost, cost, campaignId);
      this.storage.store.db
        .prepare(
          "INSERT INTO budget_entries(id, campaign_id, idempotency_key, kind, amount, resource, created_at) VALUES (?, ?, ?, 'liability', ?, 'mixed', ?)",
        )
        .run(`bgt_${key}`, campaignId, key, calls, nowIso());
    });
  }

  reconcileLiability(
    campaignId: string,
    idempotencyKey: string,
    actualCalls: number,
    liabilityCalls: number,
    actualTokens = 0,
    liabilityTokens = 0,
    actualCost = 0,
    liabilityCost = 0,
  ): void {
    this.storage.store.transaction(() => {
      const key = `reconcile:${idempotencyKey}`;
      const existing = this.storage.store.db
        .prepare("SELECT id FROM budget_entries WHERE campaign_id = ? AND idempotency_key = ?")
        .get(campaignId, key);
      if (existing) return;
      this.moveLiability("calls", campaignId, liabilityCalls, actualCalls);
      this.moveLiability("tokens", campaignId, liabilityTokens, actualTokens);
      this.moveLiability("cost", campaignId, liabilityCost, actualCost);
      this.storage.store.db
        .prepare(
          "INSERT INTO budget_entries(id, campaign_id, idempotency_key, kind, amount, resource, created_at) VALUES (?, ?, ?, 'reconcile', ?, 'mixed', ?)",
        )
        .run(`bgt_${key}`, campaignId, key, actualCalls, nowIso());
    });
  }

  settle(campaignId: string, idempotencyKey: string, calls: number, tokens: number, cost: number, reservedCalls: number, reservedTokens: number, reservedCost: number): void {
    this.storage.store.transaction(() => {
      const settleKey = `settle:${idempotencyKey}`;
      const existing = this.storage.store.db
        .prepare("SELECT id FROM budget_entries WHERE campaign_id = ? AND idempotency_key = ?")
        .get(campaignId, settleKey);
      if (existing) return;
      this.applySettle("calls", campaignId, reservedCalls, calls);
      this.applySettle("tokens", campaignId, reservedTokens, tokens);
      this.applySettle("cost", campaignId, reservedCost, cost);
      this.storage.store.db
        .prepare(
          "INSERT INTO budget_entries(id, campaign_id, idempotency_key, kind, amount, resource, created_at) VALUES (?, ?, ?, 'settle', ?, 'mixed', ?)",
        )
        .run(`bgt_${settleKey}`, campaignId, settleKey, calls, nowIso());
    });
  }

  private applySettle(resource: Resource, campaignId: string, reserved: number, actual: number): void {
    const free = resource === "calls" ? "free_calls" : resource === "tokens" ? "free_tokens" : "free_cost";
    const reservedCol = resource === "calls" ? "reserved_calls" : resource === "tokens" ? "reserved_tokens" : "reserved_cost";
    const spent = resource === "calls" ? "spent_calls" : resource === "tokens" ? "spent_tokens" : "spent_cost";
    const overrun = resource === "calls" ? "overrun_calls" : resource === "tokens" ? "overrun_tokens" : "overrun_cost";
    const row = this.storage.store.db.prepare(`SELECT ${free} as free, ${reservedCol} as reserved FROM budget_accounts WHERE campaign_id = ?`).get(campaignId) as {
      free: number;
      reserved: number;
    };
    let nextFree = Number(row.free);
    let nextReserved = Math.max(0, Number(row.reserved) - reserved);
    let extra = 0;
    if (actual <= reserved) {
      nextFree += reserved - actual;
    } else {
      extra = actual - reserved;
      if (nextFree >= extra) {
        nextFree -= extra;
        extra = 0;
      } else {
        extra -= nextFree;
        nextFree = 0;
      }
    }
    this.storage.store.db
      .prepare(
        `UPDATE budget_accounts SET ${free} = ?, ${reservedCol} = ?, ${spent} = ${spent} + ?, ${overrun} = ${overrun} + ? WHERE campaign_id = ?`,
      )
      .run(nextFree, nextReserved, actual, extra, campaignId);
  }

  private moveLiability(resource: Resource, campaignId: string, liability: number, actual: number): void {
    const free = resource === "calls" ? "free_calls" : resource === "tokens" ? "free_tokens" : "free_cost";
    const liab = resource === "calls" ? "liability_calls" : resource === "tokens" ? "liability_tokens" : "liability_cost";
    const spent = resource === "calls" ? "spent_calls" : resource === "tokens" ? "spent_tokens" : "spent_cost";
    const overrun = resource === "calls" ? "overrun_calls" : resource === "tokens" ? "overrun_tokens" : "overrun_cost";
    const row = this.storage.store.db
      .prepare(`SELECT ${free} as free, ${liab} as liability FROM budget_accounts WHERE campaign_id = ?`)
      .get(campaignId) as { free: number; liability: number };
    let nextFree = Number(row.free);
    let nextLiab = Number(row.liability) - liability;
    let extra = 0;
    if (actual <= liability) {
      nextFree += liability - actual;
    } else {
      extra = actual - liability;
      if (nextFree >= extra) {
        nextFree -= extra;
        extra = 0;
      } else {
        extra -= nextFree;
        nextFree = 0;
      }
    }
    this.storage.store.db
      .prepare(`UPDATE budget_accounts SET ${free} = ?, ${liab} = ?, ${spent} = ${spent} + ?, ${overrun} = ${overrun} + ? WHERE campaign_id = ?`)
      .run(nextFree, nextLiab, actual, extra, campaignId);
  }
}
