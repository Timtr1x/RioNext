import assert from "node:assert/strict";
import { test } from "node:test";
import { evalAll, evalAny, evalPredicate, unknownNeverAdmits } from "../../src/domain/predicates.ts";

test("unknown AND is unknown, never admits", () => {
  assert.equal(evalAll(["true", "unknown"]), "unknown");
  assert.equal(unknownNeverAdmits("unknown"), false);
  assert.equal(unknownNeverAdmits("true"), true);
});

test("unknown OR true is true; unknown OR false is unknown", () => {
  assert.equal(evalAny(["unknown", "true"]), "true");
  assert.equal(evalAny(["unknown", "false"]), "unknown");
  assert.equal(evalAny(["false", "false"]), "false");
});

test("atom lookup unknown is not treated as true", () => {
  const v = evalPredicate({ op: "all", of: [{ op: "atom", key: "missing" }, { op: "atom", key: "present" }] }, ({ key }) =>
    key === "present" ? "true" : "unknown",
  );
  assert.equal(v, "unknown");
  assert.equal(unknownNeverAdmits(v), false);
});
