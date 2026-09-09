# RioNext

本地 Decide/Execute 控制器。Decide 串行规划，Execute 一次认领一个 step，Kali 工具跑在战役容器里。状态在 SQLite 和产物目录，不在模型会话里。

Node >= 22.19.0（开发用 24.12.0）。CLI 读的是 `dist/`。改 TypeScript 之后要 `npx tsc -p tsconfig.json`。

```
npm install
npx tsc -p tsconfig.json
npm test
```

Windows 用 `.\rionext.cmd`。Linux/macOS 用 `./rionext` 或 `npx rionext`。数据目录默认 `.rionext`（`--data-dir` 或 `RIONEXT_DATA`）。

完整操作（租约、锁、Finalize、Kali 镜像）见 [docs/ops.md](docs/ops.md)。命令本身用：

```
.\rionext.cmd ?
.\rionext.cmd ? provider
.\rionext.cmd ? kali
```

## 第一次

```
.\rionext.cmd health
.\rionext.cmd kali pull
.\rionext.cmd kali build
.\rionext.cmd kali protect
.\rionext.cmd kali smoke
```

战役容器从 `rionext-kali:master` clone。`cancel` 会 `docker rm` 克隆，不要 `docker rmi` master。

## 模型

密钥在 `.rionext/provider-secrets.json`，不进 git，CLI 也不会打印。`provider ui` 是可选本地页，和 CLI 同一套 catalog。

```
.\rionext.cmd provider add --name "DeepSeek Direct" --protocol OPENAI_CHAT_COMPLETIONS --base-url https://api.deepseek.com/v1/chat/completions --api-key sk-...
.\rionext.cmd provider model add --provider prv_... --name deepseek-chat --context 1000000 --max-output 51200
.\rionext.cmd provider test --provider prv_... --model deepseek-chat
.\rionext.cmd provider slots --solver mdl_...
.\rionext.cmd provider key --provider prv_... --api-key sk-新key
.\rionext.cmd provider list
.\rionext.cmd provider show prv_...
```

协议：`OPENAI_CHAT_COMPLETIONS`、`OPENAI_RESPONSES`、`ANTHROPIC_MESSAGES`。空槽回落到 solver。`run --url` 用 solver 槽。

## 开打

授权活靶，一条命令，不用写 spec：

```
.\rionext.cmd run --url http://authorized-target.example/
.\rionext.cmd http://authorized-target.example/
```

同一 URL 再跑会接着上次的战役 id。合成环境仍用文件：

```
.\rionext.cmd run --spec profiles/demo-lab.json
```

`--url` 和 `--spec` 不能一起用。命中 `flag_recovered` 会停在 `awaiting_verify`：

```
.\rionext.cmd list
.\rionext.cmd status
.\rionext.cmd accept
.\rionext.cmd reject --text "flag不正确" --continue
```

只有一个战役时可以省略 id。

## 战役 CLI

```
.\rionext.cmd start [id]
.\rionext.cmd pause|resume|cancel [id]
.\rionext.cmd hint [id] --text "不要用容器 php 当 unserialize 预言机"
.\rionext.cmd facts|steps|findings|events|operations|report [id]
.\rionext.cmd observations|invocations|coverage|goals|artifacts [id]
.\rionext.cmd revise-budget [id] --max-calls 3000 --max-tokens 30000000
.\rionext.cmd explain-step [id] --step step_...
```

`run` / `start` 常用开关：`--progress-ms 60000`（`0` 关掉进度）、`--max-execute-turns 72`、`--max-tool-calls 144`、`--no-finalization`。

默认：一段 Execute 72 轮模型、144 次工具；预算 3000 calls、30_000_000 tokens。Execute Finalize 默认开，Primary 没交 `finish_step` 时补交一次。

同一战役不要再开一个 `start`。正在跑的进程用的还是旧 `dist`。

Pinned Pi packages: [docs/dependency-integrity.md](docs/dependency-integrity.md).
