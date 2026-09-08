# RioNext Execute 强制收卷机制开发规格 v1.0

> 目标读者：负责实现 RioNext 的编程 Agent  
> 基线：`main@e528284832f6d731bb4be51f6b04d9285a9bd326`（2026-09-04）  
> 范围：解决 Execute 已工作但未调用 `finish_step`，导致 `incomplete_protocol`、重复派发或执行槽低效占用的问题。  
> 核心原则：框架负责收卷和状态转换；模型只负责给出语义结果；运行停止不等于 Step 已解决。

## 1. 最终交付目标

实现完成后，每个 Execute run 必须满足以下五条保证：

1. 模型主动调用合法 `finish_step` 时，按提交结果结束。
2. 模型自然停止但未调用 `finish_step` 时，框架自动进入一次且仅一次 Finalize 修复回合。
3. 达到 Execute turn cap 或普通工具 cap 时，仍保留一次 Finalize 机会；`finish_step` 不受普通工具上限阻断。
4. 模型错误、连接中断、取消、过期租约或未知外部效果不得被自动判为 `resolved`。
5. Finalize 仍未形成合法提交时，保存已有 observation，但 Step 不得进入 `resolved`，run 以 `incomplete_protocol` 安全结束。

本功能不负责判断模型的探索策略是否优秀，也不解决“33 没成功却不试 34”一类搜索策略问题；它只保证每个 Execute 片段都有明确、可靠、可恢复的收尾结果。

## 2. 当前实现与直接缺口

当前代码已经具备：

- `PiWorker` 内部的 `finishRequested` 标记；
- `finish_step` 工具；
- `TaskOutcome` 和 `incomplete_protocol`；
- `task_runs.finish_requested`、`env_admission`；
- `markFinishRequested()` 对 fence 的检查；
- `finishRun()` 对 run 和 Step 的落库；
- 工具调用后的原始 observation 和 artifact 归档。

但当前实现仍有以下缺口：

### 2.1 目前只有提示词要求，没有自动补交

`68eab76` 只增强了 `prompts/execute.txt`、工具描述和提示词断言。`PiWorker` 在 `agent.waitForIdle()` 后如果 `finishRequested === false`，直接生成 `incomplete_protocol`，没有 Finalize 修复阶段。

### 2.2 普通工具 cap 会阻断 `finish_step`

`ToolGateway.admit()` 统计当前 run 的全部 tool invocation；达到 `maxToolCalls` 后，任何后续工具都会返回 `run_tool_cap`。因此第 N 个普通工具恰好达到 cap 后，第 N+1 个 `finish_step` 无法执行。

同时 `shouldStopAfterTurn()` 在 `toolSends >= toolCap` 时立即停止 Pi Loop，模型也不会获得下一轮交卷机会。

### 2.3 非法 reason 会被错误地降级为 resolved

`finish_step` 的 schema 使用 `Type.String()`；不在允许列表内的 reason 当前被默认转换成 `resolved`。这是危险的 fail-open 行为，必须改为 fail-closed。

### 2.4 语义结果和运行终止原因混在一起

当前 `TaskOutcomeReason` 同时包含：

- 语义状态：`resolved`、`deferred`、`blocked`；
- 运行原因：`cancelled`、`budget`、`context_limit`、`protocol_error`、`incomplete_protocol`。

模型不应该自行声称 `budget`、`context_limit`、`cancelled` 或 `protocol_error`；这些必须由框架判定。

### 2.5 finish 提交不是独立持久化事务

`markFinishRequested()` 只持久化布尔值，完整 outcome 暂存在 `PiWorker.outcome`，随后由 Engine 调用 `finishRun()`。如果进程在两者之间崩溃，数据库知道“请求过 finish”，却没有可靠的提交内容可恢复。

## 3. 设计结论

采用“两阶段 Execute”设计：

```text
PRIMARY_EXECUTE
  ├─ 合法 finish_step ───────────────→ COMMITTED
  ├─ 自然停止 / turn cap / tool cap ─→ FINALIZE_ONCE
  ├─ 预算或 deadline 已耗尽 ─────────→ FRAMEWORK_OUTCOME
  ├─ 取消 / stale fence ─────────────→ FRAMEWORK_OUTCOME
  └─ 模型错误 / 中断 ───────────────→ FRAMEWORK_OUTCOME

FINALIZE_ONCE
  ├─ 合法 finish_step ───────────────→ COMMITTED
  └─ 未交卷 / 非法提交 / 模型错误 ───→ INCOMPLETE_PROTOCOL
```

Finalize 是同一 TaskRun 内的第二个模型调用阶段，不创建新 Step，不重新开放环境工具，不允许循环补交。

## 4. 状态与责任边界

### 4.1 新增运行阶段

在 `PiWorker` 内新增仅存在于运行期的阶段：

```ts
type WorkerPhase = "primary" | "finalizing" | "settled";
```

以及 Primary 结束触发原因：

```ts
type PrimaryStopTrigger =
  | "finish_committed"
  | "natural_stop"
  | "turn_cap"
  | "tool_cap"
  | "budget_exhausted"
  | "deadline"
  | "cancelled"
  | "stale_fence"
  | "model_error"
  | "aborted"
  | "runtime_error";
```

不要从最终 `TaskOutcome.reason` 反推触发原因；在执行时显式记录。

### 4.2 模型能提交的语义状态

第一版只允许模型提交现有 Step 状态可以表达的三种结果：

```ts
type ModelStepDisposition = "resolved" | "deferred" | "blocked";
```

- `resolved`：当前 Step 的局部 completion criteria 已满足。
- `deferred`：当前片段有进展或暂时无进展，但应在以后继续。
- `blocked`：缺少明确外部条件，满足前不能继续。

`cancelled`、`budget`、`context_limit`、`protocol_error`、`incomplete_protocol` 只能由框架产生。

暂不新增 `failed`，避免扩大 Step 状态机变更。若以后要表达“此路径已被反证且永久失败”，单独设计 `retired` 的受控转换，不在本功能中顺带实现。

### 4.3 运行停止映射

| Primary 结果 | 是否进入 Finalize | 最终处理 |
|---|---:|---|
| 已合法提交 `finish_step` | 否 | 使用已提交结果 |
| 正常文本停止、未交卷 | 是 | Finalize 一次 |
| 达 turn cap | 是 | Finalize 一次 |
| 达普通工具 cap | 是 | Finalize 一次 |
| deadline 已到 | 否 | 框架生成 `budget` 或现有期限原因；不得 resolved |
| root budget 不足以再调用模型 | 否 | 框架生成 `budget` |
| 用户取消 | 否 | `cancelled` |
| stale fence / lease 被接管 | 否 | 中断并拒绝旧 worker 提交 |
| provider stopReason=error | 否 | `protocol_error`，保留具体错误 |
| provider stopReason=aborted | 否 | `cancelled` 或 `protocol_error`，按 abort 来源区分 |
| 进程异常 | 否 | `protocol_error`；启动恢复逻辑接管 |

## 5. `finish_step` 新契约

### 5.1 输入 schema

将当前自由字符串 schema 替换成枚举联合，不允许非法值默认成 `resolved`：

```ts
const FinishStepSchema = Type.Object({
  disposition: Type.Union([
    Type.Literal("resolved"),
    Type.Literal("deferred"),
    Type.Literal("blocked"),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 8000 }),
  evidence_refs: Type.Array(Type.String(), { maxItems: 128 }),
  blocked_on: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  reopen_condition: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  next_action: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
}, { additionalProperties: false });
```

兼容要求：如果现有 scripted tests 或外部调用仍发送 `reason`，在一个版本周期内可以显式兼容：

```ts
disposition = input.disposition ?? parseLegacyReason(input.reason)
```

但 `parseLegacyReason()` 只接受 `resolved|deferred|blocked`，其他值返回工具错误，绝不能默认 resolved。兼容分支应带弃用日志，并在后续版本删除。

### 5.2 结构校验

提交前至少检查：

- run 存在，campaign 和 run 匹配；
- run fence 与 lease fence 一致；
- run 状态仍为 `running`；
- `disposition=blocked` 时 `blocked_on` 必填；
- `disposition=deferred` 时 `reopen_condition` 或 `next_action` 至少一个非空；
- `disposition=resolved` 时 `evidence_refs` 至少一个，除非 Step 类型明确声明为无需证据；
- 每个 evidence ref 属于同一 campaign；
- evidence ref 必须指向 observation、fact、finding 或 artifact 中的现存实体；
- 引用未必必须由当前 run 产生，但必须在当前 ContextManifest 中可见，或由当前 run 新提交；
- 不允许引用只存在于模型文本、但数据库中不存在的 ID。

第一版只做结构和引用存在性校验，不用另一个 LLM 判断 summary 是否“真的证明了 completion criteria”。语义正确性继续由后续 Decide、验证 Step 和 completion predicate 保证。

### 5.3 幂等提交

新增 StorageService 原子接口：

```ts
submitRunOutcome({
  campaign_id,
  run_id,
  fence,
  submission_id,
  payload,
}): { accepted: boolean; duplicate: boolean; outcome: TaskOutcome }
```

事务语义：

1. fence 不一致：拒绝 `stale_fence`。
2. 未提交过：校验 payload，关闭 `env_admission`，持久化 payload，写事件。
3. 已提交且规范化 payload 完全相同：返回原结果，`duplicate=true`。
4. 已提交但 payload 不同：拒绝 `finish_conflict`，不覆盖第一次提交。

提交成功后，任何环境工具必须被拒绝；只读图查询也没有继续执行的必要，Pi Loop应终止。

## 6. 持久化与迁移

将 schema version 从 2 升到 3，在 `task_runs` 增加：

```sql
finish_submission_id TEXT;
finish_payload_json TEXT;
finish_submitted_at TEXT;
primary_stop_trigger TEXT;
finalize_attempted INTEGER NOT NULL DEFAULT 0;
```

迁移必须使用现有 `Store.addColumn()` 风格，满足：

- 新数据库的 `SCHEMA_SQL` 直接包含这些列；
- v2 数据库启动时幂等升级到 v3；
- 重复启动不会重复加列；
- v2 中正在运行但没有 payload 的 `finish_requested=1` run，不得推断 resolved，应在恢复时进入 `incomplete_protocol` 或人工核对路径。

新增事件类型：

```text
run.primary_stopped
run.finalization_started
run.finish_submitted
run.finalization_failed
```

事件 payload 至少包含 run_id、step_id、trigger、submission_id（如有）和错误分类；不要写入完整敏感工具输出。

## 7. PiWorker 实现方案

### 7.1 重构边界

在 `src/runtime/pi/factory.ts` 中将当前单段 `start()` 拆成私有方法，避免继续向一个大函数堆条件：

```ts
private async runPrimary(...): Promise<PrimaryPhaseResult>
private async runFinalizer(...): Promise<TaskOutcome | null>
private classifyPrimaryExit(...): PrimaryStopTrigger
private buildPrimaryTools(...): AgentTool[]
private buildFinalizerTools(...): AgentTool[]
private makeFrameworkOutcome(...): TaskOutcome
```

`start()` 只负责串联：

```ts
this.settled = (async () => {
  const primary = await this.runPrimary(...);

  if (this.outcome) return this.outcome;

  if (needsFinalizer(primary.trigger) && canAffordFinalizer(...)) {
    const repaired = await this.runFinalizer(...);
    if (repaired) return repaired;
  }

  return this.makeFrameworkOutcome(primary.trigger);
})();
```

### 7.2 Finalizer 使用独立 Agent 实例

不要尝试在 Primary Agent 上反复修改 tools、turn counter 和停止回调。创建第二个短生命周期 Pi `Agent`，原因是：

- 工具集合天然隔离；
- 不会继承 Primary 的 turn cap；
- 不会因为 Primary 的 follow-up queue 产生循环；
- 更容易测试“只调用一次模型”；
- Finalize transcript 可以被严格压缩，减少成本。

Finalizer 配置：

- 同一个 `RunLease`、同一个 `ModelGateway` 账本；
- 最多一次模型响应；
- `toolExecution: "sequential"`；
- 只注册 `finish_step`；
- `shouldStopAfterTurn` 永远返回 `true`；
- 若响应中没有合法 `finish_step`，返回 null；
- 若一个消息中出现多个 `finish_step`，只接受第一次合法提交，其余返回 duplicate 或 conflict；
- 不开放 `graph_query`、`artifact_read`、`checkpoint`、Kali、Playwright 或任何环境工具。

### 7.3 Finalize 上下文

新增 `prompts/finalize-execute.txt`，保持短且命令式：

```text
当前 Execute 片段已经停止，必须立即提交片段结果。
你只能调用 finish_step，不能继续探索。
根据给出的 Step、完成条件、已保存证据和停止原因选择 resolved、deferred 或 blocked。
没有足够证据时不得选择 resolved。
达到调用上限通常选择 deferred；缺少明确外部条件时选择 blocked。
只调用一次 finish_step，不输出解释文本。
```

Finalizer user payload 使用结构化对象，包含：

```ts
interface FinalizeContext {
  run_id: string;
  step_id: string;
  stop_trigger: "natural_stop" | "turn_cap" | "tool_cap";
  step: {
    question: string;
    completion_criteria: string;
    expected_observations: string[];
  };
  submitted: {
    observation_ids: string[];
    fact_ids: string[];
    finding_ids: string[];
    artifact_ids: string[];
  };
  last_checkpoint: null | { note: string; next: string | null };
  last_assistant_text: string;
  last_tool_results: Array<{
    name: string;
    is_error: boolean;
    preview: string;
    artifact_id?: string;
  }>;
}
```

约束：

- `last_assistant_text` 最多 4,000 字符；
- 最多携带最后 8 个 tool result，每个 preview 最多 2,000 字符；
- 优先传 ID 和 artifact 引用，不复制完整扫描输出；
- 外部工具文本仍按不可信数据处理；
- Finalize 不读取尚未持久化的内存结果，所有证据必须先归档。

### 7.4 Primary 停止分类

当前 Pi StreamFn 的请求或运行失败可能编码在最终 AssistantMessage 的 `stopReason` 中而不抛异常，因此不能只依赖 `catch`。

实现 helper，从 `agent.state.messages` 或事件中取得最后一个 AssistantMessage：

- `stopReason=error` → `model_error`；
- `stopReason=aborted` → 根据 AbortController 来源区分 `cancelled` 与 `aborted`；
- `finishRequested=true` → `finish_committed`；
- `shouldStopAfterTurn` 已记录 turn cap → `turn_cap`；
- 已记录 tool cap → `tool_cap`；
- 正常无 tool call 结束 → `natural_stop`；
- 无法分类 → `runtime_error`，fail-closed。

不要把 `waitForIdle()` 成功 resolve 视为模型成功完成任务。

## 8. Gateway 修改

### 8.1 区分控制面工具

扩展 `ToolInvokeRequest`：

```ts
interface ToolInvokeRequest {
  // existing fields...
  controlPlane?: "terminal";
}
```

`finish_step` 和 `finish_decision` 标记为 `controlPlane: "terminal"`。

### 8.2 terminal 工具准入顺序

terminal 工具仍必须检查：

- campaign/run 一致；
- run fence；
- run 尚未完成，或属于相同幂等提交。

terminal 工具不应受以下限制：

- campaign 的业务工具 allowlist；
- 普通工具调用 cap；
- env admission 已关闭；
-普通工具预算计数。

原因：它不改变外部世界，只提交控制面状态。如果仍希望审计调用，创建 `kind=tool`、零外部效果、零业务费用的 invocation，或写专用 lifecycle event；但不要让审计记录再次消耗普通调用额度。

terminal 工具不得绕过 stale fence。旧 worker 即使晚到，也不能完成已被新代次接管的 run。

### 8.3 预留 Finalize 模型预算

推荐配置：

```ts
finalization: {
  enabled: true,
  max_attempts: 1,
  max_output_tokens: 512,
}
```

Primary 启动时不要把 root budget 全部用尽：

- 普通 tool cap 只计算业务工具；
- Execute model turn cap 不包含 Finalize 的一次模型调用；
- 如果 root budget 已不足以发送 Finalize，框架直接产生 `budget`，不透支；
- Finalize 模型调用正常进入 ModelGateway 和 InvocationBook，保证费用可追踪。

不建议偷偷免费调用模型，也不建议为了交卷突破 campaign deadline。

## 9. Engine 与 Storage 收尾

### 9.1 `finishRun()` 读取持久化提交

可靠版本中，Engine 不应只相信内存中的 `worker.outcome`。如果 `task_runs.finish_payload_json` 已存在：

- 读取并重新校验 run_id、step_id、fence；
- 使用已持久化结果完成 `finishRun()`；
- 内存 outcome 与持久化 outcome 不一致时，以持久化第一次提交为准并记录错误。

### 9.2 Step 状态转换

保持当前映射：

- `resolved` → Step `resolved`；
- `deferred` → Step `deferred`；
- `blocked` → Step `blocked`；
- `budget|context_limit|protocol_error|incomplete_protocol` → Step `deferred`；
- `cancelled` → Step `retired`。

但为避免 `incomplete_protocol` 立即热循环，增加以下一种机制，推荐 A：

**A. 推荐：交由 Decide 复核。** `incomplete_protocol` 后 Step 保持 `deferred`，写入专用 reopen condition；只有新的 Decide proposal、人工 hint、环境 revision 或退避到期后才能变 ready。

**B. 最小替代：指数退避。** 同一步连续 incomplete 时，设置 `not_before = now + min(2^n * base, max)`。这需要新增字段，不如 A 符合 FGS 设计。

不要在同一 controller cycle 中把它重新变 ready 并立即派发。

### 9.3 崩溃恢复

启动恢复扫描 running run 时：

- 有 `finish_payload_json`、fence 仍有效、Step 尚在 running/leased：幂等完成 `finishRun()`；
- `finish_requested=1` 但没有 payload：判 `incomplete_protocol`，不得 resolved；
- `finalize_attempted=1` 但没有提交：判 `incomplete_protocol`；
- 没有 finish 且存在 uncertain external invocation：进入现有 reconcile 路径；
- 没有 finish 且没有 uncertain effect：按 lease-expired 规则恢复，不自动成功。

## 10. 建议文件改动清单

| 文件 | 改动 |
|---|---|
| `src/runtime/pi/factory.ts` | 拆分 Primary/Finalize；严格 `finish_step` schema；停止分类；构建 FinalizeContext |
| `src/gateway/gateways.ts` | 增加 terminal control-plane 准入；从普通 cap/allowlist 中排除 finish |
| `src/domain/types.ts` | 增加 WorkerPhase、PrimaryStopTrigger、FinishStepInput 或放入新契约文件 |
| `src/storage/schema.ts` | task_runs 新列，schema v3 |
| `src/storage/db.ts` | v2→v3 幂等迁移 |
| `src/storage/service.ts` | `beginFinalization()`、`submitRunOutcome()`、恢复读取、幂等冲突处理 |
| `src/controller/engine.ts` | 使用持久化 outcome；恢复半提交 run；避免 incomplete 热循环 |
| `src/contracts/worker-runtime.ts` | 如需暴露阶段结果，补充稳定接口；不要暴露 Pi Agent 细节 |
| `prompts/finalize-execute.txt` | 新增专用收卷提示词 |
| `prompts/execute.txt` | 保留主动 finish 要求；说明框架会在停止时进入 Finalize，不鼓励依赖补交 |
| `tests/fault/protocol.test.ts` | 协议缺失、provider error、abort、幂等、崩溃窗口测试 |
| `tests/p1/core-guarantees.test.ts` | cap 后仍能 finish、非法 reason 不 resolved、Finalize 单次性 |
| `tests/storage/persist.test.ts` | schema v3、finish payload 持久化和重启恢复 |

若类型开始继续膨胀，新增 `src/contracts/finalization.ts`，不要把所有新类型继续塞进 `domain/types.ts`。

## 11. 测试矩阵

以下测试必须从真实入口调用 `Engine.runExecuteSlot()` 或 `Engine.runWorker()`，不能只测辅助函数。

### 11.1 正常路径

- **F01 主动交卷**：Primary 调用合法 `finish_step`；Finalizer 模型调用数为 0；Step 正确转换。
- **F02 自然停止补交**：Primary 只返回文本；Finalizer 调一次 `finish_step(resolved)`；run resolved。
- **F03 Finalize deferred**：Primary 达 cap；Finalizer 提交 deferred 和 next_action；Step deferred。
- **F04 Finalize blocked**：提交 blocked 且有 blocked_on；Step blocked。

### 11.2 强制边界

- **F05 tool cap 后可交卷**：普通工具恰好达到 cap；Finalizer 的 `finish_step` 仍被允许。
- **F06 turn cap 后可交卷**：Primary 达 turn cap；Finalize 获得独立一次模型调用。
- **F07 只开放终止工具**：Finalizer 尝试 `kali_run`；工具不存在或被拒绝，环境发送数不增加。
- **F08 只补交一次**：Finalizer 返回普通文本；不得启动第三次模型回合；最终 incomplete。
- **F09 多个 finish 调用**：同一消息两个相同提交幂等；不同提交产生 conflict；第一次胜出。

### 11.3 Fail-closed

- **F10 非法 disposition**：`"done"`、`"success"`、`"protocol_error"` 均不得转成 resolved。
- **F11 resolved 无证据**：需证据的 Step 提交空 refs；工具返回校验错误；最终不得 resolved。
- **F12 伪造 evidence ID**：引用不存在或其他 campaign 的 ID；拒绝。
- **F13 blocked 缺 blocked_on**：拒绝。
- **F14 deferred 缺重开/下一动作**：拒绝。

### 11.4 错误与取消

- **F15 provider error**：Primary stopReason=error；不启动 Finalizer；run protocol_error。
- **F16 provider aborted**：外部 cancel 导致 aborted；不启动 Finalizer；run cancelled。
- **F17 deadline**：deadline 已过；不发 Finalize 模型请求；不得 resolved。
- **F18 budget 不足**：Finalizer 预算不足；生成 budget；预算桶非负。
- **F19 stale fence**：旧 worker 的 finish 提交被拒；新 worker 状态不被覆盖。
- **F20 uncertain external effect**：不得通过 Finalize 把未知副作用直接 resolved；保持 reconcile 优先级。

### 11.5 持久化与恢复

- **F21 finish 提交后、finishRun 前崩溃**：重启后从 payload 幂等完成。
- **F22 只有 finish_requested 无 payload**：重启后 incomplete，不得 resolved。
- **F23 重复恢复**：连续启动两次不重复事件、不重复 Step revision。
- **F24 v2 迁移**：原数据库数据保持，schema version 变 3。
- **F25 payload 冲突**：相同 submission 重放安全，不同内容不能覆盖。

### 11.6 调度行为

- **F26 incomplete 不热循环**：同一 controller cycle 内不立即再次派发同 Step。
- **F27 observation 保留**：incomplete 后自动归档 observation/artifact 仍可被下一次 Decide 读取。
- **F28 不算实质完成**：incomplete 不触发 Coverage tested、Finding confirmed 或 Step resolved。

## 12. 可观测性与指标

新增以下结构化指标或可从事件计算的统计：

- `execute_runs_total`
- `finish_primary_total`
- `finalizer_started_total`
- `finalizer_committed_total`
- `finalizer_failed_total`
- `incomplete_protocol_total`
- `finish_conflict_total`
- `finish_validation_error_total`
- `finalizer_model_tokens_total`
- `finalizer_cost_total`

关键派生指标：

```text
主动交卷率 = finish_primary_total / execute_runs_total
补交成功率 = finalizer_committed_total / finalizer_started_total
最终协议完整率 = (finish_primary_total + finalizer_committed_total) / execute_runs_total
Finalize 额外成本占比 = finalizer_cost / execute_total_cost
```

上线目标建议：

- 最终协议完整率 ≥ 99%；
- Finalizer 最多一次，循环率必须为 0；
- 非法提交导致 resolved 的次数必须为 0；
- cancel/error/deadline 被 resolved 的次数必须为 0；
- 补交额外 token 成本可测，初始目标低于 Execute 总 token 的 5%。

## 13. 提交拆分顺序

编程 Agent 应按以下独立提交实施，每个提交都必须编译和运行对应测试：

### Commit 1：收紧现有 finish 契约

- `Type.String` 改为枚举；
- 删除未知 reason → resolved；
- 增加结构校验测试；
- 暂不改变运行流程。

### Commit 2：terminal 控制面准入

- finish 从普通 tool cap 和业务 allowlist 中排除；
- 保留 fence 和幂等限制；
- 增加 tool cap 边界测试。

### Commit 3：Primary 停止原因分类

- 显式记录 natural/turn cap/tool cap/error/abort；
- 测试 Pi 将 error 编码进 AssistantMessage 而不抛异常的情况；
- 此提交仍可保持原 incomplete 行为。

### Commit 4：一次性 Finalizer

- 新 prompt；
- 独立 Pi Agent；
- FinalizeContext；
- 只开放 finish；
- 没提交即 incomplete；
- 覆盖 F01–F20 中无需 DB v3 的部分。

### Commit 5：持久化提交与 schema v3

- `submitRunOutcome()`；
- 幂等和冲突；
- payload 与事件；
- v2→v3 migration；
- 覆盖 F21–F25。

### Commit 6：恢复与防热循环

- 重启恢复 finish payload；
- incomplete 交给 Decide/唤醒条件；
- 确认 observation 保留但不触发完成副作用；
- 覆盖 F26–F28。

### Commit 7：指标与文档

- CLI/日志显示主动交卷率、补交率、最终完整率；
- 更新 `docs/ops.md`；
- 记录开关和回滚方法。

不要把所有改动压在一个提交里。Commit 1–4 构成最小可用版本；Commit 5–7 构成可靠版本。

## 14. 配置与灰度

在 RuntimeConfig 增加：

```ts
finalization: {
  enabled: boolean;          // 初始默认 false，测试稳定后改 true
  max_attempts: 1;           // 当前版本只允许 1，拒绝其他值
  max_output_tokens: 512;
  transcript_tail_chars: 4000;
  tool_result_tail_count: 8;
}
```

灰度顺序：

1. 本地 scripted provider 跑完整测试。
2. 真实 provider 只开日志模式：计算“本应进入 Finalize”的次数，但不真正发请求。
3. 对单个测试 Campaign 开启。
4. 对真实 benchmark 开启，比较交卷率、额外成本、Step 重派次数。
5. 稳定后默认开启；保留紧急关闭开关一个版本周期。

关闭功能时必须回退到当前 fail-closed 行为：未 finish → `incomplete_protocol`，不能回退成自动 resolved。

## 15. 编程 Agent 执行约束

将以下要求原样交给编程 Agent：

1. 基于 `main@e528284` 或更新的 main 开新分支；若更新后相关文件变化，先报告冲突，不要机械套方案。
2. 不修改 Decide 架构、不新增多 Agent 编排、不引入新框架。
3. 不用提示词重复强调代替代码保证。
4. 不允许任何非法或缺失 finish payload 默认成 resolved。
5. Finalizer 不得调用环境工具，也不得超过一次模型响应。
6. `finish_step` 必须绕过普通 tool cap，但不能绕过 stale fence。
7. 所有 observation 和 artifact 在 Finalize 前必须已经落库。
8. 每完成一个 commit 运行 `npm test`；同时报告新增测试名称及结果。
9. 不删除或放宽现有测试来取得绿灯。
10. 最终提交一份实现对照表：本规格每条保证对应到代码位置和测试。

## 16. 完成定义（Definition of Done）

只有同时满足以下条件才算完成：

- [ ] Primary 主动 finish 不产生额外 Finalize 调用。
- [ ] 正常停笔、turn cap、普通 tool cap 都能进入一次 Finalize。
- [ ] error、abort、deadline、stale fence 不进入语义自动完成。
- [ ] Finalizer 工具集合严格只有 `finish_step`。
- [ ] Finalizer 最多一次模型响应。
- [ ] 非法 disposition 无法 resolved。
- [ ] 普通 tool cap 无法阻断 `finish_step`。
- [ ] finish 提交幂等且首次提交不可覆盖。
- [ ] finish payload 在进程崩溃后可恢复。
- [ ] incomplete observation 保留，但不触发 Step resolved、Coverage tested 或 Finding confirmed。
- [ ] incomplete Step 不在同一 controller cycle 热循环。
- [ ] schema v2 数据可幂等迁移到 v3。
- [ ] F01–F28 全部通过。
- [ ] 全量 `npm test` 通过，无删除、跳过或弱化原测试。
- [ ] CLI 或日志能计算主动交卷率、补交成功率和最终协议完整率。

## 17. 明确不接受的实现

以下做法即使测试暂时变绿也不接受：

- token 流一停就自动生成 `resolved`；
- idle 超时直接当成功；
- 未知 reason 默认 resolved；
- 每 N 个工具强迫模型假装完成；
- Finalizer 继续开放 Kali、Playwright 或 graph exploration；
- Finalizer 失败后无限再次 Finalize；
- 为了交卷绕过 stale fence 或未知外部效果核对；
- 丢弃未交卷 run 的 observation；
- 仅修改 prompt，不增加生命周期控制；
- 用 mock 辅助函数测试代替 Engine 入口的跨模块验收。

---

实现完成后的核心不变量应当是：

```text
Step.status == resolved
  ⇒ 存在唯一、合法、已持久化的 finish payload
  ∧ payload.disposition == resolved
  ∧ fence 在提交时有效
  ∧ evidence refs 通过结构校验

模型或运行停止
  ⇏ Step.status == resolved
```
