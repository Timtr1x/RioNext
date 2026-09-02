import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("domain does not import Pi", () => {
  const files = walk(join(process.cwd(), "src/domain"));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.equal(text.includes("@earendil-works/pi"), false, f);
  }
});

test("storage does not import Pi or call models", () => {
  const files = walk(join(process.cwd(), "src/storage"));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.equal(text.includes("@earendil-works/pi"), false, f);
    assert.equal(text.includes("streamFn"), false, f);
  }
});

test("runtime-pi does not decide campaign completion", () => {
  const files = walk(join(process.cwd(), "src/runtime"));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.equal(text.includes("evaluateCompletion"), false, f);
    assert.equal(text.includes("setCampaignState"), false, f);
  }
});
