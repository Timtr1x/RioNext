import assert from "node:assert/strict";
import { test } from "node:test";
import { applyExecuteLimitFlags, applyFinalizationFlags, makeRuntimeConfig, printStartupBanner, validateStartupInput } from "../../src/contracts/config.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";

test("startup rejects unknown state-like invalid spec before any run", () => {
  const runtime = makeRuntimeConfig(":memory-data:");
  runtime.db_path = ":memory:";
  const spec = loadDemoSpec("c1");
  validateStartupInput(spec, runtime);
  spec.model_policy.provider = "openai";
  assert.throws(() => validateStartupInput(spec, runtime), DomainError);
});

test("worker lease default covers a long high-thinking execute", () => {
  const runtime = makeRuntimeConfig(":memory-data:");
  assert.equal(runtime.lease_ttl_ms, 60 * 60_000);
});

test("execute fragment defaults to 72 model turns and 144 tool calls", () => {
  const runtime = makeRuntimeConfig(":memory-data:");
  assert.equal(runtime.max_execute_turns_per_run, 72);
  assert.equal(runtime.max_tool_calls_per_run, 144);
  assert.equal(runtime.max_decide_turns, 18);
});

test("applyExecuteLimitFlags sets turn and tool caps from CLI", () => {
  const runtime = applyExecuteLimitFlags(makeRuntimeConfig(":memory-data:"), {
    "max-execute-turns": "36",
    "max-tool-calls": "72",
  });
  assert.equal(runtime.max_execute_turns_per_run, 36);
  assert.equal(runtime.max_tool_calls_per_run, 72);
  assert.throws(
    () => applyExecuteLimitFlags(makeRuntimeConfig(":memory-data:"), { "max-execute-turns": true }),
    DomainError,
  );
});

test("finalization is enabled by default", () => {
  const runtime = makeRuntimeConfig(":memory-data:");
  assert.equal(runtime.finalization.enabled, true);
  const applied = applyFinalizationFlags(makeRuntimeConfig(":memory-data:"), {}, {});
  assert.equal(applied.finalization.enabled, true);
});

test("applyFinalizationFlags CLI and env can turn Finalize off", () => {
  const cliOff = applyFinalizationFlags(makeRuntimeConfig(":memory-data:"), { "no-finalization": true }, { RIONEXT_FINALIZATION: "1" });
  assert.equal(cliOff.finalization.enabled, false);
  const envOff = applyFinalizationFlags(makeRuntimeConfig(":memory-data:"), {}, { RIONEXT_FINALIZATION: "0" });
  assert.equal(envOff.finalization.enabled, false);
});

test("startup banner has versions and no secrets", () => {
  const runtime = makeRuntimeConfig("C:/tmp/rionext-x");
  const lines: string[] = [];
  printStartupBanner(runtime, (s) => lines.push(s));
  const text = lines.join("\n");
  assert.match(text, /pi_version/);
  assert.match(text, /schema_version/);
  assert.doesNotMatch(text, /sk-|api_key|password|secret/i);
});
