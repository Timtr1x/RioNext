import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { DomainError, denied } from "../domain/errors.ts";
import { hashJson } from "../domain/fingerprint.ts";
import type { EffectClass, RunLease } from "../domain/types.ts";
import { createScriptedErrorStream } from "../runtime/pi/scripted-stream.ts";
import type { StorageService } from "../storage/service.ts";
import { BudgetLedger } from "./budget-ledger.ts";
import { runWithOuterDeadline } from "./deadline.ts";
import type { DispatchGate } from "./dispatch.ts";
import { InvocationBook } from "./invocation.ts";
import { assertSafeToolPath, isPolicyInjectionText } from "./sandbox.ts";
import { join } from "node:path";

export function guardToolArgs(storage: StorageService, campaignId: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const path = obj.path ?? obj.file ?? obj.target_path;
  if (typeof path !== "string") return null;
  const camp = storage.getCampaign(campaignId);
  const dataDir = storage.store.path === ":memory:" ? process.cwd() : join(storage.store.path, "..");
  try {
    assertSafeToolPath(
      {
        workspace: join(dataDir, "workspace", campaignId),
        db_path: storage.store.path,
        secrets_path: join(dataDir, "provider-secrets.json"),
        artifact_root: join(dataDir, "artifacts"),
      },
      path,
    );
  } catch (err) {
    return err instanceof Error ? err.message : "path_denied";
  }
  void camp;
  return null;
}

export function ingestToolOutputAsData(storage: StorageService, campaignId: string, runId: string, text: string): void {
  if (!isPolicyInjectionText(text)) return;
  storage.recordObservation({
    campaign_id: campaignId,
    producer_id: runId,
    submission_id: `inj-${Date.now()}`,
    run_id: runId,
    attempt_id: runId,
    subject: "untrusted_tool_text",
    body: { text, treated_as: "data" },
    artifact_refs: [],
    conditions: {},
    env_rev: storage.getCampaign(campaignId).spec.environment_revision,
  });
}

export interface ToolInvokeRequest {
  name: string;
  args: unknown;
  lease: RunLease;
  effect: EffectClass;
  envTool: boolean;
}

export interface ToolInvokeResult {
  invocation_id: string;
  blocked: boolean;
  reason?: string;
  allowed: boolean;
}

export class ModelGateway {
  modelSends = 0;
  lastError: string | null = null;
  closed = false;

  constructor(
    private readonly storage: StorageService,
    private readonly budget: BudgetLedger,
    private readonly invocations: InvocationBook,
    private readonly inner: StreamFn,
    private readonly lease: RunLease,
    private readonly modelId: string,
    private readonly providerName = "scripted",
  ) {}

  closeAdmission(): void {
    this.closed = true;
  }

  stream: StreamFn = (model: Model<string>, context: Context, options) => {
    if (this.closed) {
      return errorStream(model, "gateway admission closed");
    }
    const camp = this.storage.getCampaign(this.lease.campaign_id);
    if (camp.cancel_epoch > this.lease.cancel_epoch || camp.state === "cancelled") {
      return errorStream(model, "campaign cancelled");
    }
    if (!this.storage.admissionOpen(this.lease.campaign_id) && this.lease.mode === "execute") {
      return errorStream(model, "admission closed");
    }
    if (!this.budget.canAdmit(this.lease.campaign_id, 1, 16, 0)) {
      this.lastError = "budget_exhausted";
      return errorStream(model, "budget_exhausted");
    }
    const inv = this.invocations.prepare({
      campaign_id: this.lease.campaign_id,
      run_id: this.lease.run_id,
      kind: "model",
      purpose: this.lease.mode,
      fence: this.lease.fence,
      cancel_epoch: this.lease.cancel_epoch,
      prompt_hash: hashJson({ system: context.systemPrompt, n: context.messages.length }),
      requested_model: this.modelId,
      provider: this.providerName,
      reserved_calls: 1,
      reserved_tokens: 16,
    });
    this.budget.reserve(this.lease.campaign_id, inv.id, 1, 16, 0);
    this.invocations.mark(inv.id, "dispatching");
    this.invocations.mark(inv.id, "running");
    this.modelSends += 1;
    try {
      const stream = this.inner(model, context, options);
      return wrapSettle(stream, (msg) => {
        const tokens = Number(msg.usage?.totalTokens ?? 16);
        const failed = msg.stopReason === "error" || msg.stopReason === "aborted";
        this.invocations.mark(inv.id, failed ? "failed_known" : "completed", {
          actual_tokens: tokens,
          error: msg.errorMessage ?? undefined,
          status: msg.stopReason,
        });
        this.budget.settle(this.lease.campaign_id, inv.id, 1, tokens, 0, 1, tokens, 0);
      }, (err) => {
        this.invocations.mark(inv.id, "failed_known", { error: String(err) });
        this.budget.settle(this.lease.campaign_id, inv.id, 1, 16, 0, 1, 16, 0);
      });
    } catch (err) {
      this.invocations.mark(inv.id, "failed_known", { error: String(err) });
      this.budget.settle(this.lease.campaign_id, inv.id, 1, 16, 0, 1, 16, 0);
      return errorStream(model, err instanceof Error ? err.message : String(err));
    }
  };
}

export class ToolGateway {
  toolSends = 0;
  envSends = 0;
  blockedAfterFinish = 0;
  closed = false;

  constructor(
    private readonly storage: StorageService,
    private readonly budget: BudgetLedger,
    private readonly invocations: InvocationBook,
    private readonly lease: RunLease,
    private readonly dispatchGate?: DispatchGate,
  ) {}

  closeAdmission(): void {
    this.closed = true;
  }

  async admit(req: ToolInvokeRequest): Promise<ToolInvokeResult> {
    if (this.closed) {
      return { invocation_id: "none", blocked: true, reason: "gateway_closed", allowed: false };
    }
    const camp = this.storage.getCampaign(this.lease.campaign_id);
    if (camp.cancel_epoch !== this.lease.cancel_epoch && camp.cancel_epoch > this.lease.cancel_epoch) {
      return { invocation_id: "none", blocked: true, reason: "cancel_epoch", allowed: false };
    }
    const run = this.storage.getRun(this.lease.run_id);
    if (Number(run.fence) !== this.lease.fence) {
      return { invocation_id: "none", blocked: true, reason: "stale_fence", allowed: false };
    }
    if (req.envTool && !this.storage.envAdmissionOpen(this.lease.run_id)) {
      this.blockedAfterFinish += 1;
      return { invocation_id: "none", blocked: true, reason: "finish_closed_env", allowed: false };
    }
    const pathDenied = guardToolArgs(this.storage, this.lease.campaign_id, req.args);
    if (pathDenied) {
      return { invocation_id: "none", blocked: true, reason: pathDenied, allowed: false };
    }
    if (req.envTool) {
      if (!this.dispatchGate) {
        return { invocation_id: "none", blocked: true, reason: "no_dispatch_gate", allowed: false };
      }
      const ms = Math.max(1, this.lease.deadline_ms - Date.now());
      try {
        const timed = await runWithOuterDeadline(ms, async () =>
          this.dispatchGate!.dispatch({
            lease: this.lease,
            purpose: req.name,
            payload: req.args,
            effect: req.effect,
            envTool: true,
          }),
        );
        if (!timed.ok || !timed.value) {
          return { invocation_id: "none", blocked: true, reason: timed.residual, allowed: false };
        }
        if (timed.value.status !== "sent") {
          if (timed.value.reason === "finish_closed_env") this.blockedAfterFinish += 1;
          return {
            invocation_id: timed.value.invocation_id,
            blocked: true,
            reason: timed.value.reason ?? timed.value.status,
            allowed: false,
          };
        }
        this.toolSends += 1;
        this.envSends += 1;
        ingestToolOutputAsData(this.storage, this.lease.campaign_id, this.lease.run_id, JSON.stringify(req.args ?? {}));
        return { invocation_id: timed.value.invocation_id, blocked: false, allowed: true };
      } catch (err) {
        const reason = err instanceof DomainError ? err.code : String(err);
        return { invocation_id: "none", blocked: true, reason, allowed: false };
      }
    }
    if (!this.budget.canAdmit(this.lease.campaign_id, 1, 0, 0)) {
      throw new DomainError("budget_exhausted", "tool call exceeds root cap", "budget");
    }
    const inv = this.invocations.prepare({
      campaign_id: this.lease.campaign_id,
      run_id: this.lease.run_id,
      kind: "tool",
      purpose: req.name,
      fence: this.lease.fence,
      cancel_epoch: this.lease.cancel_epoch,
      effect_class: req.effect,
      reserved_calls: 1,
    });
    this.budget.reserve(this.lease.campaign_id, inv.id, 1, 0, 0);
    this.invocations.mark(inv.id, "dispatching");
    this.invocations.mark(inv.id, "running");
    this.toolSends += 1;
    this.invocations.mark(inv.id, "completed");
    this.budget.settle(this.lease.campaign_id, inv.id, 1, 0, 0, 1, 0, 0);
    ingestToolOutputAsData(this.storage, this.lease.campaign_id, this.lease.run_id, JSON.stringify(req.args ?? {}));
    return { invocation_id: inv.id, blocked: false, allowed: true };
  }
}

function errorStream(model: Model<string>, message: string): AssistantMessageEventStream {
  return createScriptedErrorStream(model, message);
}

function wrapSettle(
  stream: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  onOk: (msg: { usage?: { totalTokens?: number }; stopReason?: string; errorMessage?: string | null }) => void,
  onErr: (e: unknown) => void,
): AssistantMessageEventStream | Promise<AssistantMessageEventStream> {
  if (stream && typeof (stream as Promise<AssistantMessageEventStream>).then === "function") {
    return (stream as Promise<AssistantMessageEventStream>).then((s) => wrapSettle(s, onOk, onErr) as AssistantMessageEventStream);
  }
  const s = stream as AssistantMessageEventStream;
  const orig = s.result.bind(s);
  (s as unknown as { result: () => Promise<unknown> }).result = async () => {
    try {
      const r = (await orig()) as { usage?: { totalTokens?: number }; stopReason?: string; errorMessage?: string | null };
      onOk(r);
      return r;
    } catch (e) {
      onErr(e);
      throw e;
    }
  };
  return s;
}

export { denied };
