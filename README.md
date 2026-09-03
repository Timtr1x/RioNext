# RioNext

Pi-backed persistent Decide/Execute harness. Campaign state lives in SQLite and content-addressed artifacts, not in a Pi session.

P0 is the synthetic lab loop. P1 adds control commands and a capability-aware provider catalog (slots, probes, vision).

## Run

Node >= 22.19.0 (developed on 24.12.0).

```
npm install
npm test
npx rionext run --spec profiles/demo-lab.json
```

Windows 也可以用仓库里的 `.\rionext`。`--data-dir` 默认 `.rionext`。只有一个战役时可以省略 id。

```
npx rionext list
npx rionext status
npx rionext accept
npx rionext reject --text "flag不正确" --continue
```

`run --spec` 会创建战役（已存在就接着跑）并启动 Decide/Execute。命中根目标的 flag 会停在 `awaiting_verify`，人审 `accept` 才算完成。`thinking_level` 默认 `high`。

## Providers

```
npx rionext provider add --name "Anthropic" --protocol ANTHROPIC_MESSAGES --base-url https://api.anthropic.com --api-key $KEY
npx rionext provider model add --provider prv_... --name claude-sonnet-4-6 --context 256000 --max-output 51200
npx rionext provider test --provider prv_... --model claude-sonnet-4-6
npx rionext provider slots --solver mdl_... --visual mdl_... --reflect none
npx rionext provider ui --port 7780
```

Test connection returns auth / text / tools / vision. Vision sends a PNG that contains `RIO-VISION-PROBE-7F3A`. `analyze_visual` refuses models with `vision=false`. Empty slots fall back to 主求解, then the first available model.

Keys live in `.rionext/provider-secrets.json` and are not printed.

Pinned Pi packages: `docs/dependency-integrity.md`.
