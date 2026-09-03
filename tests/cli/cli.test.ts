import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, resolveCampaignId } from "../../src/cli/args.ts";
import { formatList, formatStatus, formatVerify } from "../../src/cli/format.ts";

test("parseArgs treats accept/reject as commands and keeps positional id", () => {
  const a = parseArgs(["accept", "camp_x"]);
  assert.equal(a.cmd, "accept");
  assert.deepEqual(a.positional, ["camp_x"]);
  const r = parseArgs(["reject", "camp_x", "--text", "flag不正确", "--continue"]);
  assert.equal(r.cmd, "reject");
  assert.equal(r.flags.text, "flag不正确");
  assert.equal(r.flags.continue, true);
  const old = parseArgs(["campaign", "verify-goal", "--id", "camp_x", "--reject"]);
  assert.equal(old.cmd, "verify-goal");
  assert.equal(old.flags.id, "camp_x");
  assert.equal(old.flags.reject, true);
});

test("resolveCampaignId uses the only campaign or demands an id", () => {
  assert.equal(resolveCampaignId({}, [], [{ id: "only", state: "active" }]), "only");
  assert.equal(resolveCampaignId({}, ["camp_a"], [{ id: "camp_a", state: "active" }, { id: "camp_b", state: "paused" }]), "camp_a");
  assert.throws(() => resolveCampaignId({}, [], []), /no campaigns/);
  assert.throws(() => resolveCampaignId({}, [], [{ id: "a", state: "active" }, { id: "b", state: "active" }]), /multiple campaigns/);
});

test("formatStatus shows pending flag and accept/reject commands", () => {
  const text = formatStatus({
    campaign_id: "camp_x",
    state: "awaiting_verify",
    pending_goal_claim: { id: "f1", proposition: "CTF2{abc}", fact_key: "flag_recovered" },
    budget: { spent_calls: 40, total_calls: 120, free_calls: 80, spent_tokens: 12, total_tokens: 800000 },
    candidates_ready: 1,
  });
  assert.match(text, /awaiting_verify/);
  assert.match(text, /CTF2\{abc\}/);
  assert.match(text, /rionext accept camp_x/);
  assert.match(text, /rionext reject camp_x/);
});

test("formatList and formatVerify are operator text, not JSON", () => {
  const list = formatList([
    { id: "camp_a", state: "active", updated_at: "t", pending_goal_claim: null },
    {
      id: "camp_b",
      state: "awaiting_verify",
      updated_at: "t",
      pending_goal_claim: { id: "f", proposition: "CTF2{x}", fact_key: "flag_recovered" },
    },
  ]);
  assert.match(list, /camp_b/);
  assert.match(list, /pending CTF2\{x\}/);
  const acc = formatVerify({ state: "completed", proposition: "CTF2{x}" }, "camp_b", true);
  assert.match(acc, /accepted/);
  const rej = formatVerify({ state: "active", proposition: "CTF2{x}" }, "camp_b", false);
  assert.match(rej, /rejected/);
  assert.match(rej, /rionext start camp_b/);
});
