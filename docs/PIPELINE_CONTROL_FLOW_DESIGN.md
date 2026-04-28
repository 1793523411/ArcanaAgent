# Pipeline 控制流扩展 — 设计草稿

> 状态：**草稿，未实现**
> 前置：`GUILD_MODE_DESIGN.md` 附录 B「固定 Pipeline 模板」
> 作者：自动生成（`feat/self_work` 分支）
> 最后更新：2026-04-15

---

## 背景

现有 pipeline 只支持**静态 DAG**：步骤固定、依赖固定、全部被创建为 `open` 的 subtask，由 bidding/scheduler 按 `areDepsReady` 推进。这套模型能覆盖"抓页面→拆知识点→出图→组装"这类工作流，但以下三类需求做不到：

1. **条件分支**：不同输入走不同后续步骤（例：页面是 PDF 则走 OCR，否则走 HTML 解析）。
2. **循环/扇出**：对集合中每个元素重复一段子流程（例：对 N 个知识点各自出图+题目）。
3. **失败重试**：subtask 失败后按策略重试、降级、或进入人工审查，而不是简单让父节点 fail。

这份草稿列出取舍、最小可行方案、以及分阶段落地路径。

---

## 约束与非目标

- ✅ 必须向后兼容现有静态 DAG 模板，不改动 `expandPipeline` 的已知行为
- ✅ 依然"尽量少用 LLM"——控制流判定优先表达式，不是靠 Planner 再拆
- ❌ 不做通用工作流引擎（Airflow/Temporal），否则和现有 Guild Mode 的"平级竞标"理念冲突
- ❌ 不做 subtask 之间的消息总线/共享可变状态，避免引入复杂同步

---

## 设计要点

### 1. 静态 vs. 动态展开

现状：所有 subtask 在 `expandPipeline` 时**一次性创建**，DAG 形状在创建时就定死。

要支持分支/循环，就不能一次性展开所有节点。两条可行路径：

| 方案 | 说明 | 成本 | 适用 |
|------|------|------|------|
| **A. 懒展开** | 仅创建入口 subtask；每个 subtask 完成时评估后续 step 并按需创建 | 改 Scheduler + 在 taskBoard 引入"展开挂起"状态 | 所有场景 |
| **B. 预展开 + 跳过** | 创建时就展开全部 step，但给每个 step 加 `when` 表达式；Scheduler 跳过不满足条件的 | 改动最小，但循环无法实现（需要编译期知道 N） | 仅分支 |

**推荐方案 A**，配合小粒度的"动态节点"类型：

```ts
type StepKind = "task" | "branch" | "foreach" | "retry_wrapper";
```

入口 step 固定创建；`branch`/`foreach` 节点在上游完成时由 Scheduler 的 expansion step 执行（无 LLM），产生实际 task 节点。

### 2. 条件表达式

为了可判定且无需 LLM，引入一个**极简表达式语言**而非嵌入 JavaScript：

```json
{
  "title": "OCR 分支",
  "kind": "branch",
  "when": { "eq": ["${format}", "pdf"] },
  "then": [
    { "title": "PDF OCR", "description": "..." }
  ],
  "else": [
    { "title": "HTML 解析", "description": "..." }
  ]
}
```

运算符从小集合开始：`eq`、`neq`、`in`、`exists`、`gt/lt`、`and`、`or`、`not`。操作数是字面量或 `${var}` / `${stepId.output.path}`。

**好处**：可序列化、可校验、可在 UI 里画条件。**代价**：表达能力有限——但恰好和"固定流水线"的定位对齐，需要复杂判断的请回退到 Planner。

### 3. 循环（foreach）

模板里最常见的需求是「对 N 个元素各跑一段子流程」。方案：

```json
{
  "title": "逐知识点出图",
  "kind": "foreach",
  "items": "${step_1.output.knowledge_points}",
  "as": "kp",
  "body": [
    { "title": "为 ${kp.title} 出图", "description": "...", "dependsOn": [] },
    { "title": "为 ${kp.title} 打标", "description": "...", "dependsOn": [0] }
  ],
  "join": "merge_images"
}
```

Scheduler 在上游 step 产出 `items` 数组后，为每个元素克隆一份 `body`（替换 `${kp.*}`）生成并行子图；`join` 指定一个汇聚步骤等所有扇出完成。

**开放问题**：
- 如何从上一个 subtask 的 TaskResult 里取出数组？需要约定「结构化输出」，目前 TaskResult 只有 `summary`/`artifacts`。
- 并发上限：默认无限并发还是按 group 的 `maxConcurrentTasks` 限流？建议默认不限，依赖现有 bidding 的 load decay 天然排队。

### 4. 失败重试策略

目前 `failTask` 直接把 subtask 打成失败，`rollupParentRequirement` 把父节点也带 fail。扩展目标：声明式重试 + 降级。

```json
{
  "title": "抓取页面",
  "description": "...",
  "retry": {
    "max": 3,
    "backoffMs": 2000,
    "onExhausted": "fallback",
    "fallback": { "title": "人工抓取", "suggestedAgentId": "human-op" }
  }
}
```

- `max` — 最多重试次数
- `backoffMs` — 重试前延迟（简单指数或固定）
- `onExhausted` — `fail` / `fallback` / `skip`
- `fallback` — 作为兜底的 step 定义（复用普通 step schema）

与 bidding 的 `_rejectedBy` 协作：重试时**清空 `_rejectedBy`**，避免无人接单；或者让同一 agent 直接重跑（加 `preferSameAgent: true`）。

### 5. Workspace 可观测性

控制流一旦不静态，workspace.plan 的表格就不能在创建时就画完了。改成**随展开逐步追加**：

- 分支：展开后把未选中的那支标记 `skipped` 并给出原因
- 循环：每次迭代作为 plan 的子段落，显示进度 `3/8`
- 重试：在 decision log 里追加 `retry 1/3 failed: ${reason}`

---

## 数据模型变更

```ts
// types.ts 新增
export type StepKind = "task" | "branch" | "foreach";

export interface RetryPolicy {
  max: number;
  backoffMs?: number;
  onExhausted?: "fail" | "fallback" | "skip";
  fallback?: PipelineStepSpec;
  preferSameAgent?: boolean;
}

export interface PipelineStepSpec {
  // 原有
  title: string;
  description: string;
  suggestedSkills?: string[];
  suggestedAgentId?: string;
  dependsOn?: number[];
  priority?: TaskPriority;
  acceptanceCriteria?: string;
  // 新增
  kind?: StepKind;                 // default "task"
  when?: Expression;               // 仅对 kind=task/branch 有意义
  then?: PipelineStepSpec[];       // 仅 branch
  else?: PipelineStepSpec[];       // 仅 branch
  items?: string;                  // 仅 foreach — 变量表达式
  as?: string;                     // 仅 foreach — 迭代变量名
  body?: PipelineStepSpec[];       // 仅 foreach
  join?: string | null;            // 仅 foreach
  retry?: RetryPolicy;
}

// GuildTask 新增（subtask 上）
export interface GuildTask {
  // ...
  stepKind?: StepKind;             // 该 subtask 在模板里的 step kind
  iterationKey?: string;           // foreach 下的迭代标识（例 "kp-3"）
  retryCount?: number;             // 已重试次数
  skippedReason?: string;          // 被分支跳过时的原因
}
```

`PipelineTemplate.steps` 仍是数组，但元素可以是任一 `StepKind`，通过递归展开形成实际 DAG。

---

## 执行模型变更

1. **expandPipeline** 只展开**顶层的 task-kind step** + 占位 branch/foreach 节点（`status: "blocked"`，`stepKind` 标记）。
2. **Scheduler** 在检测到某个 task 完成、且其下游是 branch/foreach 节点时，调用新的 `advancePipeline(parentId, completedStepIdx)`：
   - `branch` — 求 `when` 表达式，展开命中分支的 step，未命中的 step 以 `skippedReason` 写 decision
   - `foreach` — 从上游 `TaskResult.structuredOutput` 读出数组，按元素克隆 body，可选 join 节点
   - `task` 带 `retry` — 失败时：`retryCount++`，清空 `_rejectedBy`，`status = "open"`；耗尽后按 `onExhausted` 走
3. **rollupParentRequirement** 继续工作：所有实际 subtask 终态 → 父终态。skipped 算 completed。

### TaskResult 结构化输出

新增 `TaskResult.structuredOutput?: Record<string, unknown>`（可选）。Agent 在 `executor` 里可以通过一个新的工具调用（例如 `emit_output`）填入。不改现有语义：分支/循环如果依赖此字段而 agent 没填，就按"展开失败"降级（entry 写 decision，父节点 fail）。

---

## 分阶段落地

| 阶段 | 范围 | 工作量 | 依赖 |
|------|------|--------|------|
| **P1 重试** | 仅 `RetryPolicy`，不动展开模型 | 小（~1 天） | 无 |
| **P2 分支** | `kind=branch`、`when` 表达式、懒展开雏形 | 中（~3 天） | 表达式 eval + advancePipeline 最小实现 |
| **P3 结构化输出** | `structuredOutput` + `emit_output` 工具 | 小 | 和 P2 解耦 |
| **P4 foreach** | 循环展开、join 节点、并发控制 | 大（~5 天） | P2 + P3 |
| **P5 编辑器 UI** | 在现有 `PipelineEditorModal` 加 kind 选择、`when` 可视化、子步骤嵌套 | 中 | P2/P4 完成后再做 |

建议按 P1 → P3 → P2 → P4 → P5 的顺序：先拿到小而确定的收益（重试），再搭结构化输出骨架，最后啃分支/循环这块硬骨头。

---

## 风险与未解决问题

- **表达式语言蔓延**：一旦开始支持 `gt`/`lt`，下一步就是字符串函数、正则、数学运算。必须给自己定死"不做通用 DSL"，复杂判断走 Planner。
- **结构化输出不可靠**：agent 不一定按模板填对 schema。需要在 `advancePipeline` 里做防御性解析 + 明确错误消息。
- **循环与竞标的交互**：100 个 foreach 迭代同时 open，会不会压垮 bidding？建议给 foreach 加 `maxParallel` 字段作为安全阀。
- **中断与取消**：用户删除 pipeline 父任务时，已展开的子任务和未展开的占位节点都要清理；现有 `removeTask` 是单任务粒度，需要扩展。
- **观测**：控制流逻辑在 Scheduler，但执行日志现在挂在 agentExecutor 上。需要一个 "pipeline decision log" 面板显示 branch/foreach/retry 决策流水。

---

## 暂不做

- 显式的人工审批节点（`kind: "approval"`）— 用 retry 的 `fallback: { suggestedAgentId: "human-op" }` 足够。
- 定时调度 / cron — 和现有 Scheduler 冲突，交给外层 cron → 调 `/from-pipeline`。
- 模板组合（pipeline 调 pipeline） — 先把单层跑顺。
