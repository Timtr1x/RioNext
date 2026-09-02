import { createHash } from "node:crypto";
import type { PredicateExpr, StepKind } from "./types.ts";

export function fingerprintStep(input: {
  kind: StepKind;
  questionType: string;
  object: string;
  identityRef: string;
  envRevision: string;
  methodFamily: string;
  preconditions: PredicateExpr;
}): string {
  const canonical = JSON.stringify({
    kind: input.kind,
    questionType: normalize(input.questionType),
    object: normalize(input.object),
    identityRef: input.identityRef,
    envRevision: input.envRevision,
    methodFamily: input.methodFamily,
    preconditions: input.preconditions,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
