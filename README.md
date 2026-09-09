# RioNext

Pi-backed persistent Decide/Execute harness. Campaign state lives in SQLite and content-addressed artifacts, not in a Pi session.

P0 is the synthetic lab loop. P1 adds control commands and a capability-aware provider catalog (slots, probes, vision).

操作步骤（Kali、provider、战役 spec、人审 flag、租约与锁）见 [docs/ops.md](docs/ops.md)。

## Run

Node >= 22.19.0 (developed on 24.12.0).

```
npm install
npm test
npx rionext run --spec profiles/demo-lab.json
npx rionext run --url http://authorized-target.example/
```

Windows 也可以用仓库里的 `.\rionext`。`--data-dir` 默认 `.rionext`。只有一个战役时可以省略 id。

```
npx rionext list
npx rionext status
npx rionext accept
npx rionext reject --text "flag不正确" --continue
```

`run --url` 用 solver 槽生成 Kali 找 flag 战役，不用手写 spec。`run --spec` 仍可用文件。已存在同 id 就接着跑。命中根目标的 flag 会停在 `awaiting_verify`，人审 `accept` 才算完成。

## Providers

```
npx rionext provider add --name "Anthropic" --protocol ANTHROPIC_MESSAGES --base-url https://api.anthropic.com --api-key $KEY
npx rionext provider model add --provider prv_... --name claude-sonnet-4-6 --context 256000 --max-output 51200
npx rionext provider test --provider prv_... --model claude-sonnet-4-6
npx rionext provider slots --solver mdl_... --visual mdl_... --reflect none
npx rionext provider key --provider prv_... --api-key $NEW_KEY
npx rionext provider show prv_...
```

`provider ui --port 7780` is an optional local page on the same catalog. CLI can add, rotate keys, list, test, and assign slots without it.

Test connection returns auth / text / tools / vision. Vision sends a PNG that contains `RIO-VISION-PROBE-7F3A`. `analyze_visual` refuses models with `vision=false`. Empty slots fall back to 主求解, then the first available model.

Keys live in `.rionext/provider-secrets.json` and are not printed.

Pinned Pi packages: `docs/dependency-integrity.md`.
