import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ContextPack, WorkerFactory, WorkerRuntime } from "../../contracts/worker-runtime.ts";
import { newId } from "../../domain/ids.ts";
import type { RunLease, TaskOutcome, WorkerMode } from "../../domain/types.ts";
import { ingestToolOutputAsData, type ModelGateway, type ToolGateway } from "../../gateway/gateways.ts";
import type { StorageService } from "../../storage/service.ts";
import { isKaliProfile } from "../../tools/kali-profile.ts";
import type { KaliRuntime } from "../../tools/kali-runtime.ts";
import { actWorld, inspectWorld, type LabWorld } from "../../tools/synthetic.ts";
import type { StreamFn as PiStreamFn } from "@earendil-works/pi-agent-core";
import { SCRIPTED_MODEL, type TurnChooser, createScriptedStreamFn } from "./scripted-stream.ts";

export interface FactoryDeps {
  storage: StorageService;
  modelGatewayFor: (lease: RunLease, inner: PiStreamFn) => ModelGateway;
  toolGatewayFor: (lease: RunLease) => ToolGateway;
  chooseDecide: TurnChooser;
  chooseExecute: TurnChooser;
  getMaxTurns: () => { decide: number; execute: number; tools?: number };
  kali?: KaliRuntime;
  liveStream?: PiStreamFn;
}

export class PiWorkerFactory implements WorkerFactory {
  constructor(private readonly deps: FactoryDeps) {}

  create(mode: WorkerMode, run_id: string): WorkerRuntime {
    return new PiWorker(mode, run_id, this.deps);
  }
}

export class PiWorker implements WorkerRuntime {
  readonly mode: WorkerMode;
  readonly run_id: string;
  private abortCtrl: AbortController | null = null;
  private outcome: TaskOutcome | null = null;
  private settled: Promise<TaskOutcome> | null = null;
  agent: Agent | null = null;
  readonly submittedObservations: string[] = [];
  readonly submittedFacts: string[] = [];
  readonly submittedFindings: string[] = [];
  events: AgentEvent[] = [];
  toolExecution: "sequential" | "parallel" = "sequential";
  finishThenBlocked = 0;
  modelGateway: ModelGateway | null = null;
  toolGateway: ToolGateway | null = null;

  constructor(
    mode: WorkerMode,
    run_id: string,
    private readonly deps: FactoryDeps,
  ) {
    this.mode = mode;
    this.run_id = run_id;
  }

  abort(): void {
    this.abortCtrl?.abort();
    this.agent?.abort();
    this.agent?.clearAllQueues();
  }

  async start(lease: RunLease, context: ContextPack, signal: AbortSignal): Promise<void> {
    this.abortCtrl = new AbortController();
    signal.addEventListener("abort", () => this.abort());
    const chooser = this.mode === "decide" ? this.deps.chooseDecide : this.deps.chooseExecute;
    const inner = this.deps.liveStream ?? createScriptedStreamFn(chooser);
    this.modelGateway = this.deps.modelGatewayFor(lease, inner);
    this.toolGateway = this.deps.toolGatewayFor(lease);
    const tools = this.buildTools(lease, context);
    const caps = this.deps.getMaxTurns();
    const maxTurns = this.mode === "decide" ? caps.decide : caps.execute;
    let turns = 0;
    let finishRequested = false;
    const thinkingLevel = this.deps.storage.getCampaign(lease.campaign_id).spec.model_policy.thinking_level;
    const agent = new Agent({
      initialState: {
        systemPrompt: context.system_prompt,
        model: SCRIPTED_MODEL,
        thinkingLevel,
        tools,
      },
      streamFn: this.modelGateway.stream,
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall }) => {
        const env = isEnvTool(toolCall.name);
        if (this.mode === "decide" && env) {
          return { block: true, reason: "decide_has_no_env_tools" };
        }
        const admitted = await this.toolGateway!.admit({
          name: toolCall.name,
          args: toolCall.arguments,
          lease,
          effect: env ? "unknown" : "pure",
          envTool: env,
        });
        if (!admitted.allowed) {
          if (admitted.reason === "finish_closed_env") this.finishThenBlocked += 1;
          return { block: true, reason: admitted.reason, terminate: admitted.reason === "finish_closed_env" };
        }
        return undefined;
      },
      afterToolCall: async ({ toolCall, result }) => {
        const text = (result.content ?? [])
          .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
          .join("");
        const raw = text + JSON.stringify(result.details ?? {});
        ingestToolOutputAsData(this.deps.storage, lease.campaign_id, lease.run_id, raw);
        const art = await this.deps.storage.putArtifact(lease.campaign_id, raw.slice(0, 200_000), "application/json", lease.run_id);
        if (isEnvTool(toolCall.name)) {
          this.deps.storage.recordObservation({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            attempt_id: lease.run_id,
            subject: `tool_raw:${toolCall.name}`,
            body: { name: toolCall.name, arguments: toolCall.arguments, preview: text.slice(0, 8000) },
            artifact_refs: [art.id],
            conditions: {},
            env_rev: String(
              (this.deps.storage.getWorld<LabWorld>(lease.campaign_id, { env_rev: "env-1" } as LabWorld) as LabWorld).env_rev ?? "env-1",
            ),
            skip_progress: true,
          });
        }
        if (toolCall.name === "finish_step" || toolCall.name === "finish_decision") {
          finishRequested = true;
          return { terminate: true, details: result.details };
        }
        return undefined;
      },
      shouldStopAfterTurn: async () => {
        turns += 1;
        if (finishRequested) return true;
        if (turns >= maxTurns) return true;
        const toolCap = this.deps.getMaxTurns().tools ?? 24;
        if ((this.toolGateway?.toolSends ?? 0) >= toolCap) return true;
        return false;
      },
    });
    this.toolExecution = agent.toolExecution;
    this.agent = agent;
    agent.subscribe((event) => {
      this.events.push(event);
    });
    this.settled = (async () => {
      try {
        await agent.prompt(JSON.stringify(context.user_payload));
        await agent.waitForIdle();
      } catch (err) {
        this.outcome = this.makeOutcome(lease, "protocol_error", String(err), finishRequested);
        return this.outcome;
      }
      if (!this.outcome) {
        this.outcome = this.makeOutcome(
          lease,
          finishRequested ? "resolved" : "incomplete_protocol",
          finishRequested ? "finished" : "missing finish tool",
          finishRequested,
        );
      }
      return this.outcome;
    })();
    void this.settled;
  }

  async settle(): Promise<TaskOutcome> {
    if (!this.settled) throw new Error("worker not started");
    return this.settled;
  }

  private makeOutcome(
    lease: RunLease,
    reason: TaskOutcome["reason"],
    summary: string,
    finish_requested: boolean,
    blocked_on?: string,
  ): TaskOutcome {
    return baseOutcome(
      lease,
      reason,
      summary,
      [...this.submittedObservations],
      [...this.submittedFacts],
      [...this.submittedFindings],
      finish_requested,
      blocked_on,
    );
  }

  private recordSubmit(kind: "obs" | "fact" | "find", id: string | undefined): void {
    if (!id) return;
    if (kind === "obs" && !this.submittedObservations.includes(id)) this.submittedObservations.push(id);
    if (kind === "fact" && !this.submittedFacts.includes(id)) this.submittedFacts.push(id);
    if (kind === "find" && !this.submittedFindings.includes(id)) this.submittedFindings.push(id);
  }

  private buildTools(lease: RunLease, context: ContextPack): AgentTool[] {
    const s = this.deps.storage;
    const tools: AgentTool[] = [
      tool("graph_query", "Query graph", Type.Object({
        entity: Type.String({ description: "facts|steps|goals|findings|coverage|observations" }),
        limit: Type.Optional(Type.Number()),
        offset: Type.Optional(Type.Number()),
      }), async (_id, params) => {
        const result = s.graphQuery(lease.campaign_id, params as { entity: string; limit?: number; offset?: number });
        return ok(result);
      }),
      tool("artifact_read", "Read a byte slice of a saved original. If kali_run set truncated, pass artifact_id and next_offset to get the next chunk.", Type.Object({
        artifact_id: Type.String(),
        offset: Type.Optional(Type.Number()),
        length: Type.Optional(Type.Number()),
      }), async (_id, params) => {
        const p = params as { artifact_id: string; offset?: number; length?: number };
        const row = s.store.db.prepare("SELECT * FROM artifacts WHERE id = ? AND campaign_id = ?").get(p.artifact_id, lease.campaign_id) as
          | { path: string; hash: string; size: number }
          | undefined;
        if (!row) throw new Error("artifact not in campaign");
        const offset = Math.max(0, p.offset ?? 0);
        const want = Math.min(ARTIFACT_SLICE_MAX, Math.max(1, p.length ?? ARTIFACT_SLICE_MAX));
        const buf = await s.artifacts.read(row.path, offset, want);
        return ok(artifactSlicePayload({
          text: buf.toString("utf8"),
          byte_length: buf.length,
          offset,
          total: Number(row.size),
          artifact_id: p.artifact_id,
          hash: row.hash,
        }));
      }),
      tool("checkpoint", "Save checkpoint", Type.Object({
        note: Type.String(),
        next: Type.Optional(Type.String()),
      }), async (_id, params) => {
        const p = params as { note: string; next?: string };
        const saved = s.saveCheckpoint({
          campaign_id: lease.campaign_id,
          run_id: lease.run_id,
          note: p.note,
          next: p.next,
          payload: { mode: this.mode, step_id: lease.step_id },
        });
        return ok({ saved: true, checkpoint_id: saved.id, note: p.note, next: p.next ?? null });
      }),
    ];
    if (this.mode === "decide") {
      tools.push(
        tool("propose_plan", "Submit typed plan. Decide cannot fetch URLs. Use propose_step so Execute can kali_run/playwright. Example: {\"operations\":[{\"op\":\"propose_step\",\"question\":\"GET the challenge homepage and record the HTML\",\"kind\":\"explore\",\"methodFamily\":\"http-probe\"}]}", Type.Object({
          operations: Type.Array(Type.Unknown()),
          no_change_reason: Type.Optional(Type.String()),
        }), async (_id, params) => {
          const p = params as { operations: unknown[]; no_change_reason?: string };
          try {
            const result = s.applyProposalBatch({
              campaign_id: lease.campaign_id,
              producer_id: lease.run_id,
              submission_id: newId("sub"),
              run_id: lease.run_id,
              operations: p.operations,
              no_change_reason: p.no_change_reason,
              read_set: context.manifest.selected_entity_revisions,
            });
            return ok(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: message, allowed_ops: ["propose_step"], hint: "Do not invent HTTP ops. propose_step then finish_decision." }) }],
              details: { error: message },
              isError: true,
            };
          }
        }),
        tool("finish_decision", "Finish decide run", Type.Object({
          summary: Type.String(),
          reviewed_note: Type.Optional(Type.String()),
        }), async (_id, params) => {
          s.markFinishRequested(lease.campaign_id, lease.run_id, lease.fence);
          const p = params as { summary: string };
          this.outcome = this.makeOutcome(lease, "resolved", p.summary, true);
          return { ...ok({ finish: true }), terminate: true };
        }),
      );
    } else {
      tools.push(
        tool("submit_observation", "Submit observation", Type.Object({
          subject: Type.String(),
          body: Type.Unknown(),
          artifact_text: Type.Optional(Type.String()),
          conditions: Type.Optional(Type.Unknown()),
        }), async (_id, params) => {
          const p = params as { subject: string; body: unknown; artifact_text?: string; conditions?: Record<string, unknown> };
          const art = await s.putArtifact(lease.campaign_id, JSON.stringify(p.body), "application/json", lease.run_id);
          const result = s.recordObservation({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            attempt_id: lease.run_id,
            subject: p.subject,
            body: p.body,
            artifact_refs: [art.id],
            conditions: p.conditions ?? {},
            env_rev: String((s.getWorld<LabWorld>(lease.campaign_id, { env_rev: "env-1" } as LabWorld) as LabWorld).env_rev ?? "env-1"),
          });
          this.recordSubmit("obs", result.canonical_ids.observation_id);
          return ok(result);
        }),
        tool("submit_fact", "Submit a fact. A success-predicate fact (e.g. flag_recovered) is only a candidate until a human verifies it.", Type.Object({
          proposition: Type.String(),
          fact_key: Type.Optional(Type.String()),
          support_refs: Type.Array(Type.String()),
          conditions: Type.Optional(Type.Unknown()),
          source_grade: Type.Optional(Type.String()),
        }), async (_id, params) => {
          const p = params as { proposition: string; fact_key?: string; support_refs: string[]; conditions?: Record<string, unknown>; source_grade?: "observed" | "derived" };
          const result = s.submitFact({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            proposition: p.proposition,
            fact_key: p.fact_key,
            support_refs: p.support_refs,
            conditions: p.conditions ?? {},
            source_grade: p.source_grade,
          });
          this.recordSubmit("fact", result.canonical_ids.fact_id);
          return ok(result);
        }),
        tool("submit_finding", "Submit finding candidate", Type.Object({
          claim: Type.String(),
          evidence_refs: Type.Array(Type.String()),
          dedup_key: Type.String(),
          impact: Type.Optional(Type.String()),
          model_confidence: Type.Optional(Type.Number()),
        }), async (_id, params) => {
          const p = params as { claim: string; evidence_refs: string[]; dedup_key: string; impact?: string; model_confidence?: number };
          const result = s.submitFinding({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            claim: p.claim,
            evidence_refs: p.evidence_refs,
            dedup_key: p.dedup_key,
            impact: p.impact,
            model_confidence: p.model_confidence,
          });
          this.recordSubmit("find", result.canonical_ids.finding_id);
          return ok(result);
        }),
        tool("propose_step", "Suggest a step", Type.Object({
          question: Type.String(),
          kind: Type.String(),
          method_family: Type.String(),
          fingerprint: Type.String(),
          preconditions: Type.Optional(Type.Unknown()),
          retry_reason: Type.Optional(Type.String()),
        }), async (_id, params) => {
          const p = params as {
            question: string;
            kind: "explore" | "verify" | "acquire_prerequisite" | "reconcile";
            method_family: string;
            fingerprint: string;
            preconditions?: unknown;
            retry_reason?: string;
          };
          const root = s.store.db.prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1").get(lease.campaign_id) as { id: string };
          const result = s.proposeStepDirect({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            question: p.question,
            kind: p.kind,
            goal_refs: [root.id],
            preconditions: (p.preconditions as never) ?? { op: "all", of: [] },
            method_family: p.method_family,
            expected_observations: [],
            completion_criteria: "observe",
            fingerprint: p.fingerprint,
            reopen_rule: { kind: "never" },
            retry_reason: p.retry_reason,
          });
          return ok(result);
        }),
        tool("world_inspect", "Inspect synthetic world", Type.Object({
          target: Type.String(),
        }), async (_id, params) => {
          const world = s.getWorld<LabWorld>(lease.campaign_id, { env_rev: "env-1" } as LabWorld);
          const result = inspectWorld(world, (params as { target: string }).target);
          s.saveWorld(lease.campaign_id, result.world);
          return ok({ observation: result.observation, subject: result.subject });
        }),
        tool("world_act", "Act in synthetic world", Type.Object({
          action: Type.String(),
          arg: Type.Optional(Type.String()),
        }), async (_id, params) => {
          const world = s.getWorld<LabWorld>(lease.campaign_id, { env_rev: "env-1" } as LabWorld);
          const p = params as { action: string; arg?: string };
          const result = actWorld(world, p.action, p.arg);
          s.saveWorld(lease.campaign_id, result.world);
          return ok({ observation: result.observation, subject: result.subject, transient: result.transient ?? false });
        }),
        tool("kali_run", "Run an allowlisted Kali binary in the campaign container. nmap/nuclei/katana and other scanners return immediately with execution_id and keep running in the container (up to 60 min). Do not poll; finish_step. bash/sh/python3 run /workspace scripts or bash -c.", Type.Object({
          kind: Type.Literal("kali"),
          bin: Type.String(),
          args: Type.Array(Type.String()),
          url: Type.Optional(Type.String()),
          redirects: Type.Optional(Type.Array(Type.String())),
          timeout_ms: Type.Optional(Type.Number()),
        }), async (_id, _params) => {
          return ok(await packKaliExec(s, lease, this.deps.kali?.takeLast(lease.campaign_id), "no_kali_result"));
        }),
        tool("kali_write", "Write a script or payload file into the campaign container workspace (/workspace)", Type.Object({
          kind: Type.Literal("kali_write"),
          path: Type.String({ description: "Relative path under /workspace, e.g. payloads/xss.html" }),
          content: Type.String(),
        }), async (_id, _params) => {
          return ok(await packKaliExec(s, lease, this.deps.kali?.takeLast(lease.campaign_id), "no_kali_write_result"));
        }),
        tool("playwright", "Operate the persistent Playwright Chromium in the Kali container (goto/snapshot/click/type/press/screenshot/content/wait/back/status). Use snapshot refs for click/type.", Type.Object({
          kind: Type.Literal("playwright"),
          op: Type.String({ description: "goto|snapshot|click|type|press|screenshot|content|wait|back|status" }),
          url: Type.Optional(Type.String()),
          ref: Type.Optional(Type.String()),
          selector: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          key: Type.Optional(Type.String()),
          timeout_ms: Type.Optional(Type.Number()),
          redirects: Type.Optional(Type.Array(Type.String())),
        }), async (_id, _params) => {
          return ok(await packKaliExec(s, lease, this.deps.kali?.takeLast(lease.campaign_id), "no_playwright_result"));
        }),
        tool("finish_step", "Finish execute fragment", Type.Object({
          reason: Type.String(),
          summary: Type.String(),
          blocked_on: Type.Optional(Type.String()),
        }), async (_id, params) => {
          s.markFinishRequested(lease.campaign_id, lease.run_id, lease.fence);
          const p = params as { reason: TaskOutcome["reason"]; summary: string; blocked_on?: string };
          const reason = (["resolved", "deferred", "blocked", "cancelled", "budget", "context_limit", "protocol_error", "incomplete_protocol"] as string[]).includes(p.reason)
            ? (p.reason as TaskOutcome["reason"])
            : "resolved";
          this.outcome = this.makeOutcome(lease, reason, p.summary, true, p.blocked_on);
          return { ...ok({ finish: true }), terminate: true };
        }),
      );
    }
    const camp = s.getCampaign(lease.campaign_id);
    if (this.mode === "execute") {
      const drop = isKaliProfile(camp.spec.execution_profile)
        ? new Set(["world_inspect", "world_act"])
        : new Set(["kali_run", "kali_write", "playwright", "browser_fetch"]);
      for (let i = tools.length - 1; i >= 0; i--) {
        if (drop.has(tools[i]!.name)) tools.splice(i, 1);
      }
    }
    const allowed = new Set(context.tool_names);
    return tools.filter((t) => allowed.has(t.name));
  }
}

function tool(
  name: string,
  description: string,
  parameters: AgentTool["parameters"],
  execute: AgentTool["execute"],
): AgentTool {
  return { name, label: name, description, parameters, execute };
}

function ok(details: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

export const TOOL_STDOUT_PREVIEW = 8000;
export const TOOL_STDERR_PREVIEW = 2000;
export const ARTIFACT_SLICE_MAX = 8192;

async function packKaliExec(
  storage: StorageService,
  lease: RunLease,
  last: { stdout: string; stderr: string; code: number; timedOut: boolean; truncated: boolean; container: string } | undefined,
  empty: string,
): Promise<unknown> {
  if (!last) return { error: empty };
  const stored = await storage.putArtifact(lease.campaign_id, last.stdout ?? "", "text/plain", lease.run_id);
  return decodeExec(last, empty, { id: stored.id, size: stored.size });
}

export function decodeExec(
  result: { stdout: string; stderr: string; code: number; timedOut: boolean; truncated: boolean; container: string } | undefined,
  empty: string,
  art?: { id: string; size: number },
): unknown {
  if (!result) return { error: empty };
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const stdoutBuf = Buffer.from(stdout, "utf8");
  const stderrBuf = Buffer.from(stderr, "utf8");
  const previewCut = stdoutBuf.length > TOOL_STDOUT_PREVIEW;
  const stderrCut = stderrBuf.length > TOOL_STDERR_PREVIEW;
  const truncated = Boolean(result.truncated || previewCut || stderrCut);
  const shownBuf = stdoutBuf.subarray(0, TOOL_STDOUT_PREVIEW);
  const shown = shownBuf.toString("utf8");
  const out: Record<string, unknown> = {
    code: result.code,
    truncated,
    preview_truncated: previewCut,
    output_capped: Boolean(result.truncated),
    container: result.container,
    timedOut: result.timedOut,
    stdout_bytes: stdoutBuf.length,
    shown_bytes: shownBuf.length,
    stderr: stderrBuf.subarray(0, TOOL_STDERR_PREVIEW).toString("utf8"),
    result: shown,
  };
  if (art) {
    out.artifact_id = art.id;
    out.artifact_bytes = art.size;
  }
  if (truncated) {
    const next = previewCut ? shownBuf.length : null;
    out.next_offset = next;
    out.remaining_bytes = Math.max(0, (art?.size ?? stdoutBuf.length) - shownBuf.length);
    if (art && next != null) {
      out.read_next = `artifact_read artifact_id=${art.id} offset=${next} length=${TOOL_STDOUT_PREVIEW}`;
    }
  }
  return out;
}

export function artifactSlicePayload(args: {
  text: string;
  byte_length: number;
  offset: number;
  total: number;
  artifact_id: string;
  hash: string;
}): Record<string, unknown> {
  const more = args.offset + args.byte_length < args.total;
  return {
    text: args.text,
    artifact_id: args.artifact_id,
    hash: args.hash,
    derived: false,
    offset: args.offset,
    length: args.byte_length,
    total: args.total,
    truncated: more,
    next_offset: more ? args.offset + args.byte_length : null,
  };
}

function isEnvTool(name: string): boolean {
  return (
    name === "world_inspect" ||
    name === "world_act" ||
    name === "bash" ||
    name === "write" ||
    name === "edit" ||
    name === "kali_run" ||
    name === "kali_write" ||
    name === "playwright" ||
    name === "browser_fetch"
  );
}

function baseOutcome(
  lease: RunLease,
  reason: TaskOutcome["reason"],
  summary: string,
  observation_ids: string[],
  fact_ids: string[],
  finding_ids: string[],
  finish_requested: boolean,
  blocked_on?: string,
): TaskOutcome {
  return {
    run_id: lease.run_id,
    step_id: lease.step_id,
    mode: lease.mode,
    reason,
    summary,
    observation_ids,
    fact_ids,
    finding_ids,
    blocked_on: blocked_on ?? null,
    reopen_rule: null,
    finish_requested,
    protocol_error: reason === "protocol_error" || reason === "incomplete_protocol" ? summary : null,
  };
}

