#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeRuntimeConfig } from "../contracts/config.ts";
import { Engine } from "../controller/engine.ts";
import { DomainError } from "../domain/errors.ts";
import { runReactBaseline } from "../eval/baseline-react.ts";
import { handleProviderCommand } from "./providers.ts";

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json") flags.json = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    }
  }
  return { cmd: cmd ?? "help", flags };
}

function dataDir(flags: Record<string, string | boolean>): string {
  if (typeof flags["data-dir"] === "string") return resolve(flags["data-dir"]);
  if (process.env.RIONEXT_DATA) return resolve(process.env.RIONEXT_DATA);
  return resolve(process.cwd(), ".rionext");
}

function print(obj: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v && typeof v === "object") console.log(`${k}: ${JSON.stringify(v)}`);
      else console.log(`${k}: ${v}`);
    }
    return;
  }
  console.log(String(obj));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "campaign") argv.shift();
  const { cmd, flags } = parseArgs(argv);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`rionext campaign create --spec <file>
rionext campaign start|pause|resume|cancel --id <id>
rionext campaign hint --id <id> --text <hint>
rionext campaign revise-budget --id <id> --max-calls N
rionext campaign revise-scope --id <id> --scope-version V
rionext campaign explain-step --id <id> --step <step_id>
rionext campaign status|events|steps|facts|findings|report --id <id> [--json]
rionext provider add --name N --protocol ANTHROPIC_MESSAGES|OPENAI_CHAT_COMPLETIONS|OPENAI_RESPONSES --base-url URL --api-key KEY
rionext provider model add --provider ID --name MODEL [--context 256000] [--max-output 16384] [--vision]
rionext provider test --provider ID --model ID_OR_NAME
rionext provider slots --solver ID --visual ID --reflect none
rionext provider ui [--port 7780]
rionext baseline --spec <file>`);
    return;
  }
  const dir = dataDir(flags);
  if (cmd === "provider" || cmd === "providers") {
    try {
      const result = await handleProviderCommand(process.argv.slice(3), flags, dir);
      print(result, true);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }
  const engine = new Engine(makeRuntimeConfig(dir));
  try {
    if (cmd === "create") {
      const specPath = flags.spec;
      if (typeof specPath !== "string") throw new Error("--spec is required");
      const spec = JSON.parse(readFileSync(resolve(specPath), "utf8")) as unknown;
      const rec = engine.createCampaign(spec);
      print({ created: rec.id, state: rec.state, started: false }, Boolean(flags.json));
      return;
    }
    const id = typeof flags.id === "string" ? flags.id : "";
    if (cmd === "baseline") {
      const specPath = flags.spec;
      if (typeof specPath !== "string") throw new Error("--spec is required");
      const spec = JSON.parse(readFileSync(resolve(specPath), "utf8")) as unknown;
      const result = await runReactBaseline(spec, dir);
      print(result, true);
      return;
    }
    if (!id && cmd !== "create") throw new Error("--id is required");
    switch (cmd) {
      case "start":
        await engine.start(id);
        print(engine.status(id), Boolean(flags.json));
        break;
      case "status":
        print(engine.status(id), Boolean(flags.json));
        break;
      case "events":
        print({ events: engine.storage.list("events", id) }, Boolean(flags.json));
        break;
      case "steps":
        print({ steps: engine.storage.list("steps", id) }, Boolean(flags.json));
        break;
      case "facts":
        print({ facts: engine.storage.list("facts", id) }, Boolean(flags.json));
        break;
      case "findings":
        print({ findings: engine.storage.list("findings", id) }, Boolean(flags.json));
        break;
      case "report": {
        const existing = engine.storage.latestReport(id);
        const report = existing ?? engine.writeReport(id, engine.storage.getCampaign(id).state);
        print(report, Boolean(flags.json) || true);
        break;
      }
      case "cancel":
        print({ cancel_epoch: engine.cancel(id), state: "cancelled" }, Boolean(flags.json));
        break;
      case "pause":
        engine.pause(id);
        print({ state: "paused", epoch: engine.storage.getCampaign(id).epoch }, Boolean(flags.json));
        break;
      case "resume":
        engine.resume(id);
        print({ state: engine.storage.getCampaign(id).state, epoch: engine.storage.getCampaign(id).epoch }, Boolean(flags.json));
        break;
      case "hint":
        print({ epoch: engine.hint(id, String(flags.text ?? "")), command: "hint" }, Boolean(flags.json));
        break;
      case "revise-budget":
        print({
          epoch: engine.reviseBudget(id, {
            max_calls: flags["max-calls"] ? Number(flags["max-calls"]) : undefined,
            max_tokens: flags["max-tokens"] ? Number(flags["max-tokens"]) : undefined,
            max_cost_micro: flags["max-cost-micro"] ? Number(flags["max-cost-micro"]) : undefined,
          }),
          command: "revise_budget",
        }, Boolean(flags.json));
        break;
      case "revise-scope":
        print({ epoch: engine.reviseScope(id, String(flags["scope-version"] ?? "")), command: "revise_scope" }, Boolean(flags.json));
        break;
      case "explain-step":
        print(engine.explainStep(id, String(flags.step ?? "")), Boolean(flags.json) || true);
        break;
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  } catch (err) {
    if (err instanceof DomainError) {
      console.error(`${err.code}: ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  } finally {
    engine.close();
  }
}

await main();
