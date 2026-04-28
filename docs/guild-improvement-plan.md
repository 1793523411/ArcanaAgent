# Guild 模式改进方案与规划

> 面向 `server/src/guild/*` 与前端 `rule-editor/src/components/guild/*` 的阶段性改进计划。
> 配套阅读：`GUILD_MODE_DESIGN.md`、`GUILD_BIDDING_LOGIC.md`、`GUILD_COLLABORATION_REDESIGN.md`、`PIPELINE_CONTROL_FLOW_DESIGN.md`、`guild-pipeline-agent-guide.md`。

---

## 0. 先动这一个（Quick Win）

### 问题
Pipeline 中每个下游 agent 的 `systemPrompt` 都要手写"从上游 Handoff 读取 artifacts"的规则（见 `docs/guild-pipeline-agent-guide.md` 六个 agent 完全重复的"文件读写规则"段落）。一旦调整 handoff 结构，所有模板必须同步改动，且 agent 经常忘记读取上游输出。

### 方案
在 `server/src/guild/agentExecutor.ts` 的 `buildGuildAgentPrompt` 里，根据当前 `task.dependsOn` 自动从 `workspace` 与上游 `TaskHandoff` 汇总 `## Upstream Inputs` 段落，列出：
- 上游任务 id / 标题 / agent
- `handoff.summary`
- `handoff.artifacts`（带路径与可选摘要）
- `handoff.openQuestions`

Agent 的 systemPrompt 不再重复"上游文件约定"，改为统一由框架注入。

### 规划
- **优先级**：P0（一周内）
- **收益**：删除模板 30–50% 重复文本，上游变更只改框架。
- **依赖**：无，独立于 handoff schema 改造。
- **落点**：`buildGuildAgentPrompt`，新增单测覆盖"含/不含 dependsOn"两种路径。

---

## 1. Handoff 合同脆弱

### 问题
- 解析仅 `extractHandoffSection` + `JSON.parse`，无 schema 校验、无字段 coerce、无自动修复循环。
- "从上游读 handoff"写在每个 agent 的 systemPrompt 文本里（见 pipeline 指南），一致性靠人工维护。
- Agent 输出 handoff 失败时只打 warn，下游无法感知；`detectRejection` 基于正则，容易把正常描述误判为拒绝。
- `handoff.artifacts.path` 未强制落在 `workspaceRoot` 之下，存在越权写盘风险。

### 方案
1. 引入 `zod`/`ajv` 强约束 `HandoffPayload`（summary/artifacts/memories/inputsConsumed/openQuestions），解析失败时自动发起一次"让 agent 按错误提示重写 JSON"的修复轮次（max 1 次）。
2. 把 handoff/上游读取规则从 agent systemPrompt 抽到统一注入段（见第 0 节），移除各模板里的重复描述。
3. 解析失败事件以 `scheduler.emit('handoff_parse_failed', ...)` 广播，UI 任务卡展示原始块、错误信息与"重试解析"按钮。
4. `artifacts.path` 规范化 + `path.relative(workspaceRoot, path).startsWith('..')` 拒绝越界。
5. `detectRejection` 由正则升级为"显式 handoff.status:'reject' 字段" + 回退正则，减少误报。

### 规划
- **优先级**：P0（2 周）
- **收益**：失败可观测、下游可信、pipeline 维护量下降。
- **依赖**：Quick Win 先落地，以便把 schema 描述集中注入 prompt。

---

## 2. 竞标打分维度耦合 / 权重硬编码

### 问题
- `ScoreBreakdown` 的 `asset` 与 `assetBonus`、`ownerBonus` 与 `asset` 有语义重叠，调参时很难独立观测。
- 权重 0.55/0.30/0.15、0.35/0.30/0.20/0.15 写死在 `bidding.ts` 的 `calculateConfidenceBreakdown` 分支，改动需要发版。
- `loadPenalty = max(0, tasksDone - 10) * 0.02` 以累计完成数近似"负载"，与实时并发无关；真正堆积的 agent 无法被压制。
- 三档 scorer（token / embedding / llm）在不同任务间切换，导致历史分数不可比。

### 方案
1. 将权重外化到 `GuildBiddingConfig`，按 guild 存储并在 UI 可调；保留默认值作为 fallback。
2. 合并 `assetBonus` → `asset` 内部加成，保留 `ownerBonus` 作为独立维度但文档化其语义（拥有权 vs 相关度）。
3. 负载指标改为"近 N 分钟内分派次数 + 当前 `running` 任务数"，源数据来自 `autonomousScheduler` 的 `runningGroups` 与 agent 任务历史时间戳。
4. 在 `ScoreBreakdown` 增加 `scorer: 'token' | 'embedding' | 'llm'` 字段，前端展示"用了哪一档"以便 debug。
5. 长期：给竞标打分做"A/B 开关"与"灰度回放"——把历史 task 用新权重重算，看排序是否更稳。

### 规划
- **优先级**：P1（2–3 周）
- **收益**：调参不发版、负载真实、打分可解释。
- **依赖**：前端竞标面板（第 7 节）。

---

## 3. Planner 韧性不足

### 问题
- `callPlanner` 两次 JSON-parse 失败即降级为 `adhoc`，丢失了"让模型看错误再修"的反思机会。
- 模型解析时忽略 `group.leadAgent.systemPrompt`，leadAgent 的定制人设无法影响拆解策略。
- 空 subtasks / 空标题 silent 地降级，不会向用户抛"这是不是需要补充信息"。
- 无 planner 调用日志结构化：当前只是 `console.log`，不方便 UI 回放。

### 方案
1. Planner 失败进入"修复轮次"：带 parser 错误与期望 schema 让模型改写（max 2 次，含初次共 3 次），仍失败才降级。
2. `callPlanner` 使用 `group.leadAgent.systemPrompt` 作为前缀（若存在），并在 prompt 头部标注"此为 planner 模式，请输出 JSON"。
3. 空 subtasks 或置信度低于阈值时，生成 `openQuestion` 类型的事件，UI 提醒"建议人工补充需求"。
4. 所有 planner 调用记录到 `guild/events` 流（requirement_id / attempt / prompt / raw_output / parsed），UI 侧可在需求卡展开"拆解过程"。

### 规划
- **优先级**：P1（2 周）
- **收益**：更少的 adhoc 降级、拆解透明可审计。
- **依赖**：事件流归一（配合第 7 节）。

---

## 4. 记忆召回 / 竞标打分口径不一致

### 问题
- `memoryManager.searchRelevant` 使用 token + CJK bigram + 字段加权。
- `bidding.ts` 则按 embedding / LLM 评估资产相关度。
- 同一段输入，两侧命中结果不一致，导致"高分中标但读不到相关记忆"的现象。

### 方案
1. 抽象 `RelevanceScorer` 接口：`scoreText(text, candidates, opts)`，token/embedding/llm 三档实现。
2. `searchRelevant` 与 `calculateConfidenceBreakdown` 共用同一个 scorer 实例；embedding 缓存命中时两侧直接复用。
3. 对每个候选记忆同时输出"召回分 + 竞标对齐分"，便于调试。
4. 当无 embedding provider 时，两侧都回退到 token 档，保持一致。

### 规划
- **优先级**：P2（3 周）
- **收益**：召回与竞标一致，减少"凭空得高分"。
- **依赖**：embedding/LLM scorer 模块（已存在），只需抽接口。

---

## 5. Pipeline 模板共享上下文缺失

### 问题
- `PipelineStepSpec.systemPrompt` 各自定义，关于"输出路径 / handoff 规则 / 命名约定"的文本在 6 个 agent 模板中几乎一字不差地重复。
- 无 `sharedPromptTail`/`sharedPromptHead` 字段，修订一处需要改 N 处。
- `expandPipeline` 把 plan/scope 写入 workspace，但没有输出 schema 校验；下游如果读错字段只能靠 agent 自觉。

### 方案
1. 在 `PipelineTemplate` 增加 `sharedPromptHead` / `sharedPromptTail` 字段；`expandPipeline` 拼装时按 `head + step.systemPrompt + tail` 组合。
2. 把"文件读写规则"、"handoff 格式"、"禁止事项"迁到 `sharedPromptTail`，所有 step 删除重复段。
3. 在 step 定义增加可选 `outputSchema`（JSON Schema），`agentExecutor` 解析 handoff.artifacts 后对指定 artifact 做 schema 校验，失败时一次性反馈给 agent 修复。
4. 把 plan/scope/decisions 的写入路径集中在一个 `PipelineContextWriter`，避免各处散写。

### 规划
- **优先级**：P1（与第 1/0 节同期做，2 周）
- **收益**：模板维护量显著下降、下游输出可验证。
- **依赖**：Quick Win 已把公共段拉出，`sharedPromptTail` 是自然延伸。

---

## 6. 原子写 / 统计竞态

### 问题
- `guildManager.ts` 多处 `writeFileSync(path, JSON.stringify(...))`，崩溃窗口内可能残留空文件或半写入。
- `agentExecutor.ts` 里 `stats.tasksCompleted++` 为"读→改→写"，并发任务完成时 lost-update 风险明显。
- 多 agent 跨组任务分配只靠 `biddingInFlight` 内存锁，进程重启后锁丢失。
- `production-readiness-roadmap.md` 的 P1-4 已经提到原子写，但 guild 模块尚未覆盖。

### 方案
1. 抽统一的 `atomicWriteJson(path, data)`（先写 `.tmp` 再 rename），替换所有 `writeFileSync` 热路径。
2. `agent.stats` 改为"增量事件 + 惰性聚合"：事件写 append-only log，读取时按需聚合；或用 `better-sqlite3` 的 UPSERT 替代文件读写（与 P3 存储迁移对齐）。
3. `biddingInFlight` 锁持久化到文件 + TTL；调度器启动时恢复。
4. 集中 audit：所有 JSON 写入走 `persistGuildEntity`，方便后续接 WAL。

### 规划
- **优先级**：P1（与 `production-readiness-roadmap.md` 合并推进）
- **收益**：崩溃恢复、并发正确性。
- **依赖**：是否迁 SQLite 的决策。

---

## 7. 观测 / UI 解释性弱

### 问题
- 前端竞标面板只展示"中标者 + 分数"，未展示"其他 agent 为什么没投标"（分数低 / retryAt / deps 未就绪 / 冷却）。
- handoff 解析失败在后端静默，UI 无任何红点提示。
- Planner 拆解过程、`scheduler_dispatch_stalled` 事件散落在日志中，UI 不聚合。
- Agent 疲劳度 / 负载 / 最近失败率无可视化，运营难以判断"需不需要换 agent"。

### 方案
1. 竞标面板增加"落选原因"列：`belowThreshold` / `cooldown` / `noMatchingAsset` / `deps_not_ready`。数据源在 `autoBid` 已经有，落盘到 `TaskBidSnapshot` 即可。
2. Handoff 解析失败事件落入 `guild_events`，UI 任务卡出现"⚠ 解析异常"徽标，点击查看原始块。
3. 新建 `/api/guild/events` SSE，统一推 planner/bidding/handoff/scheduler 四类事件；右侧抽屉聚合展示。
4. Agent 卡新增"最近 24h 分派 / 成功 / 失败 / 平均时长 / 当前队列"迷你指标。

### 规划
- **优先级**：P2（3–4 周）
- **收益**：真正"可运营"的 guild；定位问题从小时级降到分钟级。
- **依赖**：事件归一（第 3 节）+ 竞标快照字段扩展（第 2 节）。

---

## 路线图总览

| 阶段 | 目标 | 主要工作项 | 建议耗时 |
|------|------|------------|----------|
| Phase 0 | Quick Win | § 0 自动注入 Upstream Inputs | 3–5 天 |
| Phase 1 | 合同与模板基础 | § 1 handoff schema；§ 5 sharedPromptTail；§ 3 planner 反思 | 2 周 |
| Phase 2 | 打分与存储 | § 2 权重外化+负载真值；§ 6 原子写+统计修复 | 2–3 周 |
| Phase 3 | 召回口径统一 | § 4 RelevanceScorer 抽象 | 2–3 周 |
| Phase 4 | 观测与运营 | § 7 事件归一 / 竞标解释 / agent 指标 | 3–4 周 |

## 验收标准

- Phase 0：任一 pipeline 模板删除重复"文件读写规则"段后，下游仍能在 `systemPrompt` 里看到统一 Upstream Inputs。
- Phase 1：随机注入 handoff JSON 错误，系统能自动修复或显式标红，不再静默；planner 对故意错误的模型输出能在 3 轮内收敛。
- Phase 2：权重改动无需重启；并发触发 1k 任务完成，`stats.tasksCompleted` 不丢计数。
- Phase 3：召回列表与竞标打分对同一 agent 的资产排序保持单调一致（top-k 交集 ≥ 0.8）。
- Phase 4：UI 能回答"这次为什么分派给 A 而不是 B" + "最近一天谁在干活"两个问题。

## 非目标（明确不做）

- 不重写三层模型（Guild/Group/Agent）。
- 不替换 LangGraph / Express 基础框架。
- 不在本轮引入"经验传承 / 自进化"能力（见 `capability-expansion-roadmap.md` T4）。
