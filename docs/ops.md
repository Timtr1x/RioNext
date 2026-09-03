# RioNext 操作指南

RioNext 是本地 Decide/Execute 控制器。Decide 串行规划，Execute 一次认领一个 step，Kali 工具跑在战役容器里。状态在 SQLite 和产物目录，不在模型会话里。改源码不会热加载正在跑的 Node 进程。同一战役不要开第二个 Engine。

默认数据目录是仓库下的 `.rionext/`（可用 `--data-dir` 或 `RIONEXT_DATA` 改）。密钥只放 `.rionext/provider-secrets.json`，不要提交。

Windows 用仓库里的 `.\rionext.cmd`。Linux/macOS 用 `./rionext` 或 `npx rionext`。下面命令以 Windows 为例。

需要 Node >= 22.19.0。先 `npm install`，再 `npx tsc -p tsconfig.json`，CLI 读的是 `dist/`。

## 一次健康检查

```
.\rionext.cmd health
.\rionext.cmd kali status
```

`health` 看 Docker 和 Kali master 镜像在不在。`kali status` 会打印 `rionext-kali:rolling` / `:master` 和 keeper 容器。

## Kali 镜像（只建一次）

战役容器从 master clone，取消战役时 `docker rm` 克隆，**不要** `docker rmi` master。镜像大约 12.9GB，坏了再重建。

第一次：

```
.\rionext.cmd kali pull
.\rionext.cmd kali build
.\rionext.cmd kali protect
.\rionext.cmd kali smoke
```

`protect` 钉住 keeper，防止 `docker system prune -a` 把 master 清掉。entrypoint 脚本改了不必重建镜像，host 会把 `docker/kali/entrypoint.sh` bind-mount 进克隆。

## 接入模型

密钥进本地 catalog，不进 git。

```
.\rionext.cmd provider add --name "OpenCode Go" --protocol OPENAI_CHAT_COMPLETIONS --base-url https://opencode.ai/zen/go/v1/chat/completions --api-key <KEY>
.\rionext.cmd provider model add --provider prv_... --name deepseek-v4-flash --context 1000000 --max-output 51200
.\rionext.cmd provider test --provider prv_... --model deepseek-v4-flash
.\rionext.cmd provider slots --solver mdl_...
```

`provider test` 测 auth / text / tools。`slots --solver` 指定主求解模型。空槽会回落到 solver。Web UI：`.\rionext.cmd provider ui --port 7780`。

战役 spec 里的 `model_policy.provider` 用 `prv_...` id，`model` 用模型名。`thinking_level` 默认 `high`。流式超时默认 600 秒。

## 战役 spec

合成环境示例：`profiles/demo-lab.json`（scripted，不打网）。Kali 实靶把 `execution_profile` 设成 `kali`，`scope.assets` 写主机名和入口 URL，`tool_allowlist` 带上 `kali_run` / `kali_write` / `playwright`。

最低要有：

- `campaign_id`，`schema_version: 1`
- `mode`: `goal_seeking` 或 `assessment`
- `root_goal.statement` 和 `success_predicate_ref`（找 flag 用 `flag_recovered`）
- `budget`：至少 `max_calls` / `max_tokens` / `max_cost_micro` 之一。省略键时默认 1000 calls、10_000_000 tokens
- `model_policy`、`scope.assets`、`tool_allowlist`

实靶资产必须能过出口白名单。主机名和 `http://host/` 都写上。容器 iptables 按解析出的 IP 放行。

## 开跑

```
.\rionext.cmd run --spec path\to\spec.json --progress-ms 60000
```

已存在同 id 就接着跑。`--progress-ms` 默认 5 分钟打一次预算和最近调用，`0` 关掉，`--json` 不打进度。`--max-cycles` 默认 1000（控制器循环，不是模型调用）。

只创建不跑：`.\rionext.cmd create --spec ...`。恢复：`.\rionext.cmd start <id>`。

同一 `campaign_id` 不要再开一个 `start`/`run`。控制器锁会拒绝，硬开第二个进程会抢库。

改完 TypeScript 必须重新 `npx tsc -p tsconfig.json` 再 `start`。正在跑的进程用的还是旧 `dist`。

## 人审 flag

`goal_seeking` 且 `success_predicate_ref` 不是合成 `sample_recovered` 时，模型交 `flag_recovered` 会停在 `awaiting_verify`，不会自己标完成。

```
.\rionext.cmd status <id>
.\rionext.cmd accept <id>
.\rionext.cmd reject <id> --text "这个 flag 不对，因为..." --continue
```

`accept` 才关战役。`reject` 把原因写进上下文。`--continue` 会立刻再 `start`。

## 过程中

```
.\rionext.cmd list
.\rionext.cmd status <id>
.\rionext.cmd steps <id>
.\rionext.cmd facts <id>
.\rionext.cmd findings <id>
.\rionext.cmd events <id>
.\rionext.cmd operations <id>
.\rionext.cmd report <id>
.\rionext.cmd hint <id> --text "不要再用容器 php 当 unserialize 预言机"
.\rionext.cmd pause <id>
.\rionext.cmd resume <id>
.\rionext.cmd cancel <id>
```

`cancel` 停战役容器（`docker rm` 克隆），不删 master。已经发出的包收不回来。

改预算：`.\rionext.cmd revise-budget <id> --max-calls 1000 --max-tokens 10000000`。

备份：`.\rionext.cmd backup --out path\to\dir`。

## 预算和租约

默认 1000 次调用、1000 万 tokens。模型发送和工具调用各算 1 次调用。Execute 租约 60 分钟。high thinking 单次流式最多约 600 秒，一个片段里多轮模型+Kali 要能在租约内结束。

kali_run 回模型的 stdout 预览 50000 字节。`truncated=true` 时用返回的 `artifact_id` 和 `next_offset` 调 `artifact_read`，直到 `truncated=false`。上下文包带最近 20 条 observation。更早的用 `graph_query entity=observations`（默认从最早开始，`offset` 翻页，`order=desc` 从最新开始）。

## Kali 工具习惯

白名单二进制。`bash`/`sh`/`python3` 可以 `-c` 或跑 `/workspace` 下的脚本。`curl` 参数里不能有 `&` `$` `;` 这类元字符。带 query string 的 URL 用 `bash -c 'curl ...'`，或先 `kali_write` 再跑脚本。

nmap/nuclei/katana 等扫描会立刻返回 `execution_id`，在容器里继续跑（最长 60 分钟）。不要轮询。保存后 `finish_step`。扫描占用 workspace 锁，结束前别指望并行 curl。

每个 Execute 片段必须 `finish_step`。只 `checkpoint` 不会交还槽位。

活靶 PHP 和容器 PHP 不是同一个。unserialize / 长度 / 正则以活靶 HTTP 为准。

## 常见卡死

- **另一个控制器占着锁。** 不要对同一 id 再 `start`。进程已经死了可以等租约过期，或清 `.rionext/rionext.sqlite` 里该战役的 `controller_locks`。
- **resource_locked。** 非法参数、出口拒绝、镜像缺失现在会放锁。后台扫描仍会占锁直到扫完。
- **源码改了战役没变。** 没重新编译，或没停掉旧进程。
- **DNS。** 网关用系统 `lookup`，失败再 `docker getent`。不要依赖 c-ares `resolve4`（Windows 上 VMware 校园 DNS 会 REFUSED）。

## 合成环境冒烟

不配密钥、不启 Kali 也可以：

```
npm test
.\rionext.cmd run --spec profiles\demo-lab.json
```

scripted 策略会走完实验室柜子。这只验证协议，不是实靶。
