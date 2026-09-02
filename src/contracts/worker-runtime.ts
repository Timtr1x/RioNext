import type { ContextManifest, RunLease, TaskOutcome, WorkerMode } from "../domain/types.ts";

export interface ContextPack {
  manifest: ContextManifest;
  system_prompt: string;
  user_payload: unknown;
  tool_names: string[];
}

export interface WorkerRuntime {
  readonly mode: WorkerMode;
  readonly run_id: string;
  start(lease: RunLease, context: ContextPack, signal: AbortSignal): Promise<void>;
  abort(): void;
  settle(): Promise<TaskOutcome>;
}

export interface WorkerFactory {
  create(mode: WorkerMode, run_id: string): WorkerRuntime;
}
