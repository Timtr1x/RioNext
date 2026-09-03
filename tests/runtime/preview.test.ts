import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIFACT_SLICE_MAX,
  TOOL_STDOUT_PREVIEW,
  artifactSlicePayload,
  decodeExec,
} from "../../src/runtime/pi/factory.ts";

const base = {
  code: 0,
  timedOut: false,
  truncated: false,
  container: "rionext-kali-x",
  stderr: "",
};

test("kali preview under the cap is not marked truncated", () => {
  const got = decodeExec({ ...base, stdout: "hello" }, "empty") as Record<string, unknown>;
  assert.equal(got.truncated, false);
  assert.equal(got.preview_truncated, false);
  assert.equal(got.result, "hello");
  assert.equal(got.next_offset, undefined);
});

test("kali preview over the cap tells the model and keeps a next_offset", () => {
  const stdout = "A".repeat(TOOL_STDOUT_PREVIEW + 50) + "UPDATE_PHP_BODY";
  const got = decodeExec({ ...base, stdout }, "empty", { id: "art_1", size: stdout.length }) as Record<string, unknown>;
  assert.equal(got.truncated, true);
  assert.equal(got.preview_truncated, true);
  assert.equal(got.output_capped, false);
  assert.equal(got.shown_bytes, TOOL_STDOUT_PREVIEW);
  assert.equal(got.stdout_bytes, stdout.length);
  assert.equal(got.next_offset, TOOL_STDOUT_PREVIEW);
  assert.equal(got.remaining_bytes, 50 + "UPDATE_PHP_BODY".length);
  assert.equal(got.artifact_id, "art_1");
  assert.equal(String(got.result).includes("UPDATE_PHP_BODY"), false);
  assert.equal(String(got.read_next).includes(`offset=${TOOL_STDOUT_PREVIEW}`), true);
});

test("json stdout is still sliced so a large json dump cannot bypass the preview cap", () => {
  const stdout = JSON.stringify({ blob: "Z".repeat(TOOL_STDOUT_PREVIEW) });
  const got = decodeExec({ ...base, stdout }, "empty") as Record<string, unknown>;
  assert.equal(got.truncated, true);
  assert.equal(typeof got.result, "string");
  assert.ok(String(got.result).length <= TOOL_STDOUT_PREVIEW);
});

test("artifact_read payload pages the rest and clears truncated on the last slice", () => {
  const total = TOOL_STDOUT_PREVIEW + 20;
  const mid = artifactSlicePayload({
    text: "B".repeat(20),
    byte_length: 20,
    offset: TOOL_STDOUT_PREVIEW,
    total,
    artifact_id: "art_1",
    hash: "abc",
  });
  assert.equal(mid.truncated, false);
  assert.equal(mid.next_offset, null);
  assert.equal(mid.offset, TOOL_STDOUT_PREVIEW);

  const first = artifactSlicePayload({
    text: "A".repeat(ARTIFACT_SLICE_MAX),
    byte_length: ARTIFACT_SLICE_MAX,
    offset: 0,
    total: ARTIFACT_SLICE_MAX + 100,
    artifact_id: "art_1",
    hash: "abc",
  });
  assert.equal(first.truncated, true);
  assert.equal(first.next_offset, ARTIFACT_SLICE_MAX);
});
