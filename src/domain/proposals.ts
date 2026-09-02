import { DomainError } from "./errors.ts";
import { ALLOWED_PROPOSAL_OPS, type CampaignState, type ProposalOp } from "./types.ts";

const FORBIDDEN_ROOT_MUTATIONS = new Set(["set_root_goal", "enlarge_budget", "enlarge_scope", "complete_campaign"]);

export function parseProposalOps(input: unknown): ProposalOp[] {
  if (!Array.isArray(input)) {
    throw new DomainError("proposal_not_array", "proposal operations must be an array", "invalid_input");
  }
  return input.map((item, index) => parseOne(item, index));
}

function parseOne(item: unknown, index: number): ProposalOp {
  if (!item || typeof item !== "object") {
    throw new DomainError("proposal_op_invalid", `operation ${index} is not an object`, "invalid_input");
  }
  const raw = item as Record<string, unknown>;
  const op = raw.op;
  if (typeof op !== "string") {
    throw new DomainError("proposal_op_missing", `operation ${index} missing op`, "invalid_input");
  }
  if (FORBIDDEN_ROOT_MUTATIONS.has(op) || op === "complete_campaign" || op === "sql" || op === "json_patch") {
    throw new DomainError("proposal_op_forbidden", `operation ${op} is not allowed`, "denied", { op });
  }
  if (!(ALLOWED_PROPOSAL_OPS as string[]).includes(op)) {
    throw new DomainError("proposal_op_unknown", `unknown operation ${op}`, "invalid_input", { op });
  }
  switch (op) {
    case "propose_step": {
      const step = raw.step;
      if (!step || typeof step !== "object") {
        throw new DomainError("propose_step_invalid", "propose_step requires step", "invalid_input");
      }
      return { op, step: step as ProposalOp extends { op: "propose_step" } ? ProposalOp["step"] : never };
    }
    case "revise_step_priority":
      return {
        op,
        step_id: reqStr(raw, "step_id"),
        expected_revision: reqInt(raw, "expected_revision"),
        priority: reqInt(raw, "priority"),
      };
    case "retire_step":
      return {
        op,
        step_id: reqStr(raw, "step_id"),
        expected_revision: reqInt(raw, "expected_revision"),
        reason: reqStr(raw, "reason"),
      };
    case "propose_subgoal":
      return {
        op,
        statement: reqStr(raw, "statement"),
        parent_id: reqStr(raw, "parent_id"),
        success_predicate_ref: typeof raw.success_predicate_ref === "string" ? raw.success_predicate_ref : undefined,
      };
    case "retire_subgoal":
      return {
        op,
        goal_id: reqStr(raw, "goal_id"),
        expected_revision: reqInt(raw, "expected_revision"),
        reason: reqStr(raw, "reason"),
      };
    case "propose_hypothesis":
      return {
        op,
        proposition: reqStr(raw, "proposition"),
        support_refs: strArr(raw, "support_refs"),
        conditions: (raw.conditions as Record<string, unknown>) ?? {},
      };
    case "request_verification":
      return {
        op,
        finding_or_fact_id: reqStr(raw, "finding_or_fact_id"),
        method: reqStr(raw, "method"),
      };
    case "propose_coverage_item":
      return {
        op,
        obligation: reqStr(raw, "obligation"),
        dimensions: (raw.dimensions as Record<string, string>) ?? {},
        mandatory: Boolean(raw.mandatory),
      };
    case "recommend_state": {
      const state = reqStr(raw, "state") as CampaignState;
      if (state === "completed") {
        throw new DomainError(
          "recommend_complete_forbidden",
          "models may recommend_state but completed is decided by the controller",
          "denied",
        );
      }
      return { op, state, reason: reqStr(raw, "reason") };
    }
    default:
      throw new DomainError("proposal_op_unknown", `unknown operation ${op}`, "invalid_input");
  }
}

function reqStr(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v !== "string" || !v) {
    throw new DomainError("proposal_field", `${key} is required`, "invalid_input");
  }
  return v;
}

function reqInt(raw: Record<string, unknown>, key: string): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new DomainError("proposal_field", `${key} must be an integer`, "invalid_input");
  }
  return v;
}

function strArr(raw: Record<string, unknown>, key: string): string[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new DomainError("proposal_field", `${key} must be a string array`, "invalid_input");
  }
  return v as string[];
}
