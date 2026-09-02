import assert from "node:assert/strict";
import { test } from "node:test";
import { runReactBaseline } from "../../src/eval/baseline-react.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";

test("B0 ReAct baseline executes tools under the same cap", async () => {
  const spec = loadDemoSpec("b0");
  const result = await runReactBaseline(spec, ".");
  const invocations = result.tool_invocations as string[];
  assert.ok(invocations.length > 0);
  assert.ok((result.calls as number) <= (spec.budget.max_calls ?? 80));
});
