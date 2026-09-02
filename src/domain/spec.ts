import { SCHEMA_VERSION } from "../version.ts";
import { invalidInput } from "./errors.ts";
import type { CampaignSpec, CampaignState } from "./types.ts";

export const ALLOWED_MODELS = new Set(["scripted", "scripted-react"]);
export const ALLOWED_PROVIDERS = new Set(["scripted"]);
export const ALLOWED_STATES = new Set<CampaignState>([
  "created",
  "active",
  "waiting",
  "blocked",
  "plateau",
  "budget_paused",
  "paused",
  "closing",
  "completed",
  "cancelled",
]);

export function validateCampaignSpec(input: unknown): CampaignSpec {
  if (input === null || typeof input !== "object") {
    throw invalidInput("spec_not_object", "CampaignSpec must be an object");
  }
  const raw = input as Record<string, unknown>;
  const campaign_id = requireString(raw, "campaign_id");
  const schema_version = requireInt(raw, "schema_version");
  if (schema_version !== SCHEMA_VERSION) {
    throw invalidInput("schema_version_mismatch", `schema_version must be ${SCHEMA_VERSION}`, {
      schema_version,
    });
  }
  const mode = requireString(raw, "mode");
  if (mode !== "goal_seeking" && mode !== "assessment") {
    throw invalidInput("unknown_mode", `unknown mode ${mode}`);
  }
  const root_goal_raw = raw.root_goal;
  if (!root_goal_raw || typeof root_goal_raw !== "object") {
    throw invalidInput("missing_root_goal", "root_goal is required");
  }
  const root_goal_obj = root_goal_raw as Record<string, unknown>;
  const statement = typeof root_goal_obj.statement === "string" ? root_goal_obj.statement.trim() : "";
  if (!statement) {
    throw invalidInput("missing_root_goal", "root_goal.statement is required");
  }
  const success_predicate_ref = requireString(root_goal_obj, "success_predicate_ref");

  const budgetRaw = requireObject(raw, "budget");
  const budget = {
    currency: optionalString(budgetRaw, "currency") ?? "USD",
    price_version: optionalString(budgetRaw, "price_version") ?? "unknown",
    max_cost_micro: optionalIntOrNull(budgetRaw, "max_cost_micro"),
    max_tokens: optionalIntOrNull(budgetRaw, "max_tokens"),
    max_calls: optionalIntOrNull(budgetRaw, "max_calls"),
    deadline_ms: optionalIntOrNull(budgetRaw, "deadline_ms"),
  };
  if (budget.max_cost_micro !== null && budget.max_cost_micro < 0) {
    throw invalidInput("negative_budget", "budget.max_cost_micro must be >= 0");
  }
  if (budget.max_tokens !== null && budget.max_tokens < 0) {
    throw invalidInput("negative_budget", "budget.max_tokens must be >= 0");
  }
  if (budget.max_calls !== null && budget.max_calls < 0) {
    throw invalidInput("negative_budget", "budget.max_calls must be >= 0");
  }
  if (
    budget.max_cost_micro === null &&
    budget.max_tokens === null &&
    budget.max_calls === null
  ) {
    throw invalidInput("no_hard_cap", "at least one of max_cost_micro, max_tokens, max_calls is required");
  }

  const model_policy_raw = requireObject(raw, "model_policy");
  const provider = requireString(model_policy_raw, "provider");
  const model = requireString(model_policy_raw, "model");
  if (provider === "scripted") {
    if (!ALLOWED_MODELS.has(model)) {
      throw invalidInput("unknown_model", `unknown model ${model}`);
    }
  } else if (!provider.startsWith("prv_")) {
    throw invalidInput("unknown_model", `unknown provider ${provider}`);
  }
  const thinking_level = optionalString(model_policy_raw, "thinking_level") ?? "off";
  if (!["off", "minimal", "low", "medium", "high"].includes(thinking_level)) {
    throw invalidInput("unknown_thinking_level", `unknown thinking_level ${thinking_level}`);
  }

  const scopeRaw = requireObject(raw, "scope");
  const spec: CampaignSpec = {
    campaign_id,
    schema_version,
    mode,
    root_goal: { statement, success_predicate_ref },
    scope: {
      assets: stringArray(scopeRaw, "assets"),
      workspace: optionalString(scopeRaw, "workspace") ?? "synthetic",
      identities: stringArray(scopeRaw, "identities"),
      entries: stringArray(scopeRaw, "entries"),
      exclusions: stringArray(scopeRaw, "exclusions"),
      profile: optionalString(scopeRaw, "profile") ?? "synthetic",
    },
    policy_version: requireString(raw, "policy_version"),
    scope_version: requireString(raw, "scope_version"),
    goal_version: requireString(raw, "goal_version"),
    tool_allowlist: stringArray(raw, "tool_allowlist"),
    execution_profile: optionalString(raw, "execution_profile") ?? "synthetic",
    model_policy: {
      provider,
      model,
      thinking_level: thinking_level as CampaignSpec["model_policy"]["thinking_level"],
      allow_retry: Boolean(model_policy_raw.allow_retry),
      allow_model_fallback: Boolean(model_policy_raw.allow_model_fallback),
    },
    budget,
    verification_policy: {
      require_independent_verify: Boolean(
        (requireObject(raw, "verification_policy") as Record<string, unknown>).require_independent_verify,
      ),
      oracle_id: optionalString(requireObject(raw, "verification_policy"), "oracle_id") ?? "synthetic-oracle",
    },
    coverage_policy: {
      dimensions: stringArray(requireObject(raw, "coverage_policy"), "dimensions"),
      mandatory_ids: stringArray(requireObject(raw, "coverage_policy"), "mandatory_ids"),
    },
    artifact_policy: {
      max_bytes: optionalIntOrNull(requireObject(raw, "artifact_policy"), "max_bytes") ?? 1_000_000,
      retention_days: optionalIntOrNull(requireObject(raw, "artifact_policy"), "retention_days") ?? 30,
    },
    stop_policy: {
      max_empty_reviews_per_progress_epoch:
        optionalIntOrNull(requireObject(raw, "stop_policy"), "max_empty_reviews_per_progress_epoch") ?? 2,
      decide_debounce_ms: optionalIntOrNull(requireObject(raw, "stop_policy"), "decide_debounce_ms") ?? 0,
    },
    environment_revision: requireString(raw, "environment_revision"),
  };
  return spec;
}

export function assertKnownState(state: string): asserts state is CampaignState {
  if (!ALLOWED_STATES.has(state as CampaignState)) {
    throw invalidInput("unknown_state", `unknown campaign state ${state}`);
  }
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw invalidInput(`missing_${key}`, `${key} is required`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalidInput(`invalid_${key}`, `${key} must be a string`);
  return v;
}

function requireInt(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw invalidInput(`invalid_${key}`, `${key} must be an integer`);
  }
  return v;
}

function optionalIntOrNull(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw invalidInput(`invalid_${key}`, `${key} must be an integer`);
  }
  return v;
}

function requireObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw invalidInput(`missing_${key}`, `${key} is required`);
  }
  return v as Record<string, unknown>;
}

function stringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw invalidInput(`invalid_${key}`, `${key} must be a string array`);
  }
  return v as string[];
}
