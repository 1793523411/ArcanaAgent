---
name: arcana-agent-sdk
description: Arcana Agent SDK 完整使用指南。当用户需要使用 arcana-agent-sdk 创建 AI Agent、配置模型/工具/Skills/MCP、处理流式事件、构建 SSE 服务端、或排查 SDK 使用问题时，必须使用此 Skill。也适用于涉及 createAgent、ArcanaAgent、buildToolSet、createModelAdapter、McpManager 等 API 的任何场景。
---

# Arcana Agent SDK

Node.js >= 18 | TypeScript ESM | 版本 0.1.0

Arcana Agent SDK 是一个功能完备的 AI Agent 开发库，支持多模型、流式输出、工具调用、自动规划、Skill 技能系统和 MCP 协议。

```
┌─────────────────────────────────────────────┐
│                  你的应用                      │
│         (Express / Koa / CLI / ...)          │
├─────────────────────────────────────────────┤
│              arcana-agent-sdk               │
│  ┌──────────┐ ┌───────┐ ┌───────┐ ┌─────┐  │
│  │  Agent   │ │ Tools │ │Skills │ │ MCP │  │
│  │(stream/  │ │(14 内置│ │(SKILL │ │(stdio│  │
│  │ run)     │ │+自定义)│ │ .md)  │ │/http)│  │
│  └────┬─────┘ └───┬───┘ └───┬───┘ └──┬──┘  │
│       │           │         │        │      │
│  ┌────┴───────────┴─────────┴────────┴──┐   │
│  │          ModelAdapter                 │   │
│  │  (OpenAI / Anthropic / 火山引擎)       │   │
│  └───────────────────────────────────────┘   │
├─────────────────────────────────────────────┤
│             @arcana-agent/core              │
│       (纯逻辑层 — 工具定义/规划/Harness)       │
└─────────────────────────────────────────────┘
```

## 安装

```bash
npm install arcana-agent-sdk
```

前置要求：Node.js >= 18、ESM 项目（`"type": "module"`）、至少一个 LLM API Key。

## 快速开始

```typescript
import { createAgent } from "arcana-agent-sdk";

const agent = createAgent({
  model: { provider: "openai", apiKey: "sk-xxx", modelId: "gpt-4o" },
  workspacePath: "/path/to/workspace",
});

for await (const event of agent.stream("帮我分析这个项目的结构")) {
  if (event.type === "token") process.stdout.write(event.content);
  if (event.type === "tool_call") console.log(`🔧 ${event.name}`);
  if (event.type === "stop") console.log(`\n✅ ${event.reason}`);
}
```

同步模式：
```typescript
const result = await agent.run("1+1等于几？");
// result.content, result.stopReason, result.toolCallCount, result.usage, result.messages
```

## AgentConfig 完整定义

```typescript
interface AgentConfig {
  model: ModelConfig;              // 必填 — 模型配置
  tools?: ToolConfig;              // 工具配置
  skills?: SkillConfig;            // Skill 技能配置
  mcpServers?: McpServerConfig[];  // MCP 服务器列表
  systemPrompt?: string;           // 自定义系统提示词（覆盖默认）
  workspacePath?: string;          // 工作区路径（文件操作沙箱）
  maxRounds?: number;              // 最大工具调用轮数（默认 200）
  planningEnabled?: boolean;       // 是否启用规划模式（默认 false）
  harnessConfig?: HarnessConfig;   // Harness 安全护栏
  outerRetry?: OuterRetryConfig;   // 外层重试（需配合 harnessConfig 使用）
  abortSignal?: AbortSignal;       // 中断信号
}
```

### ModelConfig

```typescript
interface ModelConfig {
  provider: "openai" | "anthropic";  // 所有 OpenAI 兼容 API（火山/DeepSeek/Moonshot 等）用 "openai"
  apiKey: string;
  modelId: string;
  baseUrl?: string;       // 默认: openai→api.openai.com/v1, anthropic→api.anthropic.com
  reasoning?: boolean;    // 启用推理模式（出现 reasoning_token 事件）
  temperature?: number;   // 默认 0，推理模式下自动设为 1
  maxTokens?: number;     // Anthropic 普通默认 8192，推理默认 16000
}
```

常见 baseUrl：
- 火山引擎: `https://ark.cn-beijing.volces.com/api/v3`
- DeepSeek: `https://api.deepseek.com/v1`
- Moonshot: `https://api.moonshot.cn/v1`

### ToolConfig

```typescript
interface ToolConfig {
  builtinTools?: BuiltinToolId[];          // 显式指定（会覆盖默认集）
  excludeTools?: BuiltinToolId[];          // 从默认集排除
  customTools?: StructuredToolInterface[]; // LangChain tool() 创建的自定义工具
}
```

三种模式：
1. 不传 tools → 使用 10 个默认工具
2. `builtinTools: [...]` → 只加载指定的
3. `excludeTools: [...]` → 从默认集排除

builtinTools 和 excludeTools 不能同时用。空数组 `builtinTools: []` = 无工具模式。

### SkillConfig / McpServerConfig / HarnessConfig

深度配置见 `<SKILL_PATH>/references/` 下的参考文件。

## 内置工具一览

### 默认工具（10 个，不传 tools 时自动加载）

| 工具名 | 功能 | 类型 |
|:---|:---|:---|
| `read_file` | 读取文件内容 | 只读 |
| `write_file` | 创建/覆盖写入文件 | 写入 |
| `edit_file` | 基于 SEARCH/REPLACE 的精准编辑 | 写入 |
| `run_command` | 执行 shell 命令 | 写入 |
| `search_code` | 基于 ripgrep 的代码搜索 | 只读 |
| `list_files` | 列出目录文件 | 只读 |
| `git_operations` | Git 操作（status/diff/log 等）| 写入 |
| `test_runner` | 运行测试 | 写入 |
| `get_time` | 获取当前时间 | 只读 |
| `fetch_url` | 抓取 URL 内容 | 只读 |

### 扩展工具（需在 builtinTools 中显式指定）

| 工具名 | 功能 | 类型 |
|:---|:---|:---|
| `web_search` | 网页搜索 | 只读 |
| `background_run` | 启动后台进程 | 写入 |
| `background_check` | 查询后台进程状态/输出 | 只读 |
| `background_cancel` | 取消后台进程 | 写入 |

### 动态工具（配置 skills 时自动加入）

| 工具名 | 功能 | 类型 |
|:---|:---|:---|
| `load_skill` | 加载 Skill 技能 | 只读 |

### Workspace 沙箱

设置 workspacePath 后：
- 相对路径自动基于 workspace 解析
- 写入操作（write_file/edit_file/test_runner）限制在 workspace 内
- 读取操作（read_file/search_code/list_files）限制在 workspace + allowedDirs（Skill 目录）
- fetch_url/get_time 不涉及文件路径，不受限制

### 工具执行策略

- 只读工具：并行执行
- 写入工具：串行执行
- 混合：先并行只读，再串行写入
- 错误级联检测：连续 3 轮 ≥50% 工具失败 → 停止

### 自定义工具

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const myTool = tool(
  async (input: { query: string }) => JSON.stringify(await db.query(input.query)),
  {
    name: "query_database",
    description: "执行 SQL 查询",
    schema: z.object({ query: z.string().describe("SQL 语句") }),
  },
);

createAgent({ model, tools: { customTools: [myTool] } });
```

自定义工具要点：description 要详细、schema 用 Zod .describe()、返回 string、内部 try-catch。

## 流式事件系统

10 种事件类型：

| 类型 | 说明 | 关键字段 |
|:---|:---|:---|
| `token` | 模型输出文本 | `content: string` |
| `reasoning_token` | 推理思考过程（仅 reasoning:true） | `content: string` |
| `tool_call` | 工具调用开始 | `id, name, arguments` |
| `tool_result` | 工具执行结果 | `id, name, result` |
| `plan_update` | 计划更新（仅 planningEnabled:true） | `steps[], currentStepIndex` |
| `usage` | Token 用量 | `promptTokens, completionTokens, totalTokens` |
| `harness` | Harness 护栏事件（eval/循环检测/重规划） | `event: HarnessEvent` |
| `harness_driver` | 外层重试生命周期事件 | `phase, iteration, maxRetries` |
| `stop` | 流结束 | `reason: StopReason` |
| `error` | 错误 | `message, recoverable` |

StopReason 枚举：`completed` | `aborted` | `max_rounds` | `model_error` | `harness_abort` | `tool_error_cascade` | `context_overflow` | `empty_response`

### 完整事件处理模板

```typescript
for await (const event of agent.stream("你的问题")) {
  switch (event.type) {
    case "token":           process.stdout.write(event.content); break;
    case "reasoning_token": process.stderr.write(`[思考] ${event.content}`); break;
    case "tool_call":       console.log(`🔧 ${event.name}(${JSON.stringify(event.arguments)})`); break;
    case "tool_result":     console.log(`📋 ${event.result.slice(0, 200)}`); break;
    case "plan_update":     console.log(`📋 ${event.steps.filter(s=>s.status==="completed").length}/${event.steps.length}`); break;
    case "usage":           console.log(`📊 tokens: ${event.totalTokens}`); break;
    case "harness":         console.log(`🛡️ harness: ${event.event.kind}`); break;
    case "harness_driver":  console.log(`🔄 driver: ${event.phase} (${event.iteration}/${event.maxRetries})`); break;
    case "error":           console.error(`❌ ${event.recoverable?"可恢复":"致命"}: ${event.message}`); break;
    case "stop":            console.log(`✅ ${event.reason}`); break;
  }
}
```

### 多轮对话

```typescript
const r1 = await agent.run("创建一个 hello.txt");
const history = r1.messages;
history.push(new HumanMessage("把内容改成 Hello World"));
const r2 = await agent.run(history);
```

### Express SSE 集成

```typescript
app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const agent = createAgent({ model, workspacePath: "/app/workspace" });
  for await (const event of agent.stream(req.body.message)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
});
```

## 配置组合示例

### 最小配置
```typescript
createAgent({ model: { provider: "openai", apiKey: "sk-xxx", modelId: "gpt-4o" } });
```

### 生产环境
```typescript
createAgent({
  model: { provider: "openai", apiKey: process.env.LLM_API_KEY!, modelId: "gpt-4o", baseUrl: process.env.LLM_BASE_URL },
  workspacePath: "/app/workspace",
  tools: { excludeTools: ["run_command"] },
  maxRounds: 50,
  planningEnabled: true,
  harnessConfig: { ...DEFAULT_HARNESS_CONFIG, evalEnabled: true, loopDetectionEnabled: true, replanEnabled: true },
  outerRetry: { maxOuterRetries: 3, autoApproveReplan: true },
  abortSignal: requestAbortSignal,
});
```

### 纯对话（无工具）
```typescript
createAgent({ model, tools: { builtinTools: [] }, maxRounds: 1 });
```

### 推理模型 + 流式
```typescript
const agent = createAgent({
  model: { provider: "openai", apiKey: "sk-xxx", modelId: "doubao-seed-2-0-mini-260215",
           baseUrl: "https://ark.cn-beijing.volces.com/api/v3", reasoning: true },
});
for await (const event of agent.stream("证明根号2是无理数")) {
  if (event.type === "reasoning_token") process.stderr.write(event.content);
  if (event.type === "token") process.stdout.write(event.content);
}
```

## 深度参考

所有详细文档都在 `<SKILL_PATH>/references/` 目录下，按需阅读：

| 主题 | 参考文件 | 何时阅读 |
|:---|:---|:---|
| 快速开始 | `<SKILL_PATH>/references/getting-started.md` | 安装步骤、最小示例、同步/流式/SSE 详细用法、火山引擎配置 |
| Agent 配置 | `<SKILL_PATH>/references/agent-config.md` | AgentConfig 每个字段的详细说明、systemPrompt 拼接规则、配置组合示例 |
| 流式事件 | `<SKILL_PATH>/references/streaming-events.md` | stream() vs run() 区别、多轮对话、事件时序图、真流式 vs 假流式 |
| 工具系统 | `<SKILL_PATH>/references/tools.md` | 工具配置模式详解、自定义工具最佳实践、buildToolSet 独立使用、后台工具 |
| 模型适配器 | `<SKILL_PATH>/references/model-adapter.md` | 独立使用 ModelAdapter、推理流实现、StreamReasoningResult 类型、Token Cap |
| 规划与 Harness | `<SKILL_PATH>/references/planning-harness.md` | planningEnabled/harnessConfig、eval guard/循环检测/重规划、外层重试/prompt 增强注入、上下文管理（pruning 5 级） |
| Skill 技能系统 | `<SKILL_PATH>/references/skills.md` | 创建 SKILL.md、配置 SkillConfig、load_skill 工具、`<SKILL_PATH>` 占位符 |
| MCP 协议集成 | `<SKILL_PATH>/references/mcp.md` | McpServerConfig（stdio/streamablehttp）、工具命名规则 `mcp_{server}__{tool}`、McpManager |
| 完整 API 参考 | `<SKILL_PATH>/references/api-reference.md` | 所有导出函数/类/类型签名、ModelAdapter 接口、事件子类型、BuiltinToolId |
