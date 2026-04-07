# Guild Mode 自治协作系统 — 设计文档

> 分支: `feat/self_work`
> 最后更新: 2026-04-07

---

## 一、功能概述

Guild Mode 是一种全新的多智能体协作模式，与现有 Team Mode（Coordinator 中心委派）形成互补。核心理念：**去中心化、Agent 自治、持久记忆、资产绑定、竞标协作**。

### 与 Team Mode 的对比

| 维度 | Team Mode | Guild Mode |
|------|-----------|------------|
| **协调方式** | Coordinator 统一分派 | 无 Leader，Agent 平级自治 |
| **Agent 生命周期** | 会话级，对话结束即消失 | 跨会话持久存在，随时间迭代成长 |
| **记忆** | 无持久化，每次从零开始 | 每个 Agent 独立记忆空间 |
| **任务分配** | Coordinator 决定谁做什么 | 任务看板 + 竞标制自动匹配 |
| **Agent 身份** | 角色模板实例，可替换 | 独立实体，有资产/记忆/经验 |
| **用户交互** | 对话框驱动 | 工作台驱动，扁平化 UI |
| **编排方式** | 隐式（Coordinator prompt） | 用户创建 Agent + 挂资产，其余自治 |
| **组织结构** | 扁平（Coordinator → Workers） | 三层（Guild → Group → Agent） |

### 核心价值

- **Agent 成长性**：Agent 随时间积累记忆与经验，越用越懂业务
- **最优匹配**：竞标制确保每个任务由最合适的 Agent 执行
- **灵活编组**：Agent 可跨 Group 调动，携带经验加入新团队
- **用户轻量编排**：用户只需创建 Agent、挂资产、发号施令
- **可视化协作**：工作台 UI 让协作过程透明可控

---

## 二、核心概念模型

### 2.1 三层结构：Guild → Group → Agent

```
Guild 工作台（全局视图）
│
├── Group A: "商城重构"
│   ├── 🤖 前端专家 (bound)     ← 有商城前端仓库资产
│   ├── 🤖 后端专家 (bound)     ← 有商城后端仓库资产
│   └── 🤖 测试专家 (bound)     ← 有测试框架资产
│   └── [Task Board A]
│
├── Group B: "数据迁移"
│   ├── 🤖 DBA专家 (bound)      ← 有数据库资产
│   └── 🤖 后端专家-2 (bound)   ← 有迁移脚本资产
│   └── [Task Board B]
│
└── Agent 池（未分组）
    ├── 🤖 安全审计专家
    └── 🤖 文档专家
```

**关键规则：**

- **Agent 是独立实体**：有自己的记忆、资产、技能、执行历史，跨会话持久化
- **一个 Agent 同一时间只属于一个 Group**：排他绑定，保证责任清晰
- **Group 是工作上下文**：有自己的任务看板、共享上下文、目标描述
- **用户对 Group 发号施令**：Group 内的 Agent 通过竞标自取任务
- **Agent 可调动**：从一个 Group 解绑后加入另一个 Group，记忆和资产跟随

### 2.2 Guild（公会）

Guild 是顶层容器，代表用户的整个自治 Agent 工作空间。每个用户有一个 Guild 实例。

```typescript
interface Guild {
  id: string;
  name: string;                    // 用户自定义名称
  description?: string;
  groups: string[];                // Group ID 列表
  agentPool: string[];             // 未分组的 Agent ID 列表
  createdAt: string;
  updatedAt: string;
}
```

### 2.3 Group（工作组）

Group 是任务协作的单元。一组 Agent 围绕一个目标协同工作。

```typescript
interface Group {
  id: string;
  name: string;                    // "商城重构"、"数据迁移"
  description: string;             // 组的目标描述
  guildId: string;                 // 所属 Guild
  agents: string[];                // 绑定的 Agent ID 列表
  taskBoard: string;               // 关联的 TaskBoard ID
  sharedContext?: string;          // 组级共享上下文（所有 Agent 可见）
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}
```

### 2.4 Agent（自治智能体）

Guild 模式的 Agent 是完全独立的持久化实体，区别于 Team 模式的角色模板实例。

```typescript
interface GuildAgent {
  id: string;
  name: string;                    // "前端专家"、"DBA 专家"
  description: string;             // 角色描述 & 能力说明
  icon: string;
  color: string;
  
  // --- 核心能力 ---
  systemPrompt: string;            // 基础人格 & 专业领域 prompt
  allowedTools: string[];          // 可用工具列表 ["*"] = 全部
  modelId?: string;                // 可选：指定使用的模型
  
  // --- 持久化状态 ---
  memoryDir: string;               // 记忆存储目录 data/guild/agents/{id}/memory/
  assets: AgentAsset[];            // 绑定的资产列表
  skills: AgentSkill[];            // 习得的技能
  
  // --- 运行时状态 ---
  groupId?: string;                // 当前所属 Group（null = Agent 池）
  status: "idle" | "working" | "offline";
  currentTaskId?: string;          // 正在执行的任务
  
  // --- 元信息 ---
  createdAt: string;
  updatedAt: string;
  stats: AgentStats;               // 统计信息
}

interface AgentStats {
  tasksCompleted: number;          // 完成任务数
  totalWorkTimeMs: number;         // 累计工作时间
  avgConfidence: number;           // 平均竞标置信度
  successRate: number;             // 任务成功率
  lastActiveAt: string;            // 最后活跃时间
}
```

---

## 三、Agent 资产系统

资产（Asset）是 Agent 的核心知识载体。仓库、文档、API、数据库、配置、prompt 模板等都可以抽象为资产。Agent 带着资产走 — 调去另一个 Group，资产跟着它，记忆也跟着它。

### 3.1 资产定义

```typescript
interface AgentAsset {
  id: string;
  type: AssetType;
  name: string;                    // "商城前端仓库" / "支付 API 文档"
  uri: string;                     // 路径、URL、连接串，统一用 URI
  description?: string;            // 资产说明
  metadata?: Record<string, any>;  // 各类型各自的扩展信息
  addedAt: string;
  lastAccessedAt?: string;
}

type AssetType = 
  | "repo"        // 代码仓库 — uri: 本地路径或 git URL
  | "document"    // 文档 — uri: 文件路径或 URL
  | "api"         // API 端点 — uri: base URL，metadata 含 spec
  | "database"    // 数据库 — uri: 连接串
  | "prompt"      // Prompt 模板 — uri: 模板文件路径
  | "config"      // 配置文件 — uri: 文件路径
  | "mcp_server"  // MCP 服务器 — uri: 服务端点
  | "custom";     // 自定义 — 用户自由扩展
```

### 3.2 资产与竞标的关系

资产是 Agent 竞标时的核心判断依据：

```
任务: "修复商城前端的登录页 Bug"
  ↓
前端专家（持有"商城前端仓库"资产）→ confidence: 0.95
后端专家（无相关资产）             → confidence: 0.30
测试专家（持有测试框架资产）        → confidence: 0.45
```

资产匹配逻辑：
- Agent 检查自身 assets 与任务描述的语义关联度
- 持有相关 repo/document 的 Agent 天然高 confidence
- 资产 + 记忆中的历史经验 = 最终 confidence 评分

### 3.3 资产的运行时作用

当 Agent 领取任务后，绑定的资产会自动注入执行上下文：

- **repo 资产** → 自动将仓库路径加入工作目录范围，Agent 可直接读写
- **document 资产** → 关键文档摘要注入 system prompt
- **api 资产** → API spec 概要注入上下文
- **database 资产** → 连接信息可用（需审批访问）
- **prompt 资产** → 模板可复用

---

## 四、Agent 记忆系统

每个 Agent 拥有独立的持久化记忆空间，跨会话保留，随时间积累。

### 4.1 记忆存储结构

```
data/guild/agents/{agentId}/
├── memory/
│   ├── index.md                   # 记忆索引
│   ├── experiences/               # 经验记忆（完成任务后自动沉淀）
│   │   ├── exp_001.md            # "修复了商城登录页的 CORS 问题"
│   │   └── exp_002.md            # "重构了支付模块的错误处理"
│   ├── knowledge/                 # 知识记忆（对资产的理解）
│   │   ├── repo_mall_frontend.md  # 商城前端仓库的架构笔记
│   │   └── api_payment.md         # 支付 API 的使用心得
│   └── preferences/               # 偏好记忆（工作方式偏好）
│       └── coding_style.md        # 代码风格偏好
├── results/                       # 任务执行结果存档
│   ├── task_001_result.md
│   └── task_002_result.md
└── profile.json                   # Agent 配置档案
```

### 4.2 记忆类型

```typescript
interface AgentMemory {
  id: string;
  type: "experience" | "knowledge" | "preference";
  title: string;
  content: string;
  tags: string[];                  // 用于检索的标签
  relatedAssets?: string[];        // 关联的资产 ID
  createdAt: string;
  accessCount: number;             // 被引用次数
  lastAccessedAt?: string;
}
```

**三类记忆：**

| 类型 | 来源 | 用途 | 示例 |
|------|------|------|------|
| **experience** | 任务完成后自动沉淀 | 竞标评估 + 执行参考 | "修复了 CORS 问题，根因是 nginx 配置" |
| **knowledge** | 资产学习 + 工作中积累 | 理解代码库/API/架构 | "商城前端用 React 18 + Zustand" |
| **preference** | 用户反馈 + 自我总结 | 指导工作方式 | "用户偏好函数式组件，不要 class" |

### 4.3 记忆检索

当 Agent 领取任务时，自动检索相关记忆注入上下文：

```typescript
interface MemoryQuery {
  taskDescription: string;         // 任务描述
  relatedAssets?: string[];        // 任务相关的资产
  maxResults?: number;             // 最大返回数（默认 10）
  types?: MemoryType[];            // 筛选记忆类型
}

// 检索策略：
// 1. 关键词匹配：任务描述 vs 记忆 tags/content
// 2. 资产关联：任务涉及的资产 → 找到该资产相关的记忆
// 3. 时间衰减：近期记忆权重更高
// 4. 使用频率：高 accessCount 的记忆权重更高
```

### 4.4 记忆沉淀流程

```
Agent 完成任务
  ↓
自动生成任务摘要
  ↓
提取关键经验（遇到的问题、解决方案、学到的知识）
  ↓
写入 experience 记忆
  ↓
如涉及新的资产理解 → 更新/创建 knowledge 记忆
  ↓
更新记忆索引 index.md
```

---

## 五、竞标制任务分配

### 5.1 核心机制

与 Team Mode 的 Coordinator 指派不同，Guild Mode 采用**竞标制**：任务出现在看板后，所有空闲 Agent 评估并出价，最合适的 Agent 自动 claim。

```
用户在 Group 中创建任务
  ↓
任务进入 Task Board（状态: open）
  ↓
Group 内所有 idle Agent 收到通知
  ↓
每个 Agent 评估任务，生成 TaskBid
  ↓
系统按 confidence 排序，最高分 Agent 自动 claim
  ↓
Agent 状态: idle → working，任务状态: open → in_progress
  ↓
Agent 执行任务
  ↓
完成后: Agent 状态 → idle，任务状态 → completed
  ↓
沉淀记忆 + 更新统计
```

### 5.2 竞标数据结构

```typescript
interface TaskBid {
  agentId: string;
  taskId: string;
  confidence: number;              // 0-1，综合评分
  reasoning: string;               // "我负责的仓库，改过 3 次类似的"
  estimatedComplexity: "low" | "medium" | "high";
  relevantAssets: string[];        // 与此任务相关的资产
  relevantMemories: string[];      // 与此任务相关的记忆
  biddedAt: string;
}
```

### 5.3 Confidence 评分算法

```typescript
function calculateConfidence(agent: GuildAgent, task: GuildTask): number {
  let score = 0;
  
  // 1. 资产匹配（权重 40%）
  // Agent 是否持有任务涉及的 repo/api/document
  const assetMatch = matchAssets(agent.assets, task);
  score += assetMatch * 0.4;
  
  // 2. 记忆相关性（权重 30%）
  // Agent 是否有类似任务的经验
  const memoryRelevance = queryMemoryRelevance(agent.memoryDir, task);
  score += memoryRelevance * 0.3;
  
  // 3. 技能匹配（权重 20%）
  // Agent 的 systemPrompt/skills 是否覆盖任务需求
  const skillMatch = matchSkills(agent, task);
  score += skillMatch * 0.2;
  
  // 4. 历史成功率（权重 10%）
  // Agent 历史上类似任务的成功率
  score += agent.stats.successRate * 0.1;
  
  return Math.min(score, 1.0);
}
```

### 5.4 避免抢活死锁

**问题**：全能型 Agent 可能对所有任务都出高分，导致任务集中在一个 Agent。

**解决方案：**

1. **并发限制**：每个 Agent 同时只能执行一个任务（`currentTaskId` 非空时不参与竞标）
2. **负载均衡惩罚**：连续完成 N 个任务后，confidence 施加衰减系数
3. **专精加分**：持有直接相关资产的 Agent 获得额外加分，泛用 Agent 无此加成
4. **超时自动释放**：Agent 超时未完成，任务自动释放回看板重新竞标

```typescript
interface BiddingConfig {
  maxConcurrentTasks: number;      // 每 Agent 最大并发任务数（默认 1）
  loadDecayFactor: number;         // 负载衰减系数（默认 0.9^n）
  assetBonusWeight: number;        // 资产直接匹配额外加分（默认 0.15）
  taskTimeoutMs: number;           // 任务超时时间（默认 10 分钟）
  minConfidenceThreshold: number;  // 最低竞标门槛（默认 0.3）
}
```

---

## 六、任务看板

### 6.1 任务数据结构

```typescript
interface GuildTask {
  id: string;
  groupId: string;                 // 所属 Group
  title: string;
  description: string;
  
  // --- 状态 ---
  status: "open" | "bidding" | "in_progress" | "completed" | "failed" | "cancelled";
  priority: "low" | "medium" | "high" | "urgent";
  
  // --- 分配 ---
  assignedAgentId?: string;        // 中标的 Agent
  bids?: TaskBid[];                // 竞标记录
  
  // --- 依赖 ---
  dependsOn?: string[];            // 前置任务 ID
  blockedBy?: string[];            // 被阻塞的原因
  
  // --- 结果 ---
  result?: TaskResult;
  
  // --- 元信息 ---
  createdBy: "user" | string;      // "user" 或 Agent ID（Agent 可拆任务）
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface TaskResult {
  summary: string;                 // 执行摘要
  artifacts?: string[];            // 产出物路径
  agentNotes?: string;             // Agent 的备注
  memoryCreated?: string[];        // 沉淀的记忆 ID
}
```

### 6.2 任务生命周期

```
[open] ──竞标开始──→ [bidding] ──中标──→ [in_progress] ──完成──→ [completed]
  │                    │                     │
  │                    └──无人竞标──→ [open]  └──失败──→ [failed] → [open]（重新竞标）
  │
  └──取消──→ [cancelled]
```

### 6.3 任务来源

任务可以由以下方式创建：

1. **用户手动创建**：在 Group 的任务看板中添加
2. **用户指令拆解**：用户对 Group 发出指令，系统自动拆解为多个任务
3. **Agent 拆解**：Agent 在执行过程中发现需要拆分子任务
4. **Agent 发现**：Agent 在工作中发现问题，主动创建任务

---

## 七、UI 设计：工作台

### 7.1 页面级切换

在顶层导航增加模式切换，Guild 工作台是独立的顶级页面：

```
┌─────────────────────────────────────────────────────────┐
│  TopBar: [💬 对话模式]  [⚔️ Guild 工作台]  ← 页面级切换   │
└─────────────────────────────────────────────────────────┘
```

路由设计：

```typescript
// web/src/App.tsx 路由扩展
<Routes>
  <Route path="/" element={<ChatMode />} />              // 现有对话模式
  <Route path="/c/:conversationId" element={<ChatMode />} />
  <Route path="/guild" element={<GuildWorkbench />} />     // 新增：Guild 工作台
  <Route path="/guild/group/:groupId" element={<GuildWorkbench />} />
  <Route path="/share/:shareId" element={<SharedView />} />
</Routes>
```

### 7.2 工作台布局

```
┌──────────────────────────────────────────────────────────────────┐
│  [💬 对话]  [⚔️ Guild]          ArcanaAgent              [⚙️]    │
├──────────┬───────────────────────────────────┬───────────────────┤
│          │                                   │                   │
│ Groups   │        Task Board                 │   Detail Panel    │
│          │                                   │                   │
│ ┌──────┐ │  ┌─────────┬──────────┬────────┐  │  Agent: 前端专家   │
│ │商城   │ │  │  Open   │ Working  │  Done  │  │  Status: working  │
│ │重构 🟢│ │  │         │          │        │  │  ─────────────── │
│ └──────┘ │  │ ☐修复    │ ☐重构    │ ✅修复  │  │  当前任务:        │
│ ┌──────┐ │  │  登录Bug │  支付页  │  首页  │  │  "重构支付页面"   │
│ │数据   │ │  │  🏷️ high│  🤖前端  │  🤖前端│  │  ─────────────── │
│ │迁移 🟡│ │  │         │  🔵 0.92│  ✅     │  │  📦 资产:         │
│ └──────┘ │  │ ☐添加    │          │        │  │  · 商城前端仓库   │
│          │  │  缓存层  │          │        │  │  · React 文档     │
│ ┌──────┐ │  │  🏷️ med │          │        │  │  ─────────────── │
│ │Agent │ │  │         │          │        │  │  🧠 相关记忆:     │
│ │池    │ │  └─────────┴──────────┴────────┘  │  · 上次修复过      │
│ │ 🤖×2 │ │                                   │    类似CORS问题    │
│ └──────┘ │  ┌─ 用户指令 ────────────────────┐ │                   │
│          │  │ "把登录页的Bug修了，顺便重构下"│ │  📊 统计:         │
│ [+Group] │  │                    [发送 ▶]   │ │  完成: 47 任务    │
│ [+Agent] │  └───────────────────────────────┘ │  成功率: 94%      │
│          │                                   │                   │
└──────────┴───────────────────────────────────┴───────────────────┘
```

### 7.3 三栏布局说明

**左栏：Groups + Agent 池**
- Group 列表，点击切换右侧 Task Board
- 每个 Group 显示状态指示灯（🟢 活跃 / 🟡 有任务进行中 / ⚪ 空闲）
- Agent 池显示未分组的 Agent
- 底部操作按钮：创建 Group、创建 Agent

**中栏：Task Board（看板视图）**
- 三列：Open / Working / Done
- 任务卡片显示标题、优先级、分配的 Agent、confidence 分数
- 底部输入框：用户可直接对 Group 发指令，自动拆解为任务
- 支持拖拽排序优先级

**右栏：Detail Panel（上下文面板）**
- 点击 Agent 时：显示 Agent 详情（资产、记忆、统计、当前任务实时输出）
- 点击任务时：显示任务详情（描述、竞标记录、执行日志、产出物）
- 点击 Group 时：显示 Group 概况（成员、统计、共享上下文）

### 7.4 Agent 实时输出

当 Agent 正在工作时，右栏 Detail Panel 实时展示：

```
┌─ Agent: 前端专家 ─────────────────────────┐
│ 🔵 Working on: "重构支付页面"              │
├───────────────────────────────────────────┤
│ 💭 Thinking...                            │
│ 分析支付页面结构，发现以下问题：            │
│ 1. 状态管理过于分散                        │
│ 2. 错误处理不统一                          │
│                                           │
│ 🔧 Tool: read_file("src/pages/Pay.tsx")   │
│ ✅ 读取完成 (245 行)                       │
│                                           │
│ 🔧 Tool: write_file("src/pages/Pay.tsx")  │
│ ✅ 重构完成                                │
│                                           │
│ 📝 正在生成测试用例...                      │
└───────────────────────────────────────────┘
```

### 7.5 创建 Agent 的 UI 流程

```
[+ 创建 Agent] 按钮
  ↓
┌─ 创建新 Agent ────────────────────────────┐
│                                           │
│ 名称:   [前端专家________________]         │
│ 图标:   [🤖 ▾]   颜色: [#3B82F6 ▾]       │
│                                           │
│ 角色描述:                                  │
│ ┌───────────────────────────────────────┐ │
│ │ 精通 React/TypeScript 的前端开发专家   │ │
│ │ 擅长组件化架构、性能优化和UI实现       │ │
│ └───────────────────────────────────────┘ │
│                                           │
│ 资产:                                      │
│ ┌───────────────────────────────────────┐ │
│ │ 📁 repo: /Users/cloud/projects/mall  │ │
│ │ 📄 doc: React 最佳实践.md             │ │
│ │ [+ 添加资产]                          │ │
│ └───────────────────────────────────────┘ │
│                                           │
│ 可用工具: [全部 ▾]                         │
│ 模型: [默认 ▾]                             │
│                                           │
│            [取消]  [创建]                   │
└───────────────────────────────────────────┘
```

---

## 八、后端架构

### 8.1 新增模块结构

```
server/src/
├── guild/
│   ├── index.ts                   # Guild 模块入口
│   ├── types.ts                   # Guild 相关类型定义
│   ├── guildManager.ts            # Guild/Group/Agent CRUD 管理
│   ├── taskBoard.ts               # 任务看板管理
│   ├── bidding.ts                 # 竞标引擎
│   ├── agentExecutor.ts           # Agent 自治执行器
│   ├── memoryManager.ts           # 记忆管理器
│   ├── assetResolver.ts           # 资产解析 & 上下文注入
│   └── eventBus.ts                # Guild 事件总线
```

### 8.2 GuildManager — 核心管理器

```typescript
class GuildManager {
  // --- Guild ---
  getGuild(): Guild;
  updateGuild(updates: Partial<Guild>): Guild;
  
  // --- Group ---
  createGroup(params: CreateGroupParams): Group;
  updateGroup(groupId: string, updates: Partial<Group>): Group;
  archiveGroup(groupId: string): void;
  
  // --- Agent ---
  createAgent(params: CreateAgentParams): GuildAgent;
  updateAgent(agentId: string, updates: Partial<GuildAgent>): GuildAgent;
  deleteAgent(agentId: string): void;
  
  // --- Agent ↔ Group 绑定 ---
  assignAgentToGroup(agentId: string, groupId: string): void;
  removeAgentFromGroup(agentId: string): void;
  getGroupAgents(groupId: string): GuildAgent[];
  getUnassignedAgents(): GuildAgent[];
  
  // --- Agent 资产 ---
  addAsset(agentId: string, asset: AgentAsset): void;
  removeAsset(agentId: string, assetId: string): void;
  getAgentAssets(agentId: string): AgentAsset[];
}
```

### 8.3 TaskBoard — 任务看板

```typescript
class TaskBoard {
  // --- 任务 CRUD ---
  createTask(groupId: string, params: CreateTaskParams): GuildTask;
  updateTask(taskId: string, updates: Partial<GuildTask>): GuildTask;
  cancelTask(taskId: string): void;
  
  // --- 查询 ---
  getGroupTasks(groupId: string, status?: TaskStatus[]): GuildTask[];
  getAgentTasks(agentId: string): GuildTask[];
  getOpenTasks(groupId: string): GuildTask[];
  
  // --- 任务拆解 ---
  decomposeUserInstruction(groupId: string, instruction: string): GuildTask[];
}
```

### 8.4 BiddingEngine — 竞标引擎

```typescript
class BiddingEngine {
  // 触发竞标流程
  async startBidding(task: GuildTask, agents: GuildAgent[]): Promise<TaskBid[]>;
  
  // 单个 Agent 评估任务
  async evaluateTask(agent: GuildAgent, task: GuildTask): Promise<TaskBid>;
  
  // 选出中标者
  selectWinner(bids: TaskBid[]): TaskBid | null;
  
  // 计算 confidence
  calculateConfidence(agent: GuildAgent, task: GuildTask): Promise<number>;
}
```

### 8.5 AgentExecutor — 自治执行器

```typescript
class AgentExecutor {
  // 启动 Agent 执行任务
  async execute(
    agent: GuildAgent, 
    task: GuildTask, 
    options: ExecutionOptions
  ): AsyncGenerator<GuildAgentEvent>;
  
  // 构建 Agent 上下文（记忆 + 资产 + Group 共享上下文）
  buildAgentContext(agent: GuildAgent, task: GuildTask): AgentContext;
  
  // 任务完成后沉淀记忆
  async settleMemory(agent: GuildAgent, task: GuildTask, result: TaskResult): void;
}

interface ExecutionOptions {
  timeoutMs?: number;
  maxRetries?: number;
  onEvent?: (event: GuildAgentEvent) => void;  // 实时事件回调
}
```

### 8.6 MemoryManager — 记忆管理器

```typescript
class MemoryManager {
  // 读写记忆
  async saveMemory(agentId: string, memory: AgentMemory): Promise<void>;
  async getMemories(agentId: string, query?: MemoryQuery): Promise<AgentMemory[]>;
  async deleteMemory(agentId: string, memoryId: string): Promise<void>;
  
  // 记忆检索
  async searchRelevant(agentId: string, taskDescription: string, limit?: number): Promise<AgentMemory[]>;
  
  // 记忆沉淀
  async settleExperience(agentId: string, task: GuildTask, result: TaskResult): Promise<void>;
  
  // 记忆维护（定期清理低价值记忆）
  async pruneMemories(agentId: string, options?: PruneOptions): Promise<number>;
}
```

### 8.7 EventBus — Guild 事件总线

Agent 之间不直接通信，通过事件总线实现松耦合协作：

```typescript
type GuildEvent =
  | { type: "task_created"; task: GuildTask }
  | { type: "task_bidding_start"; taskId: string; agents: string[] }
  | { type: "task_assigned"; taskId: string; agentId: string; bid: TaskBid }
  | { type: "task_completed"; taskId: string; agentId: string; result: TaskResult }
  | { type: "task_failed"; taskId: string; agentId: string; error: string }
  | { type: "agent_status_changed"; agentId: string; status: AgentStatus }
  | { type: "agent_output"; agentId: string; content: string }          // 实时输出
  | { type: "agent_tool_call"; agentId: string; tool: string; input: any }
  | { type: "agent_tool_result"; agentId: string; tool: string; output: any }
  | { type: "agent_memory_settled"; agentId: string; memoryId: string }
  | { type: "group_instruction"; groupId: string; instruction: string }; // 用户指令

class GuildEventBus {
  emit(event: GuildEvent): void;
  on(type: GuildEvent["type"], handler: (event: GuildEvent) => void): void;
  off(type: GuildEvent["type"], handler: (event: GuildEvent) => void): void;
}
```

---

## 九、流式事件协议

### 9.1 SSE 事件扩展

在现有 SSE 流协议基础上，新增 `guild` 类型事件：

```typescript
type GuildStreamEvent = {
  type: "guild";
  kind: GuildStreamEventKind;
  // ... 各 kind 特有字段
};

type GuildStreamEventKind =
  | "task_created"          // 新任务创建
  | "bidding_start"         // 竞标开始
  | "bid_received"          // 收到竞标
  | "task_assigned"         // 任务分配
  | "agent_status"          // Agent 状态变更
  | "agent_token"           // Agent 输出增量
  | "agent_reasoning"       // Agent 思考过程
  | "agent_tool_call"       // Agent 工具调用
  | "agent_tool_result"     // Agent 工具返回
  | "task_completed"        // 任务完成
  | "task_failed"           // 任务失败
  | "memory_settled"        // 记忆沉淀
  | "instruction_decomposed"; // 指令拆解结果
```

### 9.2 前端事件处理

```typescript
// web/src/hooks/useGuildStream.ts
function useGuildStream(groupId: string) {
  const [tasks, setTasks] = useState<GuildTask[]>([]);
  const [agents, setAgents] = useState<GuildAgent[]>([]);
  const [agentOutputs, setAgentOutputs] = useState<Record<string, string>>({});
  
  // 监听 SSE 事件并更新状态
  useEffect(() => {
    const eventSource = new EventSource(`/api/guild/groups/${groupId}/stream`);
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data) as GuildStreamEvent;
      switch (data.kind) {
        case "task_assigned":
          // 更新任务状态和 Agent 状态
          break;
        case "agent_token":
          // 追加 Agent 实时输出
          break;
        case "task_completed":
          // 标记任务完成，更新统计
          break;
        // ...
      }
    };
    
    return () => eventSource.close();
  }, [groupId]);
  
  return { tasks, agents, agentOutputs };
}
```

---

## 十、API 设计

### 10.1 Guild API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/guild` | 获取 Guild 信息 |
| `PUT` | `/api/guild` | 更新 Guild 信息 |

### 10.2 Group API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/guild/groups` | 获取所有 Group |
| `POST` | `/api/guild/groups` | 创建 Group |
| `GET` | `/api/guild/groups/:id` | 获取 Group 详情 |
| `PUT` | `/api/guild/groups/:id` | 更新 Group |
| `DELETE` | `/api/guild/groups/:id` | 归档 Group |
| `POST` | `/api/guild/groups/:id/agents` | 向 Group 添加 Agent |
| `DELETE` | `/api/guild/groups/:id/agents/:agentId` | 从 Group 移除 Agent |
| `GET` | `/api/guild/groups/:id/stream` | SSE 流：Group 实时事件 |

### 10.3 Agent API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/guild/agents` | 获取所有 Guild Agent |
| `POST` | `/api/guild/agents` | 创建 Agent |
| `GET` | `/api/guild/agents/:id` | 获取 Agent 详情 |
| `PUT` | `/api/guild/agents/:id` | 更新 Agent |
| `DELETE` | `/api/guild/agents/:id` | 删除 Agent |
| `GET` | `/api/guild/agents/:id/memories` | 获取 Agent 记忆列表 |
| `GET` | `/api/guild/agents/:id/stats` | 获取 Agent 统计 |
| `POST` | `/api/guild/agents/:id/assets` | 添加资产 |
| `DELETE` | `/api/guild/agents/:id/assets/:assetId` | 移除资产 |

### 10.4 Task API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/guild/groups/:groupId/tasks` | 获取 Group 任务列表 |
| `POST` | `/api/guild/groups/:groupId/tasks` | 创建任务 |
| `PUT` | `/api/guild/tasks/:id` | 更新任务 |
| `DELETE` | `/api/guild/tasks/:id` | 取消任务 |
| `GET` | `/api/guild/tasks/:id/bids` | 获取竞标记录 |
| `POST` | `/api/guild/groups/:groupId/instruct` | 用户发指令（自动拆解+竞标） |

---

## 十一、存储方案

### 11.1 目录结构

```
data/
├── guild/
│   ├── guild.json                 # Guild 配置
│   ├── groups/
│   │   ├── grp_{id}/
│   │   │   ├── meta.json         # Group 元信息
│   │   │   ├── tasks.json        # 任务列表
│   │   │   ├── context.md        # 共享上下文
│   │   │   └── history.json      # 操作历史
│   ├── agents/
│   │   ├── agt_{id}/
│   │   │   ├── profile.json      # Agent 配置档案
│   │   │   ├── memory/
│   │   │   │   ├── index.md      # 记忆索引
│   │   │   │   ├── experiences/  # 经验记忆
│   │   │   │   ├── knowledge/    # 知识记忆
│   │   │   │   └── preferences/  # 偏好记忆
│   │   │   ├── results/          # 任务结果存档
│   │   │   └── assets.json       # 资产清单
```

### 11.2 持久化策略

| 数据 | 存储方式 | 读写频率 |
|------|---------|---------|
| Guild/Group 元信息 | JSON 文件 | 低（创建/修改时） |
| Agent 配置 | JSON 文件 | 低（创建/修改时） |
| Agent 记忆 | Markdown + JSON 索引 | 中（任务完成时写，竞标时读） |
| 任务列表 | JSON 文件 | 高（每次状态变更） |
| 实时输出 | 内存 + SSE 推送 | 极高（流式） |
| 竞标记录 | 内存（可选持久化） | 中（竞标时） |

---

## 十二、与现有架构的集成

### 12.1 开闭原则 — 新增而非修改

Guild 模式作为独立模块新增，尽量不修改现有 Team 模式代码：

```
现有模块（不修改）        新增模块
────────────────        ────────────
agent/index.ts          guild/index.ts         ← 复用 streamAgentWithTokens
agent/toolBuilder.ts    guild/agentExecutor.ts  ← 复用工具构建逻辑
agent/systemPrompt.ts   guild/promptBuilder.ts  ← 扩展 prompt 构建
storage/agentDefs.ts    guild/guildManager.ts   ← 独立存储
api/routes.ts           guild/routes.ts         ← 独立路由挂载
```

### 12.2 复用点

| 现有能力 | Guild 模式复用方式 |
|---------|-------------------|
| `streamAgentWithTokens()` | Agent 执行时直接复用，传入 Guild Agent 的 systemPrompt + tools |
| `buildTool()` | 工具构建逻辑直接复用，按 Agent 的 allowedTools 过滤 |
| Harness（Eval/Loop/Replan）| 每个 Agent 执行时可独立开启 Harness |
| `ApprovalManager` | 高风险操作审批机制直接复用 |
| MCP Server 集成 | Agent 可使用已配置的 MCP Server |
| Skill 系统 | Agent 可使用已安装的 Skills |

### 12.3 前端改造清单

| 文件 | 变更 | 类型 |
|------|------|------|
| `web/src/App.tsx` | 新增路由 `/guild`，顶栏模式切换 | 修改 |
| `web/src/components/GuildWorkbench.tsx` | 工作台主组件（三栏布局） | **新增** |
| `web/src/components/guild/GroupList.tsx` | 左栏 Group 列表 | **新增** |
| `web/src/components/guild/TaskBoard.tsx` | 中栏任务看板 | **新增** |
| `web/src/components/guild/DetailPanel.tsx` | 右栏详情面板 | **新增** |
| `web/src/components/guild/AgentCard.tsx` | Agent 卡片组件 | **新增** |
| `web/src/components/guild/TaskCard.tsx` | 任务卡片组件 | **新增** |
| `web/src/components/guild/CreateAgentModal.tsx` | 创建 Agent 弹窗 | **新增** |
| `web/src/components/guild/CreateGroupModal.tsx` | 创建 Group 弹窗 | **新增** |
| `web/src/components/guild/AgentOutputStream.tsx` | Agent 实时输出流 | **新增** |
| `web/src/components/guild/InstructionInput.tsx` | 用户指令输入 | **新增** |
| `web/src/hooks/useGuildStream.ts` | Guild SSE 事件处理 | **新增** |
| `web/src/hooks/useGuild.ts` | Guild 数据管理 Hook | **新增** |
| `web/src/api/guild.ts` | Guild API 客户端 | **新增** |
| `web/src/types/guild.ts` | Guild 类型定义 | **新增** |

### 12.4 后端改造清单

| 文件 | 变更 | 类型 |
|------|------|------|
| `server/src/guild/types.ts` | Guild 所有类型定义 | **新增** |
| `server/src/guild/guildManager.ts` | Guild/Group/Agent CRUD | **新增** |
| `server/src/guild/taskBoard.ts` | 任务看板管理 | **新增** |
| `server/src/guild/bidding.ts` | 竞标引擎 | **新增** |
| `server/src/guild/agentExecutor.ts` | Agent 自治执行器 | **新增** |
| `server/src/guild/memoryManager.ts` | 记忆管理器 | **新增** |
| `server/src/guild/assetResolver.ts` | 资产解析 & 上下文注入 | **新增** |
| `server/src/guild/promptBuilder.ts` | Guild Agent prompt 构建 | **新增** |
| `server/src/guild/eventBus.ts` | 事件总线 | **新增** |
| `server/src/guild/routes.ts` | Guild API 路由 | **新增** |
| `server/src/guild/index.ts` | 模块入口 & 初始化 | **新增** |
| `server/src/index.ts` | 挂载 Guild 路由 | 修改 |

---

## 十三、实现分期

### Phase 1：基础骨架（MVP）

**目标**：能创建 Agent/Group，手动分配任务，Agent 能执行并产出结果。

- [ ] Guild 数据模型 & 存储
- [ ] Agent CRUD（含资产管理）
- [ ] Group CRUD（含 Agent 绑定/解绑）
- [ ] 任务看板（CRUD + 手动分配）
- [ ] Agent 执行器（复用 streamAgentWithTokens）
- [ ] Guild 工作台 UI 骨架（三栏布局）
- [ ] 基础 SSE 事件推送
- [ ] API 全套端点

### Phase 2：自治能力

**目标**：竞标制上线，Agent 能自取任务。

- [ ] 竞标引擎（confidence 评估 + 自动分配）
- [ ] 用户指令自动拆解为任务
- [ ] 资产上下文注入
- [ ] 死锁/负载均衡机制
- [ ] 任务超时与自动释放

### Phase 3：记忆系统

**目标**：Agent 有持久记忆，能基于经验成长。

- [ ] 记忆存储 & 检索
- [ ] 任务完成后自动沉淀经验
- [ ] 资产学习（自动生成 knowledge 记忆）
- [ ] 记忆注入执行上下文
- [ ] 记忆在竞标中的权重

### Phase 4：高级特性

**目标**：打磨体验，增强自治能力。

- [ ] Agent 跨 Group 调动（带记忆迁移）
- [ ] Agent 主动创建任务
- [ ] Agent 间协作（一个 Agent 的输出作为另一个的输入）
- [ ] 记忆清理 & 维护策略
- [ ] Group 归档 & 历史回溯
- [ ] Agent 统计仪表盘
- [ ] Agent 模板（快速创建常用角色）

---

## 十四、安全考量

1. **资产访问控制**：Agent 只能访问自己绑定的资产路径，不可越权
2. **执行沙箱**：Agent 执行的工具调用受现有 workspace 隔离 + 审批机制保护
3. **记忆隔离**：Agent 记忆目录严格隔离，不可交叉访问
4. **任务权限**：Agent 只能 claim 所在 Group 的任务
5. **资源限制**：单 Agent 执行时间上限，防止无限循环
6. **敏感资产**：database 类型资产的连接串加密存储，使用时需审批

---

## 十五、Wild Idea：Agent 间的「经验传承」

> 这是讨论中提到的 "比较 wild 的想法"，值得深入设计。

### 15.1 概念

当一个 Agent 被调动到新 Group 时，它不仅带着自己的记忆，还可以将经验**传承**给新 Group 的其他 Agent。

```
前端专家在 "商城重构" Group 积累了大量经验
  ↓
调动到 "后台管理系统" Group
  ↓
新 Group 的后端专家发现一个前端相关任务
  ↓
前端专家的经验记忆被检索到，注入后端专家的执行上下文
  ↓
后端专家："根据前端专家的经验，这个 CORS 问题可以这样处理..."
```

### 15.2 实现机制

**Group 级记忆共享池：**

```typescript
interface GroupSharedMemory {
  groupId: string;
  contributions: {
    agentId: string;
    agentName: string;
    memories: AgentMemory[];       // 贡献的相关记忆（只读副本）
    contributedAt: string;
  }[];
}
```

**规则：**
- Agent 加入 Group 时，自动将与 Group 目标相关的记忆贡献到共享池
- 其他 Agent 在竞标/执行时，可检索共享池中的记忆
- 共享的是只读副本，不影响原 Agent 的记忆
- Agent 离开 Group 时，其贡献的记忆保留在共享池

### 15.3 Agent 的「成长轨迹」

每个 Agent 维护一个成长轨迹，记录它加入过的 Group 和积累的经验：

```typescript
interface AgentGrowthTrack {
  agentId: string;
  timeline: {
    groupId: string;
    groupName: string;
    joinedAt: string;
    leftAt?: string;
    tasksCompleted: number;
    keyExperiences: string[];      // 关键经验摘要
    skillsGained: string[];        // 习得的技能
  }[];
}
```

这让 Agent 真正像一个「员工」—— 它有履历，有经验，有成长。用户可以看到一个 Agent 的成长轨迹，了解它从哪些项目中积累了什么能力。

### 15.4 Agent 自我认知

Agent 在执行任务时，其 system prompt 中包含自我认知信息：

```markdown
## 你是谁
你是「前端专家」，一个专注于 React/TypeScript 的前端开发 Agent。

## 你的资产
- 📁 商城前端仓库 (/Users/cloud/projects/mall-frontend)
- 📄 React 最佳实践文档

## 你的经验
- 在"商城重构"项目中修复了 12 个前端 Bug，重构了支付模块
- 在"后台管理系统"项目中实现了权限管理 UI
- 擅长处理 CORS 问题和组件性能优化

## 你的工作方式
- 先读代码理解结构，再动手修改
- 修改后会自行运行相关测试
- 代码风格偏好函数式组件
```

这种自我认知让 Agent 在竞标和执行时能做出更准确的判断。

---

## 附录 A：术语表

| 术语 | 含义 |
|------|------|
| **Guild** | 公会，顶层工作台容器 |
| **Group** | 工作组，一组 Agent 围绕一个目标协作 |
| **GuildAgent** | 自治 Agent，有持久记忆和资产 |
| **Asset** | 资产，Agent 的知识载体（repo/doc/api 等） |
| **TaskBoard** | 任务看板，Group 级别的任务管理 |
| **Bid / Bidding** | 竞标，Agent 评估任务并出价 |
| **Confidence** | 置信度，Agent 对任务的把握程度 (0-1) |
| **Memory Settlement** | 记忆沉淀，任务完成后自动提取经验 |
| **Growth Track** | 成长轨迹，Agent 的履历和经验积累 |
| **Shared Memory Pool** | 共享记忆池，Group 级别的知识共享 |
