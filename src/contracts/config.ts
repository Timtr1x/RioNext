import { randomUUID } from "node:crypto";
import { validateCampaignSpec } from "../domain/spec.ts";
import { invalidInput } from "../domain/errors.ts";
import type { CampaignSpec } from "../domain/types.ts";
import { PI_COMMIT, PI_DECLARED_VERSION, SCHEMA_VERSION, TYPEBOX_VERSION } from "../version.ts";

export interface RuntimeConfig {
  data_dir: string;
  db_path: string;
  artifact_root: string;
  instance_id: string;
  max_concurrent_decide_per_campaign: 1;
  max_concurrent_execute: 1;
  pi_tool_execution: "sequential";
  max_decide_turns: number;
  max_execute_turns_per_run: number;
  max_tool_calls_per_run: number;
  max_transient_retries_per_invocation: number;
  max_new_steps_per_decision: number;
  max_active_frontier_items: number;
  lease_ttl_ms: number;
  heartbeat_ms: number;
  tool_preview_limit: number;
  automatic_model_fallback: false;
  automatic_extension_loading: false;
}

export const DEFAULT_RUNTIME: Omit<RuntimeConfig, "data_dir" | "db_path" | "artifact_root" | "instance_id"> = {
  max_concurrent_decide_per_campaign: 1,
  max_concurrent_execute: 1,
  pi_tool_execution: "sequential",
  max_decide_turns: 6,
  max_execute_turns_per_run: 12,
  max_tool_calls_per_run: 24,
  max_transient_retries_per_invocation: 2,
  max_new_steps_per_decision: 8,
  max_active_frontier_items: 64,
  lease_ttl_ms: 60_000,
  heartbeat_ms: 15_000,
  tool_preview_limit: 8192,
  automatic_model_fallback: false,
  automatic_extension_loading: false,
};

export function makeRuntimeConfig(dataDir: string, instanceId = `proc-${randomUUID()}`): RuntimeConfig {
  return {
    ...DEFAULT_RUNTIME,
    data_dir: dataDir,
    db_path: `${dataDir.replace(/\\/g, "/")}/rionext.sqlite`,
    artifact_root: `${dataDir.replace(/\\/g, "/")}/artifacts`,
    instance_id: instanceId,
  };
}

export function validateStartupInput(spec: unknown, runtime: RuntimeConfig): CampaignSpec {
  if (runtime.pi_tool_execution !== "sequential") {
    throw invalidInput("tool_execution", "P0 requires sequential toolExecution");
  }
  if (runtime.max_concurrent_execute !== 1) {
    throw invalidInput("execute_slot", "P0 requires a single Execute slot");
  }
  if (runtime.automatic_model_fallback) {
    throw invalidInput("model_fallback", "automatic model fallback is disabled");
  }
  return validateCampaignSpec(spec);
}

export function configFingerprint(runtime: RuntimeConfig): Record<string, unknown> {
  return {
    node: process.version,
    pi_commit: PI_COMMIT,
    pi_version: PI_DECLARED_VERSION,
    typebox: TYPEBOX_VERSION,
    schema_version: SCHEMA_VERSION,
    pi_tool_execution: runtime.pi_tool_execution,
    max_concurrent_execute: runtime.max_concurrent_execute,
    max_concurrent_decide_per_campaign: runtime.max_concurrent_decide_per_campaign,
    model_fallback: runtime.automatic_model_fallback,
    instance_id: runtime.instance_id,
    db_path: runtime.db_path,
    artifact_root: runtime.artifact_root,
  };
}

export function printStartupBanner(runtime: RuntimeConfig, log: (s: string) => void = console.log): void {
  const fp = configFingerprint(runtime);
  log(`rionext start ${JSON.stringify(fp)}`);
}
