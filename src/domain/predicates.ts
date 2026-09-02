import type { PredicateExpr, TriValue } from "./types.ts";

export type FactLookup = (ref: { fact_id?: string; key?: string }) => TriValue;

export function evalPredicate(expr: PredicateExpr, lookup: FactLookup): TriValue {
  switch (expr.op) {
    case "atom":
      return lookup({ fact_id: expr.fact_id, key: expr.key });
    case "all":
      return evalAll(expr.of.map((child) => evalPredicate(child, lookup)));
    case "any":
      return evalAny(expr.of.map((child) => evalPredicate(child, lookup)));
  }
}

export function evalAll(values: TriValue[]): TriValue {
  if (values.some((v) => v === "false")) return "false";
  if (values.some((v) => v === "unknown")) return "unknown";
  return "true";
}

export function evalAny(values: TriValue[]): TriValue {
  if (values.some((v) => v === "true")) return "true";
  if (values.some((v) => v === "unknown")) return "unknown";
  return "false";
}

export function unknownNeverAdmits(value: TriValue): boolean {
  return value === "true";
}
