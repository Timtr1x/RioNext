import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleProviderCommand } from "../../src/cli/providers.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "rn-prv-cli-"));
}

test("CLI can rotate a provider key without echoing it", async () => {
  const data = dir();
  const added = (await handleProviderCommand(
    ["add"],
    {
      name: "Direct",
      protocol: "OPENAI_CHAT_COMPLETIONS",
      "base-url": "https://api.deepseek.com/v1/chat/completions",
      "api-key": "sk-old-secret",
    },
    data,
  )) as { id: string; api_key_set: boolean };
  assert.equal(added.api_key_set, true);
  assert.equal(JSON.stringify(added).includes("sk-old-secret"), false);

  const rotated = (await handleProviderCommand(
    ["key"],
    { provider: added.id, "api-key": "sk-new-secret" },
    data,
  )) as { id: string; api_key_set: boolean };
  assert.equal(rotated.id, added.id);
  assert.equal(rotated.api_key_set, true);
  assert.equal(JSON.stringify(rotated).includes("sk-new-secret"), false);
  assert.equal(JSON.stringify(rotated).includes("sk-old-secret"), false);

  const cat = new ProviderCatalog(data);
  assert.equal(cat.apiKey(added.id), "sk-new-secret");
  const snap = JSON.stringify(cat.publicSnapshot());
  assert.equal(snap.includes("sk-new-secret"), false);
  assert.match(snap, /"api_key_set":true/);

  const shown = JSON.stringify(await handleProviderCommand(["show", added.id], {}, data));
  assert.equal(shown.includes("sk-new-secret"), false);
  assert.match(shown, /"api_key_set":true/);
});

test("CLI set updates name and key; rm deletes secrets", async () => {
  const data = dir();
  const added = (await handleProviderCommand(
    ["add"],
    {
      name: "OldName",
      protocol: "OPENAI_CHAT_COMPLETIONS",
      "base-url": "https://api.deepseek.com/v1/chat/completions",
      key: "sk-keep-moving",
    },
    data,
  )) as { id: string };
  await handleProviderCommand(["model", "add"], { provider: added.id, name: "deepseek-chat" }, data);
  const updated = (await handleProviderCommand(
    ["set"],
    { provider: added.id, name: "NewName", "api-key": "sk-rotated-again" },
    data,
  )) as { display_name: string; api_key_set: boolean };
  assert.equal(updated.display_name, "NewName");
  assert.equal(updated.api_key_set, true);
  assert.equal(JSON.stringify(updated).includes("sk-rotated-again"), false);

  const removed = (await handleProviderCommand(["rm"], { provider: added.id }, data)) as {
    removed: boolean;
    models_removed: number;
  };
  assert.equal(removed.removed, true);
  assert.equal(removed.models_removed, 1);
  const secrets = JSON.parse(readFileSync(join(data, "provider-secrets.json"), "utf8")) as { keys: Record<string, string> };
  assert.equal(secrets.keys[added.id], undefined);
});
