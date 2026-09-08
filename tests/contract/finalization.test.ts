import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPrompt } from "../../src/context/builder.ts";
import { parseFinishInput } from "../../src/contracts/finalization.ts";

test("parseFinishInput deferred with next_action and no rule becomes always", () => {
  const parsed = parseFinishInput({
    disposition: "deferred",
    summary: "33 failed",
    next_action: "try 34",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.reopen_rule, { kind: "always" });
  assert.equal(parsed.value.next_action, "try 34");
});

test("parseFinishInput deferred without next_action becomes never", () => {
  const parsed = parseFinishInput({
    disposition: "deferred",
    summary: "no useful continuation",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.reopen_rule, { kind: "never" });
});

test("parseFinishInput explicit never wins over next_action", () => {
  const parsed = parseFinishInput({
    disposition: "deferred",
    summary: "operator review required",
    next_action: "wait",
    reopen_rule: { kind: "never" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.reopen_rule, { kind: "never" });
  assert.equal(parsed.value.next_action, "wait");
});

test("parseFinishInput blocked without rule becomes never", () => {
  const parsed = parseFinishInput({
    disposition: "blocked",
    summary: "need key",
    blocked_on: "missing_key",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.reopen_rule, { kind: "never" });
});

test("parseFinishInput blocked keeps an explicit wake rule", () => {
  const parsed = parseFinishInput({
    disposition: "blocked",
    summary: "need key",
    blocked_on: "missing_key",
    reopen_rule: { kind: "fact_key", key: "has_key" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.reopen_rule, { kind: "fact_key", key: "has_key" });
});

test("parseFinishInput invalid reopen_rule is treated as missing, not resolved", () => {
  const parsed = parseFinishInput({
    disposition: "deferred",
    summary: "33 failed",
    next_action: "try 34",
    reopen_rule: { kind: "bogus" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.notEqual(parsed.value.disposition, "resolved");
  assert.equal(parsed.value.disposition, "deferred");
  assert.deepEqual(parsed.value.reopen_rule, { kind: "always" });
});

test("finalize prompt requires one finish_step and deferred always/never", () => {
  const prompt = loadPrompt("finalize");
  assert.match(prompt, /只能调用一次 finish_step/);
  assert.match(prompt, /resolved/);
  assert.match(prompt, /deferred/);
  assert.match(prompt, /blocked/);
  assert.match(prompt, /reopen_rule=\{"kind":"always"\}/);
  assert.match(prompt, /reopen_rule=\{"kind":"never"\}/);
  assert.match(prompt, /fact_key/);
  assert.match(prompt, /env_revision/);
  assert.match(prompt, /observation_subject/);
  assert.match(prompt, /没有足够证据时不得选择 resolved/);
});

test("parseFinishInput invalid fact_key without key is missing", () => {
  const parsed = parseFinishInput({
    disposition: "blocked",
    summary: "waiting",
    blocked_on: "fact",
    reopen_rule: { kind: "fact_key" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.reopen_rule, { kind: "never" });
});
