import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRuntimeConfig, printStartupBanner, validateStartupInput } from "../../src/contracts/config.ts";
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

test("startup banner has versions and no secrets", () => {
  const runtime = makeRuntimeConfig("C:/tmp/rionext-x");
  const lines: string[] = [];
  printStartupBanner(runtime, (s) => lines.push(s));
  const text = lines.join("\n");
  assert.match(text, /pi_version/);
  assert.match(text, /schema_version/);
  assert.doesNotMatch(text, /sk-|api_key|password|secret/i);
});
