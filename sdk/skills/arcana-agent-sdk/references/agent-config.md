# 第 2 章：Agent 配置全解

`createAgent(config: AgentConfig)` 是 SDK 的入口函数，返回一个 `ArcanaAgent` 实例。本章详解 `AgentConfig` 的所有字段。

## AgentConfig 完整定义

```typescript
interface AgentConfig {
  model: ModelConfig;              // 必填 — 模型配置
  modelAdapter?: ModelAdapter;     // 可选 — 注入自定义模型适配器（覆盖内置 adapter）
  tools?: ToolConfig;              // 工具配置
  skills?: SkillConfig;            // Skill 技能配置
  mcpServers?: McpServerConfig[];  // MCP 服务器列表
  systemPrompt?: string;           // 自定义系统提示词（覆盖默认）
  workspacePath?: string;          // 工作区路径（文件操作沙箱）
  maxRounds?: number;              // 最大工具调用轮数（默认 200）
  planningEnabled?: boolean;       // 是否启用规划模式（默认 false）
  harnessConfig?: HarnessConfig;   // Harness 安全护栏配置
  outerRetry?: OuterRetryConfig;   // 外层重试配置（需配合 harnessConfig）
  abortSignal?: AbortSignal;       // 中断信号
}
```

---

## model（必填）

```typescript
interface ModelConfig {
  provider: "openai" | "anthropic";  // 模型提供商
  apiKey: string;                    // API Key
  modelId: string;                   // 模型 ID
  baseUrl?: string;                  // API 基础 URL
  reasoning?: boolean;               // 是否为推理模型（默认 false）
  temperature?: number;              // 温度参数
  maxTokens?: number;                // 最大生成 token 数
}
```

### provider

| 值 | 说明 | 适用模型 |
|:---|:---|:---|
| `"openai"` | OpenAI 兼容 API | GPT-4o, GPT-4, DeepSeek, Doubao, Qwen, Moonshot 等 |
| `"anthropic"` | Anthropic 原生 API | Claude 3.5 Sonnet, Claude 3 Opus 等 |

> **重要**：所有 OpenAI 兼容的模型（火山引擎 / DeepSeek / Moonshot / 通义千问等）都使用 `provider: "openai"`，通过 `baseUrl` 指定不同的 API 地址。

### baseUrl

- `"openai"` provider 默认值：`https://api.openai.com/v1`
- `"anthropic"` provider 默认值：`https://api.anthropic.com`

常见 baseUrl 示例：

```typescript
// 火山引擎（Doubao）
baseUrl: "https://ark.cn-beijing.volces.com/api/v3"

// DeepSeek
baseUrl: "https://api.deepseek.com/v1"

// Moonshot（月之暗面）
baseUrl: "https://api.moonshot.cn/v1"
```

### reasoning

设为 `true` 时：

- **OpenAI provider**：启用原生推理流（`streamSingleTurn`），支持 `reasoning_token` 事件
- **Anthropic provider**：启用 Claude 的 `thinking` 模式（`budget_tokens: 8000`）
- **温度自动设为 1**（推理模型通常需要 temperature=1）

### temperature 与 maxTokens

| 参数 | OpenAI 默认值 | Anthropic 默认值（普通）| Anthropic 默认值（推理）|
|:---|:---|:---|:---|
| `temperature` | `0`（普通）/ `1`（推理） | `0` | `1` |
| `maxTokens` | 不限制 | `8192` | `16000` |

```typescript
// 创意写作场景
model: {
  provider: "openai",
  apiKey: "sk-xxx",
  modelId: "gpt-4o",
  temperature: 0.9,
  maxTokens: 2000,
}
```

---

## modelAdapter（可选）

注入自定义的 `ModelAdapter` 实现，**完全替代**内置的 OpenAI/Anthropic adapter。适用于内部私有模型网关、非标 API 协议（如 OpenAI Responses API）、自定义认证方式等场景。

```typescript
import type { ModelAdapter } from "arcana-agent-sdk";

createAgent({
  model: { provider: "openai", apiKey: "placeholder", modelId: "my-model" },
  modelAdapter: myCustomAdapter,
});
```

- 当 `modelAdapter` 存在时，`model` 中的 `provider`、`baseUrl`、`apiKey` 不会被使用
- `model` 字段仍需提供（类型约束），`model.modelId` 建议与 adapter 的 `modelId` 保持一致
- 自定义 adapter 需实现 `ModelAdapter` 接口的全部方法

> 详见 → [模型适配器 — 自定义 ModelAdapter](./model-adapter.md#自定义-modeladapter注入非标模型)

---

## tools

```typescript
interface ToolConfig {
  builtinTools?: BuiltinToolId[];          // 显式指定要使用的内置工具列表
  excludeTools?: BuiltinToolId[];          // 从默认工具集中排除
  customTools?: StructuredToolInterface[]; // 自定义工具
}
```

### 三种配置方式

**方式一：使用默认工具集**（不传 tools，自动加载 10 个默认工具）

```typescript
createAgent({ model, workspacePath: "/path" });
// 默认工具: read_file, write_file, edit_file, run_command,
//           search_code, list_files, git_operations, test_runner,
//           get_time, fetch_url
```

**方式二：显式指定**（只加载你列出的工具）

```typescript
createAgent({
  model,
  tools: { builtinTools: ["read_file", "list_files", "get_time"] },
});
```

**方式三：排除指定工具**

```typescript
createAgent({
  model,
  tools: { excludeTools: ["run_command", "git_operations"] },
});
```

**添加自定义工具**

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const myTool = tool(
  async (input: { query: string }) => {
    return JSON.stringify(await db.query(input.query));
  },
  {
    name: "query_database",
    description: "执行 SQL 查询",
    schema: z.object({ query: z.string().describe("SQL 语句") }),
  },
);

createAgent({
  model,
  tools: {
    builtinTools: ["read_file"],
    customTools: [myTool],
  },
});
```

> 详见 → [工具系统](./tools.md)

---

## skills

```typescript
interface SkillConfig {
  dirs?: string[];         // Skill 目录列表（自动扫描 SKILL.md）
  skills?: Array<{         // 手动指定 Skill 元信息
    name: string;
    description: string;
    dirPath: string;
  }>;
}
```

```typescript
createAgent({
  model,
  skills: {
    dirs: ["/path/to/skills"],  // 目录下每个包含 SKILL.md 的子目录是一个 Skill
  },
});
```

> 详见 → [Skill 技能系统](./skills.md)

---

## mcpServers

```typescript
type McpServerConfig =
  | { name: string; transport: "stdio";           command: string; args: string[]; env?: Record<string, string> }
  | { name: string; transport: "streamablehttp";  url: string; headers?: Record<string, string> };
```

```typescript
createAgent({
  model,
  mcpServers: [
    {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_xxx" },
    },
    {
      name: "麦当劳",
      transport: "streamablehttp",
      url: "https://mcp.mcd.cn",
      headers: { Authorization: "Bearer xxx" },
    },
  ],
});
```

> 详见 → [MCP 协议集成](./mcp.md)

---

## systemPrompt

覆盖 SDK 内置的系统提示词。内置提示词已经包含了工具使用策略、安全规则、错误处理、Skill 使用规范等内容，**通常不建议完全替换**。

```typescript
// 完全替换系统提示词
createAgent({
  model,
  systemPrompt: "你是一个 Python 专家，只用中文回答，代码用 Python 实现。",
});
```

> **提示**：即使你替换了 systemPrompt，SDK 仍会自动追加以下内容：
> - `## Environment`（当前时间、时区、平台）
> - `## Current Workspace`（workspace 路径约束）
> - `## Available MCP Tools`（如果配置了 MCP）
> - Skill 目录信息（如果配置了 Skills）

---

## workspacePath

指定 Agent 的工作目录。设置后：

1. 所有文件操作工具的路径会自动基于此目录解析
2. 写入/编辑操作会被沙箱限制在此目录内
3. 系统提示词会包含 workspace 约束指令

```typescript
createAgent({
  model,
  workspacePath: "/Users/me/projects/my-app",
});
```

> **安全**：不设置 `workspacePath` 时，文件工具不会做路径限制。生产环境建议始终设置。

---

## maxRounds

Agent 的工具调用最大轮数，默认 `200`。每一轮 = 一次 LLM 调用 + 工具执行。

```typescript
// 限制为 5 轮（适合简单任务）
createAgent({ model, maxRounds: 5 });

// 设为 1（纯对话，不允许工具调用后继续）
createAgent({ model, maxRounds: 1, tools: { builtinTools: [] } });
```

达到 maxRounds 时：
- 如果最后一轮没有文本输出，SDK 会自动调用模型生成一段总结
- 事件流发出 `{ type: "stop", reason: "max_rounds" }`

---

## planningEnabled

启用后，Agent 在执行前会先调用模型生成执行计划，然后按计划逐步执行：

```typescript
createAgent({
  model,
  planningEnabled: true,
  workspacePath: "/path/to/project",
});
```

> 详见 → [规划与 Harness](./planning-harness.md)

---

## harnessConfig

安全护栏配置，需配合 `planningEnabled: true` 使用：

```typescript
import { DEFAULT_HARNESS_CONFIG } from "arcana-agent-sdk";

createAgent({
  model,
  planningEnabled: true,
  harnessConfig: {
    ...DEFAULT_HARNESS_CONFIG,
    evalEnabled: true,           // 启用 eval guard（执行质量评估）
    loopDetectionEnabled: true,  // 启用循环检测
    replanEnabled: true,         // 启用自动重规划
    maxReplanAttempts: 2,        // 最多重规划 2 次
  },
});
```

启用 `harnessConfig` 后，SDK 会自动向 system prompt 注入 Harness 增强指令（Evidence-Driven Execution、Loop Detection 提示、Dynamic Replanning 指令），让 Agent 感知到中间件的存在，显著提升 harness 效果。

执行过程中的 eval 结果、循环检测和重规划决策会通过 `harness` 事件实时推送。

> 详见 → [规划与 Harness](./planning-harness.md)

---

## outerRetry

外层重试配置，需配合 `harnessConfig` 使用。当内层 replan 次数耗尽但问题仍未解决时，自动整体重新运行一轮 agent 执行：

```typescript
interface OuterRetryConfig {
  maxOuterRetries?: number;      // 最大外层重试次数（默认 2）
  autoApproveReplan?: boolean;   // 是否自动批准重规划（会覆盖 harnessConfig.autoApproveReplan）
}
```

```typescript
createAgent({
  model,
  planningEnabled: true,
  harnessConfig: {
    ...DEFAULT_HARNESS_CONFIG,
    evalEnabled: true,
    loopDetectionEnabled: true,
    replanEnabled: true,
  },
  outerRetry: {
    maxOuterRetries: 2,
    autoApproveReplan: true,
  },
});
```

启用后：
- `stream()` 自动走外层重试路径
- 每轮迭代结束后检查是否有未解决的 eval fail 或 loop detection
- 下一轮迭代会注入历史失败摘要，避免重复失败策略
- 通过 `harness_driver` 事件推送生命周期状态（`started` → `iteration_start` → `iteration_end` → `completed` / `max_retries_reached`）

> 详见 → [规划与 Harness](./planning-harness.md)

---

## abortSignal

传入 `AbortSignal` 可在外部中断 Agent 执行：

```typescript
const controller = new AbortController();

const agent = createAgent({
  model,
  abortSignal: controller.signal,
});

// 5 秒后中断
setTimeout(() => controller.abort(), 5000);

for await (const event of agent.stream("执行一个很长的任务...")) {
  if (event.type === "stop") {
    console.log(event.reason); // "aborted"
  }
}
```

中断时的行为：
- 当前 LLM 调用会被取消
- 当前工具执行会返回 `[aborted] Execution cancelled`
- 事件流发出 `{ type: "stop", reason: "aborted" }`

---

## 配置组合示例

### 最小配置

```typescript
createAgent({ model: { provider: "openai", apiKey: "sk-xxx", modelId: "gpt-4o" } });
```

### 生产环境推荐配置

```typescript
createAgent({
  model: {
    provider: "openai",
    apiKey: process.env.LLM_API_KEY!,
    modelId: "gpt-4o",
    baseUrl: process.env.LLM_BASE_URL,
  },
  workspacePath: "/app/workspace",
  tools: { excludeTools: ["run_command"] },
  maxRounds: 50,
  planningEnabled: true,
  harnessConfig: {
    ...DEFAULT_HARNESS_CONFIG,
    evalEnabled: true,
    loopDetectionEnabled: true,
    replanEnabled: true,
  },
  outerRetry: { maxOuterRetries: 2, autoApproveReplan: true },
  abortSignal: requestAbortSignal,
});
```

### 纯对话（无工具）

```typescript
createAgent({
  model: { provider: "openai", apiKey: "sk-xxx", modelId: "gpt-4o" },
  tools: { builtinTools: [] },
  maxRounds: 1,
});
```
