import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createQueuedStreamFn, createScriptedStreamFn, SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";

test("Pi smoke: tool call, execute, clean stop, sequential", async () => {
  const events: AgentEvent[] = [];
  let ran = false;
  const echo: AgentTool = {
    name: "echo",
    label: "echo",
    description: "echo",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params) => {
      ran = true;
      return { content: [{ type: "text", text: String((params as { text: string }).text) }], details: params };
    },
  };
  const agent = new Agent({
    initialState: { systemPrompt: "test", model: SCRIPTED_MODEL, tools: [echo] },
    streamFn: createQueuedStreamFn([
      { type: "tool_calls", calls: [{ name: "echo", arguments: { text: "hi" } }] },
      { type: "text", text: "done" },
    ]),
    toolExecution: "sequential",
  });
  assert.equal(agent.toolExecution, "sequential");
  agent.subscribe((e) => {
    events.push(e);
  });
  await agent.prompt("go");
  await agent.waitForIdle();
  assert.equal(ran, true);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("agent_start"));
  assert.ok(types.includes("tool_execution_start"));
  assert.ok(types.includes("tool_execution_end"));
  assert.equal(types[types.length - 1], "agent_end");
  const start = types.indexOf("tool_execution_start");
  const end = types.indexOf("tool_execution_end");
  assert.ok(start < end);
});

test("T20 StreamFn network/budget failure ends as error, does not hang", async () => {
  const agent = new Agent({
    initialState: { systemPrompt: "test", model: SCRIPTED_MODEL, tools: [] },
    streamFn: createScriptedStreamFn(() => ({ type: "error", message: "budget_exhausted" })),
    toolExecution: "sequential",
  });
  await agent.prompt("go");
  await agent.waitForIdle();
  assert.equal(agent.state.errorMessage, "budget_exhausted");
});
