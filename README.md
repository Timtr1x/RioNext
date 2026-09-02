# RioNext

Pi-backed persistent Decide/Execute harness. Campaign state lives in SQLite and content-addressed artifacts, not in a Pi session.

P0 is the synthetic lab loop. P1 adds control commands and a capability-aware provider catalog (slots, probes, vision).

## Run

Node >= 22.19.0 (developed on 24.12.0).

```
npm install
npm test
node dist/src/cli/index.js run --spec profiles/demo-lab.json
```

`--data-dir` 默认 `.rionext`。槽位配好供应商之后，这条命令会创建战役（已存在就接着跑）并启动 Decide/Execute。`thinking_level` 默认 `high`。

## Providers

```
node dist/src/cli/index.js provider add --name "Anthropic" --protocol ANTHROPIC_MESSAGES --base-url https://api.anthropic.com --api-key $KEY --data-dir .rionext
node dist/src/cli/index.js provider model add --provider prv_... --name claude-sonnet-4-6 --context 256000 --max-output 51200 --data-dir .rionext
node dist/src/cli/index.js provider test --provider prv_... --model claude-sonnet-4-6 --data-dir .rionext
node dist/src/cli/index.js provider slots --solver mdl_... --visual mdl_... --reflect none --data-dir .rionext
node dist/src/cli/index.js provider ui --port 7780 --data-dir .rionext
```

Test connection returns auth / text / tools / vision. Vision sends a PNG that contains `RIO-VISION-PROBE-7F3A`. `analyze_visual` refuses models with `vision=false`. Empty slots fall back to 主求解, then the first available model.

Keys live in `.rionext/provider-secrets.json` and are not printed.

Pinned Pi packages: `docs/dependency-integrity.md`.
