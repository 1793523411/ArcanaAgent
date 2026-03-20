# Team Mode 多智能体协作系统 — 设计文档

> 分支: `feat/agents_team`
> 最后更新: 2026-03-14

---

## 一、功能概述

Team Mode 将系统从"单 Agent 对话"升级为"多智能体团队协作"模式。用户创建对话时可选择 **default（默认）** 或 **team（团队）** 模式。在团队模式下，主 Agent 作为 **Coordinator（协调者）** 将任务分配给不同角色的子 Agent，并在 UI 侧提供实时的团队状态面板与审批流程。

### 核心价值

- 复杂任务可被拆解、分工、并行执行
- 角色化的子 Agent 各司其职，提升输出质量
- 高风险操作通过审批机制拦截，保障安全
- 用户可实时观察团队协作进度

---

## 二、系统架构

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (React)                     │
│  ┌───────────┐  ┌───────────┐  ┌────────────────────┐   │
│  │ WelcomeBox│  │ ChatPanel │  │    TeamPanel        │   │
│  │ 模式选择   │  │ Team按钮  │  │ ┌─Roster──────────┐│   │
│  └───────────┘  └───────────┘  │ │ 子Agent列表      ││   │
│                                │ ├─Approvals────────┤│   │
│  ┌─useSendMessage Hook─────┐  │ │ 审批卡片+操作按钮 ││   │
│  │ pendingApprovals state  │──▶│ └──────────────────┘│   │
│  │ streamingSubagents      │  │ └────────────────────┘   │
│  │ approval_request event  │                             │
│  │ approval_response event │                             │
│  └─────────────────────────┘                             │
└───────────────┬─────────────────────────────┬────────────┘
                │ SSE Stream                  │ REST API
                ▼                             ▼
┌─────────────────────────────────────────────────────────┐
│                     Backend (Express)                    │
│  ┌───────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  routes   │  │ agent/index  │  │ approvalManager │  │
│  │ /approvals│  │ Coordinator  │  │ 请求/审批/超时   │  │
│  └───────────┘  │  ↓ task tool │  └─────────────────┘  │
│                 │  ↓ spawn sub │                        │
│                 │  SubAgent    │  ┌─────────────────┐  │
│                 │  (per role)  │──▶│   roles.ts      │  │
│                 └──────────────┘  │ 角色配置+权限    │  │
│                                   └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 三、角色系统

### 3.1 角色定义 (`server/src/agent/roles.ts`)

| 角色 | 图标 | 颜色 | 禁用工具 | 职责 |
|------|------|------|----------|------|
| **Planner** | 📐 | `#3B82F6` 蓝色 | `write_file` | 分析任务、拆解子任务、识别依赖、输出结构化计划 |
| **Coder** | 💻 | `#10B981` 绿色 | 无 | 按计划实现代码变更、创建/修改文件 |
| **Reviewer** | 🔍 | `#8B5CF6` 紫色 | `write_file` | 审查代码、查找 bug 和安全问题、给出改进建议 |
| **Tester** | 🧪 | `#F59E0B` 黄色 | 无 | 运行测试、验证行为、编写测试用例 |

### 3.2 角色执行机制

```typescript
// 角色过滤工具
function filterToolsByRole(tools, role): tools
  → 移除 deniedTools 中列出的工具

// 角色专属 System Prompt
function buildSubagentSystemPrompt(role, skillContext): string
  → BASE_SYSTEM_PROMPT + MCP工具 + Skill目录 + 角色专属指令
```

### 3.3 协调者 Prompt (`TEAM_MODE_PROMPT`)

协调者在 team 模式下收到额外指令：

- **必须指定角色**：调用 `task` 工具时指定 `planner`/`coder`/`reviewer`/`tester`
- **编排模式**：
  - 简单任务 → 直接分配给对应角色
  - 代码+审查 → coder → reviewer → coder(修复)
  - 完整流水线 → planner → coder → reviewer → coder(修复) → tester
  - 并行工作 → 多个 coder 处理独立子任务 → tester 验证
- **进度管理**：维护团队名单、汇总子 Agent 输出、最终给出综合总结

---

## 四、审批系统

### 4.1 后端审批管理器 (`server/src/agent/approvalManager.ts`)

```
ApprovalManager
├── createRequest(params) → { requestId, promise }
│   └── 创建审批请求，启动 5 分钟超时定时器
├── resolveRequest(requestId, approved) → boolean
│   └── 批准/拒绝请求，清除定时器，resolve Promise
├── getPendingRequests(conversationId) → ApprovalRequest[]
│   └── 获取指定对话的所有待审批请求
└── hasPending(conversationId) → boolean
    └── 快速检查是否有待审批项
```

**审批请求结构：**

```typescript
interface ApprovalRequest {
  requestId: string;           // 唯一标识，如 apr_1710...
  conversationId: string;      // 所属对话
  subagentId: string;          // 发起审批的子 Agent
  role?: string;               // 子 Agent 角色
  operationType: string;       // 操作类型（如 run_command, write_file）
  operationDescription: string;// 风险描述
  details: Record<string, unknown>; // 操作参数
  createdAt: string;           // ISO 时间戳
  status: "pending" | "approved" | "rejected";
}
```

### 4.2 高风险检测规则

**命令风险检测 (`isHighRiskCommand`)：**

| 模式 | 匹配示例 |
|------|----------|
| `rm -rf` / `rm -r` | `rm -rf /tmp/data` |
| `git push --force` | `git push --force origin main` |
| `git reset --hard` | `git reset --hard HEAD~1` |
| `DROP TABLE/DATABASE` | `DROP TABLE users` |
| `DELETE FROM` | `DELETE FROM orders` |
| `TRUNCATE TABLE` | `TRUNCATE TABLE logs` |
| `git clean -f` | `git clean -fd` |
| `chmod 777` | `chmod 777 /var/www` |
| `kill -9` | `kill -9 1234` |

**文件写入风险检测 (`isHighRiskWrite`)：**

- 写入 workspace 目录之外的路径
- 写入敏感文件：`.env`, `credentials`, `.pem`, `.key`, `config.json`, `.gitignore`

### 4.3 审批工具包装 (`wrapToolWithApproval`)

```
原始工具调用 → getRiskDescription(input)
  ├── 无风险 → 直接执行
  └── 有风险 → createRequest() → 发送 approval_request 事件
                → 等待 Promise (用户批准/拒绝/5分钟超时)
                → 发送 approval_response 事件
                ├── approved → 执行原始工具
                └── rejected → 返回 "[blocked] Operation rejected by user"
```

### 4.4 REST API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/conversations/:id/approvals` | 获取指定对话的待审批请求列表 |
| `POST` | `/api/conversations/:id/approvals/:requestId` | 提交审批决策 `{ approved: boolean }` |

---

## 五、流式事件协议

Team Mode 在现有 SSE 流中扩展了 `subagent` 类型事件的 `kind` 字段：

### 5.1 子 Agent 事件类型 (`SubagentStreamEvent`)

| kind | 字段 | 说明 |
|------|------|------|
| `lifecycle` | phase, subagentId, subagentName, role, depth, prompt, summary, error | 子 Agent 生命周期（started/completed/failed） |
| `token` | subagentId, content | 子 Agent 文本输出增量 |
| `reasoning` | subagentId, content | 子 Agent 思考过程增量 |
| `plan` | subagentId + PlanStreamEvent | 子 Agent 执行计划 |
| `tool_call` | subagentId, name, input | 子 Agent 调用工具 |
| `tool_result` | subagentId, name, output | 子 Agent 工具返回 |
| `subagent_name` | subagentId, subagentName | AI 生成的子 Agent 语义名称 |
| `approval_request` | subagentId, requestId, operationType, operationDescription, details | **新增** — 高风险操作需要审批 |
| `approval_response` | subagentId, requestId, approved | **新增** — 审批结果 |

### 5.2 前端处理流程 (`useSendMessage.ts`)

```
SSE chunk (type=subagent)
  ├── kind=lifecycle → 更新 streamingSubagents 状态
  ├── kind=token/reasoning → 追加内容
  ├── kind=tool_call/tool_result → 更新工具日志
  ├── kind=plan → 更新执行计划
  ├── kind=subagent_name → 更新显示名
  ├── kind=approval_request → 添加到 pendingApprovals 数组
  └── kind=approval_response → 从 pendingApprovals 中移除
```

---

## 六、前端组件

### 6.1 WelcomeBox — 模式选择

- 新增 `mode` / `onModeChange` props
- 用户在创建对话前选择 `default` 或 `team` 模式
- 模式在对话创建后不可变（immutable）

### 6.2 ChatInputBar — 模式显示

- 接收 `mode` / `onModeChange` / `modeLocked` props
- 对话中模式锁定，显示当前模式但不可切换

### 6.3 ChatPanel — Team 按钮

- 当 `mode === "team"` 时，底部输入栏右侧显示 **Team** 按钮
- 点击切换 TeamPanel 侧边栏的显示/隐藏

### 6.4 TeamPanel — 团队状态面板

```
┌──────────────────────────┐
│ Team Panel          [✕]  │
├──────────────────────────┤
│ Progress                 │
│ [████████░░] 3/4 done    │
├──────────────────────────┤
│ ROSTER                   │
│ 📐 分析代码结构   ● done │
│ 💻 实现登录功能   ● work │
│ 🔍 审查代码      ● work  │
│ 🧪 运行测试      ○ wait  │
├──────────────────────────┤
│ APPROVALS (1)            │
│ ┌────────────────────┐   │
│ │ ⚠ run_command      │   │
│ │ rm -rf /tmp/build  │   │
│ │ 💻 实现登录功能     │   │
│ │ [Approve] [Reject] │   │
│ └────────────────────┘   │
└──────────────────────────┘
```

**组件 Props：**

```typescript
interface Props {
  streamingSubagents: SubagentInfo[];      // 实时流式子 Agent
  historicalSubagents: SubagentLog[];      // 历史子 Agent（最后一条 AI 消息）
  pendingApprovals: PendingApproval[];     // 待审批请求列表
  conversationId: string;                 // 当前对话 ID
  onClose: () => void;                    // 关闭面板
}
```

**功能：**

- **进度条**：已完成/总数百分比，100% 时变绿
- **角色名单**：按角色分组（planner → coder → reviewer → tester → unknown），显示图标、名称、角色、状态点（working=发光/completed=绿/failed=红）
- **审批卡片**：
  - 显示操作类型和风险描述
  - 显示发起审批的子 Agent 信息
  - Approve（绿色）/ Reject（红色）按钮
  - 按钮点击后调用 `submitApproval` API，期间显示 loading 状态
  - 审批完成后通过 `approval_response` 流事件自动移除卡片
  - 待审批数量角标

### 6.5 MessageBubble / StreamingBubble — 角色标识

- AI 消息和流式消息中，子 Agent 显示对应角色图标和颜色
- 通过 `getRoleConfig()` 获取角色配置

---

## 七、数据流

### 7.1 对话创建

```
用户选择 team 模式 → 点击发送
  → createConversation(title, mode="team")
  → 后端 storage 存储 mode 到 ConversationMeta
  → 返回 meta { id, title, mode: "team", ... }
```

### 7.2 消息发送（团队模式）

```
用户发送消息
  → POST /api/conversations/:id/messages { text, mode: "team" }
  → 后端检查 meta.mode === "team"
  → buildSystemPrompt(..., "team") 注入 TEAM_MODE_PROMPT
  → 主 Agent（Coordinator）调用 task 工具分配角色子任务
    → 子 Agent 创建（指定 role）
    → filterToolsByRole 过滤工具
    → buildSubagentSystemPrompt 构建角色提示词
    → wrapToolWithApproval 包装高风险工具
    → 子 Agent 执行
      ├── 普通操作 → 正常执行
      └── 高风险操作 → 审批流程 → 等待用户决策
    → 通过 onSubagentEvent 推送流式事件
  → 前端实时更新 TeamPanel
```

### 7.3 审批流程

```
子 Agent 执行高风险操作
  → wrapToolWithApproval 检测风险
  → approvalManager.createRequest() 创建审批
  → 发送 SSE: { type: "subagent", kind: "approval_request", ... }
  → 前端 useSendMessage 接收事件
  → pendingApprovals 状态更新
  → TeamPanel 渲染审批卡片
  → 用户点击 Approve/Reject
  → 前端调用 POST /api/.../approvals/:requestId { approved: true/false }
  → 后端 approvalManager.resolveRequest() resolve Promise
  → 发送 SSE: { type: "subagent", kind: "approval_response", ... }
  → 前端从 pendingApprovals 中移除
  → 子 Agent 继续执行（或收到 blocked 消息）
```

---

## 八、存储扩展

### ConversationMeta

```typescript
interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  mode?: ConversationMode;  // 新增：对话模式
}
```

### SubagentLog

```typescript
interface SubagentLog {
  subagentId: string;
  subagentName?: string;
  role?: AgentRole;          // 新增：角色类型
  depth: number;
  prompt: string;
  phase: "started" | "completed" | "failed";
  // ... 其他字段
}
```

---

## 九、文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `server/src/agent/roles.ts` | 角色配置（名称、颜色、图标、System Prompt、工具限制） |
| `server/src/agent/approvalManager.ts` | 审批管理器（创建/批准/拒绝/超时） |
| `web/src/components/TeamPanel.tsx` | 团队面板组件（名单+审批 UI） |
| `web/src/constants/roles.ts` | 前端角色显示配置 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `server/src/agent/index.ts` | 集成角色系统、审批工具包装、TEAM_MODE_PROMPT、子 Agent 角色分配 |
| `server/src/api/routes.ts` | 新增审批 API 端点、对话创建支持 mode 参数 |
| `server/src/storage/index.ts` | ConversationMeta 增加 mode 字段 |
| `server/src/index.ts` | 注册审批路由 |
| `web/src/types/index.ts` | 新增 ConversationMode、AgentRole 类型，SubagentLog 增加 role 字段 |
| `web/src/api/index.ts` | 新增 getPendingApprovals、submitApproval API 函数 |
| `web/src/hooks/useSendMessage.ts` | 处理 approval_request/response 事件，暴露 pendingApprovals |
| `web/src/App.tsx` | 传递 pendingApprovals 和 conversationId 给 TeamPanel |
| `web/src/components/ChatPanel.tsx` | 新增 Team 按钮 |
| `web/src/components/ChatInputBar.tsx` | 支持 mode/onModeChange/modeLocked props |
| `web/src/components/WelcomeBox.tsx` | 支持对话模式选择 |
| `web/src/components/MessageBubble.tsx` | 显示子 Agent 角色图标和颜色 |
| `web/src/components/StreamingBubble.tsx` | 显示子 Agent 角色图标和颜色 |

---

## 十、安全考量

1. **审批超时**：5 分钟无响应自动拒绝，防止子 Agent 无限阻塞
2. **审批仅存内存**：服务器重启后审批状态丢失（当前设计限制）
3. **角色工具限制**：Planner 和 Reviewer 无法写文件，仅能读取
4. **模式不可变**：对话创建后模式锁定，防止运行时切换导致的不一致
5. **Workspace 隔离**：写入操作限制在对话 workspace 目录内
6. **高风险正则**：基于正则匹配，存在误报/漏报可能，建议后续增加白名单机制

---

## 十一、未来扩展方向

- **审批持久化**：将审批记录写入磁盘，支持服务重启后恢复
- **审批审计日志**：记录所有审批决策（谁在什么时候批准/拒绝了什么操作）
- **自定义角色**：支持用户自定义角色的名称、系统提示词、工具权限
- **角色权限模型**：从黑名单（deniedTools）升级为白名单 + 黑名单混合模式
- **WebSocket 推送**：替代轮询，实现审批请求的实时推送
- **审批策略配置**：支持按角色/操作类型配置自动批准规则
- **团队模板**：预定义的团队编排模板（如"代码审查流水线"、"TDD 开发流程"）
