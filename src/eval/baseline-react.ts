import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { validateCampaignSpec } from "../domain/spec.ts";
import { createScriptedStreamFn } from "../runtime/pi/scripted-stream.ts";
import { SCRIPTED_MODEL } from "../runtime/pi/scripted-stream.ts";
import { actWorld, freshWorld, inspectWorld, type LabWorld } from "../tools/synthetic.ts";
import { reactChooser } from "./demo-policy.ts";

export async function runReactBaseline(specInput: unknown, _dataDir: string): Promise<Record<string, unknown>> {
  const spec = validateCampaignSpec(specInput);
  const maxCalls = spec.budget.max_calls ?? 20;
  let world = freshWorld();
  let calls = 0;
  const invocations: string[] = [];
  const inspect: AgentTool = {
    name: "world_inspect",
    label: "inspect",
    description: "Inspect the lab",
    parameters: Type.Object({ target: Type.String() }),
    execute: async (_id, params) => {
      calls += 1;
      if (calls > maxCalls) throw new Error("budget cap");
      const r = inspectWorld(world, (params as { target: string }).target);
      world = r.world;
      invocations.push(`world_inspect:${(params as { target: string }).target}`);
      return { content: [{ type: "text", text: r.observation }], details: { observation: r.observation, subject: r.subject } };
    },
  };
  const act: AgentTool = {
    name: "world_act",
    label: "act",
    description: "Act in the lab",
    parameters: Type.Object({ action: Type.String(), arg: Type.Optional(Type.String()) }),
    execute: async (_id, params) => {
      calls += 1;
      if (calls > maxCalls) throw new Error("budget cap");
      const p = params as { action: string; arg?: string };
      const r = actWorld(world, p.action, p.arg);
      world = r.world;
      invocations.push(`world_act:${p.action}`);
      return { content: [{ type: "text", text: r.observation }], details: { observation: r.observation, subject: r.subject } };
    },
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: "Solve the lab cabinet task with tools. Same budget as RioNext.",
      model: SCRIPTED_MODEL,
      tools: [inspect, act],
    },
    streamFn: createScriptedStreamFn(reactChooser()),
    toolExecution: "sequential",
    shouldStopAfterTurn: async () => calls >= maxCalls || world.cabinet_open,
  });
  await agent.prompt(spec.root_goal.statement);
  await agent.waitForIdle();
  return {
    baseline: "B0-react",
    tool_invocations: invocations,
    model_sends: calls,
    tool_sends: calls,
    env_sends: calls,
    model_turns_capped_by: maxCalls,
    calls,
    recovered: world.cabinet_open,
    sample_id: world.cabinet_open ? world.sample_id : null,
    budget: spec.budget,
  };
}
