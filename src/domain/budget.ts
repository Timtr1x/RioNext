import { DomainError } from "./errors.ts";

export interface BudgetBuckets {
  total: number;
  free: number;
  reserved_inflight: number;
  unknown_liability: number;
  spent: number;
  uncovered_overrun: number;
}

export function emptyBuckets(total: number): BudgetBuckets {
  if (!Number.isInteger(total) || total < 0) {
    throw new DomainError("invalid_budget", "total must be a non-negative integer", "invalid_input");
  }
  return {
    total,
    free: total,
    reserved_inflight: 0,
    unknown_liability: 0,
    spent: 0,
    uncovered_overrun: 0,
  };
}

export function assertConservation(b: BudgetBuckets): void {
  const sum = b.free + b.reserved_inflight + b.unknown_liability + b.spent;
  const expected = b.total + b.uncovered_overrun;
  if (sum !== expected) {
    throw new DomainError("budget_invariant", "budget buckets do not conserve", "protocol_error", {
      sum,
      expected,
      buckets: b,
    });
  }
}

export function reserve(b: BudgetBuckets, amount: number): BudgetBuckets {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new DomainError("invalid_reserve", "reserve amount must be a positive integer", "invalid_input");
  }
  if (b.free < amount) {
    throw new DomainError("budget_exhausted", "insufficient free budget", "budget", {
      free: b.free,
      amount,
    });
  }
  const next = { ...b, free: b.free - amount, reserved_inflight: b.reserved_inflight + amount };
  assertConservation(next);
  return next;
}

export function settle(b: BudgetBuckets, reserved: number, actual: number): BudgetBuckets {
  if (b.reserved_inflight < reserved) {
    throw new DomainError("settle_mismatch", "cannot settle more than reserved", "protocol_error");
  }
  let next: BudgetBuckets = {
    ...b,
    reserved_inflight: b.reserved_inflight - reserved,
  };
  if (actual <= reserved) {
    next.spent += actual;
    next.free += reserved - actual;
  } else {
    next.spent += actual;
    const extra = actual - reserved;
    if (next.free >= extra) {
      next.free -= extra;
    } else {
      next.uncovered_overrun += extra - next.free;
      next.free = 0;
    }
  }
  assertConservation(next);
  return next;
}

export function markUncertain(b: BudgetBuckets, reserved: number): BudgetBuckets {
  if (b.reserved_inflight < reserved) {
    throw new DomainError("uncertain_mismatch", "cannot mark more than reserved as uncertain", "protocol_error");
  }
  const next = {
    ...b,
    reserved_inflight: b.reserved_inflight - reserved,
    unknown_liability: b.unknown_liability + reserved,
  };
  assertConservation(next);
  return next;
}

export function reconcileUncertain(b: BudgetBuckets, liability: number, actual: number): BudgetBuckets {
  if (b.unknown_liability < liability) {
    throw new DomainError("reconcile_mismatch", "cannot reconcile more than liability", "protocol_error");
  }
  let next: BudgetBuckets = {
    ...b,
    unknown_liability: b.unknown_liability - liability,
  };
  if (actual <= liability) {
    next.spent += actual;
    next.free += liability - actual;
  } else {
    next.spent += actual;
    const extra = actual - liability;
    if (next.free >= extra) {
      next.free -= extra;
    } else {
      next.uncovered_overrun += extra - next.free;
      next.free = 0;
    }
  }
  assertConservation(next);
  return next;
}

export function releaseReserve(b: BudgetBuckets, reserved: number): BudgetBuckets {
  return settle(b, reserved, 0);
}

export function canAdmitNewCharge(b: BudgetBuckets): boolean {
  return b.uncovered_overrun === 0 && b.free > 0;
}
