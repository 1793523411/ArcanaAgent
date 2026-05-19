# Guild 协作模式重构方案（Lead + Specialists + Workspace）

> 状态：设计稿
> 最后更新：2026-04-12
> 关联文档：`docs/GUILD_MODE_DESIGN.md`（原始设计）、`docs/GUILD_BIDDING_LOGIC.md`（竞标算法评审）
> 对应代码：`server/src/guild/**`

## 一、问题陈述

现状的 Guild 模式本质是"**单 Agent 抢单 + 单打独斗**"：

1. **没有任务拆解**——任何复杂需求只会被一个 Agent 吃下，跨仓库/跨职能需求本质上无法完成。
2. **没有依赖编排**——`GuildTask` 有 `dependsOn` 字段但从未被 scheduler 使用。
3. **没有共享工作区**——Group 的 `sharedContext` 是静态字符串，Agent 之间没有可读写的"黑板"。
4. **没有队友感知**——Agent 的 systemPrompt 不包含小组成员名单和各自擅长领域，缺乏"把这个活交给同事"的动力。
5. **资产私有化**——`assets` 挂在 Agent 上而非 Group，多仓库需求无法映射为"团队资源池 + 负责人"。
6. **记忆体系单薄**——`AgentMemory` 只有 `experience|knowledge|preference` 三类，access 计数仅在内存中生效（不落盘）、没有向量化、无稳定 ID、无可查询的层级结构，时间久了会变成一堆散乱 markdown。

目标工作流："我建一个小组对应一个需求，小组成员围绕多个仓库协作，我只发一句话需求，他们自动拆解、分工、交接、完成。"

---

## 二、目标架构：Lead + Specialists + Living Workspace

### 2.1 概念模型

```
Guild
 └─ Group（= 一个需求/项目域）
     ├─ leadAgentId          ← 组长（规划者），可选；不设则用系统虚拟 Lead
     ├─ assets[]             ← 组级资源池（多仓库、文档、API spec）
     ├─ members[]            ← Specialist agents（研发）
     └─ workspaces/{parentTaskId}.md  ← 每个需求的"活黑板"

Task
 ├─ kind: "requirement"      ← 用户发布的顶层需求（进 Planner）
 │   └─ subtaskIds[]         ← Planner 拆出的子任务
 ├─ kind: "subtask"
 │   ├─ parentTaskId
 │   ├─ dependsOn[]          ← 被 scheduler 严格使用
 │   └─ handoff?             ← 完成时必须产出的交接物
 └─ kind: "adhoc"            ← 传统单条任务（不拆解，走老路径）
```

### 2.2 角色映射

| Guild | 真实团队 |
|---|---|
| Lead Agent | PM / Tech Lead |
| Specialist Agents | 研发工程师 |
| Workspace markdown | Confluence / 需求文档 |
| Handoff note | PR description / 交接邮件 |
| `dependsOn` | Jira 任务依赖 |
| Group assets | 团队仓库清单 & 文档中心 |
| Memory index | 个人笔记本 + 团队 wiki 引用 |

---

## 三、数据结构改动

### 3.1 `types.ts`

```ts
// ─── 新增/修改类型 ──────────────────────────────────────────

export type AssetScope = "agent" | "group";

export interface AgentAsset {
  id: string;
  type: AssetType;
  name: string;
  uri: string;
  description?: string;
  metadata?: Record<string, unknown>;
  addedAt: string;
  lastAccessedAt?: string;
  // 新增
  scope?: AssetScope;          // "group" → 组级资源，"agent" → 私有
  ownerAgentId?: string;       // 组级资产的主要负责人（optional）
  tags?: string[];             // 领域/技术栈标签，供 Planner 和 bidding 使用
}

export interface Group {
  id: string;
  name: string;
  description: string;
  guildId: string;
  agents: string[];
  leadAgentId?: string;        // 新增：组长
  assets?: AgentAsset[];       // 新增：组级资源池
  sharedContext?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type TaskKind = "requirement" | "subtask" | "adhoc";

export type TaskStatus =
  | "open" | "bidding" | "in_progress"
  | "completed" | "failed" | "cancelled"
  | "planning"     // 新增：Lead 正在拆解
  | "blocked";     // 新增：依赖未就绪

export interface TaskHandoff {
  fromAgentId: string;
  toSubtaskId?: string;        // 指向下游 subtask；可空表示交给 parent 聚合
  summary: string;             // 一句话：做了什么
  artifacts: Array<{           // 产出物：提交、文件、API 路径、URL
    kind: "commit" | "file" | "url" | "note";
    ref: string;
    description?: string;
  }>;
  inputsConsumed?: string[];   // 读取过的上游 handoff/artifact id
  openQuestions?: string[];    // 留给下游/Lead 的疑问
  createdAt: string;
}

export interface GuildTask {
  id: string;
  groupId: string;
  kind: TaskKind;              // 新增（默认 "adhoc" 兼容老数据）
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId?: string;
  bids?: TaskBid[];
  dependsOn?: string[];        // 已存在，现在开始被调度器使用
  blockedBy?: string[];
  result?: TaskResult;
  // 新增：协作字段
  parentTaskId?: string;       // subtask 指向 requirement
  subtaskIds?: string[];       // requirement 的子任务
  suggestedSkills?: string[];  // Planner 标注的期望技能/仓库标签
  suggestedAgentId?: string;   // Planner 的建议人选（不强制）
  acceptanceCriteria?: string; // 验收标准（Lead 拆解时写）
  workspaceRef?: string;       // 所属 workspace 文件路径
  handoff?: TaskHandoff;       // subtask 完成时写入
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
```

### 3.2 `BiddingConfig` 增补

```ts
export interface BiddingConfig {
  maxConcurrentTasks: number;
  loadDecayFactor: number;
  assetBonusWeight: number;
  taskTimeoutMs: number;
  minConfidenceThreshold: number;
  // 新增
  ownerBonusWeight: number;    // 资产 owner 直接匹配加成（默认 0.5）
  successRatePrior: number;    // 新 Agent 成功率先验（默认 0.5）
  skipParentRequirement: boolean; // requirement 类 task 不进 bidding（默认 true）
}
```

---

## 四、新增模块

### 4.1 `server/src/guild/workspace.ts`

**职责**：每个 `requirement` task 对应一个 `workspace.md`，所有参与者读写。

**落盘路径**：`data/guild/groups/{gid}/workspaces/{parentTaskId}.md`

**文档结构**（严格 schema，Planner 和 Specialist 都按段追加）：

```markdown
# <Requirement Title>

**Status**: planning | in_progress | done | blocked
**Lead**: <agentId>
**Created**: <iso>
**Last Updated**: <iso>

## Goal
<Lead writes the polished requirement>

## Scope
- Repos: <list from group.assets filtered by tags>
- Out of scope: <explicit exclusions>

## Plan
<Lead writes DAG as markdown table>

| ID | Title | Owner | Depends | Status | Acceptance |
|----|-------|-------|---------|--------|------------|

## Decisions Log
<Append-only: timestamp + author + decision>

## Handoffs
<Append-only: one section per completed subtask>

### [subtaskId] <fromAgent> → <toSubtaskIdOrDone>
- Summary: ...
- Artifacts:
  - commit: <sha> (<repo>)
  - file: <path>
- Inputs consumed: ...
- Open questions: ...

## Open Questions
<Live list maintained by Lead>
```

**API**：
```ts
export function createWorkspace(groupId: string, parentTaskId: string, goal: string, leadAgentId: string): string
export function readWorkspace(groupId: string, parentTaskId: string): string | null
export function appendDecision(groupId: string, parentTaskId: string, author: string, decision: string): void
export function appendHandoff(groupId: string, parentTaskId: string, handoff: TaskHandoff): void
export function updatePlanSection(groupId: string, parentTaskId: string, planMd: string): void
export function setWorkspaceStatus(groupId: string, parentTaskId: string, status: "planning"|"in_progress"|"done"|"blocked"): void
```

**为什么是 markdown 而不是 JSON**：
1. 人类可读，用户可直接在文件系统看到进度
2. Agent 把它读进 prompt 时无需额外渲染
3. 追加语义 = 天然审计日志

### 4.2 `server/src/guild/planner.ts`

**职责**：当一个 `requirement` task 被创建时，Lead 跑一次 LLM 调用把它拆成 subtasks。

**模型选择**（用户要求：用用户选择的模型）：
1. 如果 `Group.leadAgentId` 指向一个真实 agent，用该 agent 的 `modelId`（可能来自 agent 自己的字段）
2. 否则用 `loadUserConfig().modelId`
3. 两者都没有 → 系统默认

**流程**：
```
1. readWorkspace() / createWorkspace() 确保 workspace 存在
2. 收集上下文：
   - group.assets（resolved 片段）
   - group.members（名字、description、擅长领域、owned assets）
   - 历史上该 group 完成过的 requirement（取最近 3 个的 handoff 摘要）
3. 构造 planner prompt（见下）
4. 调 streamAgentWithTokens，强制 JSON 输出
5. 解析 → createTask(kind="subtask", parentTaskId=..., dependsOn=...) 批量写
6. updatePlanSection(workspace, renderedTable)
7. 把 requirement 置 "orchestrating"（复用 in_progress），subtaskIds 写回
8. 触发一次 scheduleGroup 让 specialist 开始抢 subtask
```

**Planner Prompt 骨架**：
```
你是 <GroupName> 的 Tech Lead。你的任务：把下面的需求拆成可独立完成的 subtask 列表。

## 团队成员
- <Alice>：<description>；擅长 <tags>；负责仓库 <ownedRepos>
- <Bob>：...

## 团队资源
- 仓库 <foo>（owner: Alice）：<description>
- 文档 <api-spec>（owner: Bob）：<description>

## 历史经验（最近 3 个需求的 handoff 摘要）
- ...

## 当前需求
<title>
<description>

## 输出格式（严格 JSON）
{
  "goal": "...",
  "scope": { "repos": [...], "outOfScope": [...] },
  "subtasks": [
    {
      "title": "...",
      "description": "...",
      "suggestedSkills": ["backend","repo:foo"],
      "suggestedAgentId": "<id>" | null,
      "dependsOn": [<indexOfPrevSubtask>],
      "acceptanceCriteria": "..."
    }
  ],
  "risks": ["..."],
  "acceptanceCriteria": "最终验收标准"
}

规则：
- 每个 subtask 必须能被单个 agent 独立完成
- 跨仓库的工作必须拆到不同 subtask
- dependsOn 用数组下标表示，形成 DAG
- 如果需求无法拆解或信息不足，返回 subtasks=[] 并在 risks 里说明
```

**容错**：
- JSON 解析失败 → 重试一次（低温度）→ 还不行就把原 requirement 降级为 `adhoc`，由 bidding 兜底。
- `subtasks=[]` → 标记 requirement 为 `blocked`，append 到 Open Questions，通知用户。

### 4.3 `server/src/guild/teammateRoster.ts`

小工具，生成一段团队名单 markdown，供 Specialist prompt 注入：
```ts
export function buildTeammateRoster(groupId: string, excludeAgentId?: string): string
```

输出：
```
## Your Teammates
- **Alice**（backend specialist）: 擅长 API 设计、DB 迁移；负责 repo:foo
- **Bob**（frontend specialist）: 擅长 React、样式；负责 repo:bar

## Collaboration Rules
- 如果当前 subtask 里有不属于你负责领域的工作，不要硬做。
- 在 result 的 openQuestions 里写明，Lead 会创建新的 subtask 交给对应同事。
- 执行前先读 workspace 的 Handoffs 段，了解上游给你的输入。
- 执行完必须产出结构化 handoff。
```

---

## 五、现有模块改动

### 5.1 `guildManager.ts`

- `createGroup` 增支持 `assets`、`leadAgentId`。
- 新增 `addGroupAsset / removeGroupAsset / setGroupLead`。
- `getGroupAssets(groupId): AgentAsset[]` — 返回组级 + 所有成员的 agent 级资产（聚合）。

### 5.2 `taskBoard.ts`

- `createTask` 支持 `kind`、`parentTaskId`、`suggestedSkills`、`acceptanceCriteria`。
- 新增 `getSubtasks(groupId, parentId)`、`areDepsReady(groupId, task)`。
- `completeTask` 在写入 `result` 时同时接收可选 `handoff`，自动 append 到 workspace。

### 5.3 `bidding.ts`

- `evaluateTask` 开头：若 `task.kind === "requirement"` 直接返回 null（不允许被 bid）。
- `evaluateTask` 开头：若 `task.dependsOn` 有未完成的依赖，返回 null。
- `calculateConfidence`：
  - 先查资产 owner：如果任务 `suggestedSkills` 包含某资产的 `tags` 或 `ownerAgentId === agent.id`，直接 `+ownerBonusWeight`（默认 0.5，最终仍 clamp 到 1）。
  - `successRate` 改为 `(agent.stats.tasksCompleted === 0 ? successRatePrior : agent.stats.successRate)`。
  - Load decay 只作用于"负载部分"：把衰减从整个 score 移到一个独立的 `loadPenalty`，最终 `score = baseScore - loadPenalty`。
  - 技能分归一化改为 `matches / Math.max(5, uniqueKeywords)`，防止长描述被惩罚。
- 新增 `scoreBreakdown: { asset, memory, skill, success, ownerBonus, loadPenalty, threshold, final }` 写入 `TaskBid`。

### 5.4 `autonomousScheduler.ts`

- 取 open 任务时，先过滤 `kind === "requirement"` → 这些应交给 Planner 而非 bidding。
- 对每个 `requirement`：若无 subtasks，调用 `planner.planRequirement()`；有 subtasks 但未全部完成，跳过（等子任务事件驱动）。
- 对 `subtask`：先 `areDepsReady`，否则跳过。
- 依赖完成事件：`task_completed` 触发下游 subtask 的 `scheduleGroup`。

### 5.5 `agentExecutor.ts`

- `buildGuildAgentPrompt` 增加：
  - `## Your Teammates`（from `teammateRoster.ts`）
  - `## Shared Workspace`（把 workspace.md 的 Goal / Plan / Handoffs / Open Questions 段嵌入，截断到合理长度）
  - `## Collaboration Rules`（指示必须产出 handoff）
- 执行完成后：要求 agent 在 result 里包含 structured handoff。如果没有，从 `accumulatedContent` 末尾用一个轻量 LLM 调用（或启发式）补齐一个最小 handoff。
- `completeTask` 调用前：`appendHandoff(workspace, handoff)`。
- `settleExperience` → 新的 `settleMemory`（见 §6）。

### 5.6 `memoryManager.ts`

见下节，彻底重构。

---

## 六、Agent 记忆体系重构

### 6.1 现存问题

1. `searchRelevant` 里 `accessCount++` 但不 `saveIndex`，**副作用丢失**。
2. 只有关键词 substring 搜索，中文无分词。
3. 记忆分 `experience|knowledge|preference` 三类，但 `settleExperience` 自动生成时 content 模板粗糙，tag 只取标题前几个词，信噪比极低。
4. 没有"团队记忆"的概念——每次需求的 handoff、决策、事后复盘都没有沉淀到一个 agent 可查的位置。
5. 时间久了目录会变成一堆 `mem_xxx.md`，缺乏层级、无法手动整理。

### 6.2 重构目标

**Agent 是一个活生生的个体**——它应该有：
1. **Episodic memory**（经历）：每次任务的精简事后记录。
2. **Semantic memory**（知识）：抽象出的"我学到了什么"。
3. **Procedural memory**（做事方式）：反复用到的步骤 / 偏好。
4. **Shared memory**（团队记忆）：当前 Group 的共识、约定、人物关系。

### 6.3 存储布局（向前兼容）

```
data/guild/agents/{agentId}/memory/
├── index.json                     # 主索引（见 schema）
├── episodic/
│   ├── 2026-04/
│   │   ├── mem_xxx.md             # 单条经历
│   └── 2026-03/
├── semantic/
│   ├── by-topic/
│   │   ├── langgraph.md           # 聚合型知识卡
│   │   ├── repo-foo.md
│   └── flat/
│       └── mem_xxx.md             # 离散条目
├── procedural/
│   └── mem_xxx.md
└── shared/                        # 软链/引用到 group 级记忆
    └── group_{gid}/
        └── decisions.md
```

### 6.4 `index.json` Schema

```ts
interface MemoryIndex {
  version: 2;
  agentId: string;
  entries: MemoryEntry[];
  lastCompactedAt?: string;
}

interface MemoryEntry {
  id: string;                      // mem_<ulid>（不再用 Date.now，防碰撞）
  type: "episodic" | "semantic" | "procedural";
  title: string;
  summary: string;                 // ≤200 字的摘要（比 content 更适合 prompt 注入）
  filePath: string;                // 相对 memory/ 的路径
  tags: string[];                  // 归一化小写
  relatedAssetIds?: string[];
  relatedAgentIds?: string[];      // 谁参与/提到的
  sourceTaskId?: string;           // 来自哪个任务
  sourceGroupId?: string;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  lastAccessedAt?: string;
  pinned?: boolean;                // 手动置顶，不被 compaction 淘汰
  strength: number;                // 0-1，随访问/时间/关联度变化
}
```

### 6.5 关键 API（全部持久化）

```ts
// 写入
saveMemory(agentId, params): MemoryEntry    // 自动落盘 + 更新 index
updateMemory(agentId, id, updates): MemoryEntry
deleteMemory(agentId, id): boolean
pinMemory(agentId, id, pinned: boolean): void

// 读取
getMemory(agentId, id): MemoryEntry | null
listMemories(agentId, filter): MemoryEntry[]
searchMemories(agentId, query, opts): MemoryEntry[]
  // 1. 字面关键词（保留）
  // 2. tag 精确匹配加权
  // 3. relatedAssetIds / sourceGroupId 预过滤
  // 4. recency + strength + accessCount 打分
  // 5. access 统计必须 saveIndex（修 bug）

// 生成（事后复盘）
settleTaskMemory(agentId, task, result, handoff): {
  episodic: MemoryEntry;
  semantic?: MemoryEntry;           // 当 task 产出了"可复用的知识"时同时生成
}

// Compaction（手动 + 定时）
compactMemories(agentId, opts): { removed: number; merged: number }
  // 30 天以上 + 未 pinned + strength<阈值 → 合并到 semantic 层或归档
```

### 6.6 记忆生成策略（`settleTaskMemory`）

不再用"title 前几个词当 tag"这种粗糙做法：

```
1. Episodic (必产出)
   - title: task.title
   - summary: 一段 100-200 字摘要（用轻量模型生成或从 handoff.summary 派生）
   - tags: 从 task.suggestedSkills + asset.tags + groupId 合并
   - sourceTaskId / sourceGroupId 必填
   - strength 初始 0.8（新记忆 recency 高）

2. Semantic (条件产出)
   - 触发条件：result 里包含"我学到了..."、"下次应..."类指示词
                 或 handoff.openQuestions 解决了历史遗留问题
   - 用 LLM 生成一条"这次得出了什么可复用的结论"
   - tags 偏抽象（技术名词为主）

3. Procedural
   - 只在用户显式 addMemory(type="procedural") 时写
   - 不自动派生
```

### 6.7 向后兼容

- 老的 `memory/index.json`（扁平数组）自动迁移到 `version:2`：读到 v1 → 转换 → 备份原文件为 `.v1.bak`。
- 老的 `experiences/knowledge/preferences` 目录保留为只读 legacy；新增条目写到新路径。
- 迁移脚本 `server/src/scripts/migrateGuildMemory.ts`，启动时检测运行。

---

## 七、落地顺序（Phase）

### Phase 1 — 容器（本次提交）

纯存储 / 类型层，无 LLM 改动。目的：把"协作的载体"先建起来。

- [x] `types.ts` 扩字段：Group.leadAgentId/assets、AgentAsset.scope/ownerAgentId/tags、TaskKind、TaskHandoff、GuildTask.parentTaskId 等
- [x] `workspace.ts` 新模块
- [x] `taskBoard.ts` 支持新字段 + `getSubtasks / areDepsReady`
- [x] `guildManager.ts` 支持 Group 级 asset / lead
- [x] `routes.ts` 暴露必要端点
- [x] 单元测试：workspace 追加、subtask 依赖检查

### Phase 2 — Planner

引入 Lead，实际调用用户模型拆解 requirement。

- [ ] `planner.ts` 新模块
- [ ] `teammateRoster.ts`
- [ ] `autonomousScheduler.ts`：路由 requirement → planner，subtask 依赖检查
- [ ] `bidding.ts`：过滤 requirement、依赖未就绪的任务
- [ ] 集成测试：发一条 requirement → Planner → subtasks → bidding → 串行执行

### Phase 3 — Prompt 注入 + Handoff

让 Specialist 真正"感知队友 + 共享工作区"。

- [ ] `buildGuildAgentPrompt` 增加 teammate roster / workspace 快照 / collaboration rules
- [ ] `executeAgentTask` 完成时强制产出 handoff + 追加 workspace
- [ ] bidding 的 owner bonus / successRate 先验 / load decay 修正 / scoreBreakdown

### Phase 4 — 记忆体系重构

- [ ] `memoryManager.ts` v2 schema + 迁移脚本
- [ ] `settleTaskMemory` 替换 `settleExperience`
- [ ] compaction 后台任务
- [ ] 修 `searchRelevant` 副作用 bug

### Phase 5 — 前端（另一个迭代）

- 发布需求时默认 `kind=requirement`，可切 `adhoc`
- 任务面板区分 requirement / subtask，展开显示 DAG
- Workspace 面板（直接渲染 markdown）
- Bid 明细展开 scoreBreakdown

---

## 八、Tradeoffs（已接受）

1. **Planner 多一次 LLM 调用**：每个需求增加一次拆解成本。接受理由：用户的典型任务是跨仓库需求，这笔开销值得。
2. **Lead 单点质量**：拆错了下游全歪。缓解：用户可在 UI 审阅拆解结果、手动改再放行（类似 Plan Mode），后续迭代。
3. **Workspace 膨胀**：Decisions / Handoffs 段会不断增长。缓解：Lead 在每个阶段结束做一次 summary；长度超阈值时 fold 成 collapsible 段。
4. **Prompt 体积膨胀**：队友名单 + workspace 会让每次调用都更贵。缓解：队友名单 < 500 tokens；workspace 只注入最近 N 条 handoff + Goal/Plan 段。
5. **旧数据兼容**：老 Group 没有 leadAgentId、老 Task 没有 kind。默认 `kind="adhoc"` 走旧路径，保证老任务不炸。

---

## 九、不在本次 Scope 内

- 强制 Agent 行为边界（白名单仓库 / 工具权限）——靠 prompt 约束，不做代码级 guard。
- Agent-to-Agent 直接聊天 / 协商——太乱，坚持"通过 workspace 异步协作"模型。
- 跨 Guild 协作。
- Memory 的向量化检索——本次仅修 bug + 重构 schema，向量是后续增量。

---

## 十、参考

- `docs/GUILD_MODE_DESIGN.md`
- `docs/GUILD_BIDDING_LOGIC.md`
- 源码：`server/src/guild/`
