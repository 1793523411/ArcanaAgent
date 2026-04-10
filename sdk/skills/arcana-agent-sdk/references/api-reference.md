# 第 9 章：完整 API 参考

本章列出 Arcana Agent SDK 所有导出的函数、类和类型。

---

## 导出总览

```typescript
import {
  // 核心函数
  createAgent,
  createModelAdapter,
  buildToolSet,
  listBuiltinToolIds,
  isReadOnlyTool,

  // Skill 函数
  loadSkillsFromDirs,
  loadSkillsFromMetas,
  buildSkillCatalog,
  createLoadSkillTool,

  // 类
  ArcanaAgent,
  McpManager,

  // 常量
  DEFAULT_HARNESS_CONFIG,

  // 类型
  type AgentConfig,
  type AgentEvent,
  type AgentEventType,
  type TokenEvent,
  type ReasoningTokenEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type PlanUpdateEvent,
  type UsageEvent,
  type StopEvent,
  type ErrorEvent,
  type AgentRunResult,
  type ModelConfig,
  type ModelProvider,
  type ModelAdapter,
  type ChatModel,
  type StreamReasoningResult,
  type ToolCallResult,
  type TokenUsage,
  type ToolConfig,
  type SkillConfig,
  type SkillMeta,
  type SkillFull,
  type McpServerConfig,
  type HarnessConfig,
  type StopReason,
  type BuiltinToolId,
} from "arcana-agent-sdk";
```

---

## 核心函数

### createAgent

```typescript
function createAgent(config: AgentConfig): ArcanaAgent
```

创建 Agent 实例。这是 SDK 的主入口。

**参数**：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| `model` | `ModelConfig` | ✅ | — | 模型配置 |
| `tools` | `ToolConfig` | 否 | 全部默认工具 | 工具配置 |
| `skills` | `SkillConfig` | 否 | — | Skill 目录配置 |
| `mcpServers` | `McpServerConfig[]` | 否 | — | MCP 服务器列表 |
| `systemPrompt` | `string` | 否 | 内置提示词 | 自定义系统提示词 |
| `workspacePath` | `string` | 否 | — | 工作区路径 |
| `maxRounds` | `number` | 否 | `200` | 最大工具调用轮数 |
| `planningEnabled` | `boolean` | 否 | `false` | 启用规划模式 |
| `harnessConfig` | `HarnessConfig` | 否 | — | Harness 护栏配置 |
| `abortSignal` | `AbortSignal` | 否 | — | 中断信号 |

**返回**：`ArcanaAgent` 实例

---

### createModelAdapter

```typescript
function createModelAdapter(config: ModelConfig): ModelAdapter
```

创建模型适配器，可独立使用（不需要创建 Agent）。

**参数**：

| 字段 | 类型 | 必填 | 说明 |
|:---|:---|:---|:---|
| `provider` | `"openai" \| "anthropic"` | ✅ | 模型提供商 |
| `apiKey` | `string` | ✅ | API Key |
| `modelId` | `string` | ✅ | 模型 ID |
| `baseUrl` | `string` | 否 | API 基础 URL |
| `reasoning` | `boolean` | 否 | 是否为推理模型 |
| `temperature` | `number` | 否 | 温度参数 |
| `maxTokens` | `number` | 否 | 最大 token 数 |

**返回**：`ModelAdapter` 对象

---

### buildToolSet

```typescript
function buildToolSet(
  config?: ToolConfig,
  workspacePath?: string,
  allowedDirs?: string[]
): StructuredToolInterface[]
```

构建工具集，可独立使用。

**参数**：

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `config` | `ToolConfig` | 工具配置（可选） |
| `workspacePath` | `string` | 工作区路径（可选） |
| `allowedDirs` | `string[]` | 额外允许访问的目录（可选） |

**返回**：LangChain `StructuredToolInterface` 数组

---

### listBuiltinToolIds

```typescript
function listBuiltinToolIds(): string[]
```

返回 core 注册表中所有内置工具的 ID 列表。

> **注意**：返回类型是 `string[]` 而不是 `BuiltinToolId[]`，因为 core 注册表以字符串键值管理工具。

**返回**：

```typescript
["run_command", "read_file", "write_file", "edit_file", "search_code",
 "list_files", "git_operations", "test_runner", "web_search", "get_time",
 "fetch_url", "background_run", "background_check", "background_cancel"]
```

---

### isReadOnlyTool

```typescript
function isReadOnlyTool(toolName: string): boolean
```

判断指定工具是否为只读工具（不会对文件系统产生写入操作）。

只读工具集合：`read_file`, `search_code`, `list_files`, `get_time`, `web_search`, `fetch_url`, `load_skill`, `background_check`

---

### Skill 函数

```typescript
function loadSkillsFromDirs(dirs: string[]): SkillMeta[]
function loadSkillsFromMetas(metas: Array<{ name: string; description: string; dirPath: string }>): SkillMeta[]
function buildSkillCatalog(skills: SkillMeta[]): string
function createLoadSkillTool(skills: SkillMeta[]): StructuredToolInterface
```

Skill 加载和管理的底层函数，通常由 Agent 内部调用。详见 [第 7 章：Skills](./07-skills.md)。

---

## 类

### ArcanaAgent

```typescript
class ArcanaAgent {
  // 流式调用
  async *stream(input: string | BaseMessage[]): AsyncGenerator<AgentEvent>;

  // 同步调用
  async run(input: string | BaseMessage[]): Promise<AgentRunResult>;

  // 清理资源（MCP 连接等）
  async destroy(): Promise<void>;
}
```

#### stream()

```typescript
async *stream(input: string | BaseMessage[]): AsyncGenerator<AgentEvent>
```

流式执行 Agent，逐个 yield 事件。

**参数**：
- `input: string` — 用户消息文本
- `input: BaseMessage[]` — 消息数组（多轮对话场景，包含 `HumanMessage` / `AIMessage`）

**yield**：`AgentEvent`（8 种事件类型）

#### run()

```typescript
async run(input: string | BaseMessage[]): Promise<AgentRunResult>
```

同步执行 Agent，返回聚合结果。

**参数**：同 `stream()`

**返回**：

```typescript
interface AgentRunResult {
  content: string;        // 所有 token 拼接的完整文本
  stopReason: StopReason; // 停止原因
  toolCallCount: number;  // 工具调用总次数
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  messages: BaseMessage[]; // 完整消息历史
}
```

#### destroy()

```typescript
async destroy(): Promise<void>
```

清理所有资源，包括 MCP 连接。使用了 `mcpServers` 的 Agent 应在结束后调用。

---

### McpManager

```typescript
class McpManager {
  async connect(servers: McpServerConfig[]): Promise<void>;
  getTools(): StructuredToolInterface[];
  async disconnectAll(): Promise<void>;
}
```

#### connect()

连接 MCP 服务器列表。每个服务器的工具会自动转换为 LangChain 工具。

#### getTools()

返回所有已连接服务器的工具列表。

#### disconnectAll()

断开所有 MCP 连接并清理资源。

---

## 类型定义

### AgentConfig

```typescript
interface AgentConfig {
  model: ModelConfig;
  tools?: ToolConfig;
  skills?: SkillConfig;
  mcpServers?: McpServerConfig[];
  systemPrompt?: string;
  workspacePath?: string;
  maxRounds?: number;
  planningEnabled?: boolean;
  harnessConfig?: HarnessConfig;
  abortSignal?: AbortSignal;
}
```

### ModelProvider

```typescript
type ModelProvider = "openai" | "anthropic";
```

### ModelConfig

```typescript
interface ModelConfig {
  provider: "openai" | "anthropic";
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  reasoning?: boolean;
  temperature?: number;
  maxTokens?: number;
}
```

### ToolConfig

```typescript
interface ToolConfig {
  builtinTools?: BuiltinToolId[];
  excludeTools?: BuiltinToolId[];
  customTools?: StructuredToolInterface[];
}
```

### SkillConfig

```typescript
interface SkillConfig {
  dirs?: string[];
  skills?: Array<{
    name: string;
    description: string;
    dirPath: string;
  }>;
}
```

### SkillMeta / SkillFull

```typescript
interface SkillMeta {
  name: string;
  description: string;
  dirPath: string;
  userUploaded?: boolean;
}

interface SkillFull extends SkillMeta {
  body: string;  // SKILL.md 的完整内容
}
```

### McpServerConfig

```typescript
type McpServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "streamablehttp";
      url: string;
      headers?: Record<string, string>;
    };
```

### HarnessConfig

```typescript
interface HarnessConfig {
  evalEnabled: boolean;
  loopDetectionEnabled: boolean;
  replanEnabled: boolean;
  maxReplanAttempts: number;
}
```

### AgentEventType

```typescript
type AgentEventType =
  | "token"
  | "reasoning_token"
  | "tool_call"
  | "tool_result"
  | "plan_update"
  | "usage"
  | "stop"
  | "error";
```

### AgentEvent

`AgentEvent` 是 8 种事件接口的联合类型，每个子类型都可以单独导入：

```typescript
interface TokenEvent         { type: "token";           content: string }
interface ReasoningTokenEvent { type: "reasoning_token"; content: string }
interface ToolCallEvent      { type: "tool_call";  id: string; name: string; arguments: Record<string, unknown> }
interface ToolResultEvent    { type: "tool_result"; id: string; name: string; result: string }
interface PlanUpdateEvent    { type: "plan_update"; steps: PlanStep[]; currentStepIndex: number }
interface UsageEvent         { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
interface StopEvent          { type: "stop";  reason: StopReason }
interface ErrorEvent         { type: "error"; message: string; recoverable: boolean }

type AgentEvent =
  | TokenEvent | ReasoningTokenEvent | ToolCallEvent | ToolResultEvent
  | PlanUpdateEvent | UsageEvent | StopEvent | ErrorEvent;
```

> 每种事件子类型（如 `TokenEvent`、`ToolCallEvent` 等）都可以直接 import，便于做类型守卫。

### StopReason

```typescript
type StopReason =
  | "completed"
  | "aborted"
  | "max_rounds"
  | "model_error"
  | "harness_abort"
  | "tool_error_cascade"
  | "context_overflow"
  | "empty_response";
```

### BuiltinToolId

```typescript
type BuiltinToolId =
  | "run_command"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "search_code"
  | "list_files"
  | "git_operations"
  | "test_runner"
  | "web_search"
  | "fetch_url"
  | "get_time"
  | "background_run"
  | "background_check"
  | "background_cancel";
```

> **注意**：`load_skill` 不在 `BuiltinToolId` 类型中——它由 Skills 模块动态创建。`web_search` 包含在此类型中，但不在默认工具集里，需通过 `builtinTools` 显式启用。

### ModelAdapter

```typescript
interface ModelAdapter {
  readonly modelId: string;
  supportsReasoningStream(): boolean;
  getLLM(): ChatModel;  // ChatModel = ChatOpenAI | ChatAnthropic
  streamSingleTurn(
    messages: BaseMessage[],
    onToken: (token: string) => void,
    onReasoningToken: (token: string) => void,
    tools?: Array<Record<string, unknown>>,
    abortSignal?: AbortSignal,
  ): Promise<StreamReasoningResult>;
}
```

**`StreamReasoningResult`**：

```typescript
interface StreamReasoningResult {
  content: string;           // 模型输出文本
  reasoningContent: string;  // 推理/思考过程文本
  toolCalls: ToolCallResult[];
  usage?: TokenUsage;
}

interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;  // JSON 字符串
}

interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
```

> **注意**：`tools` 参数是 OpenAI API 格式的工具描述数组（`Record<string, unknown>[]`），不是 LangChain `StructuredToolInterface`。Anthropic 适配器的 `streamSingleTurn()` 会直接抛出异常——Anthropic 模型始终走 LangChain 的 `getLLM()` 流。

### ChatModel

```typescript
type ChatModel = ChatOpenAI | ChatAnthropic;
```

模型适配器底层使用的 LangChain Chat Model 联合类型。

---

## 常量

### DEFAULT_HARNESS_CONFIG

```typescript
const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  evalEnabled: false,
  loopDetectionEnabled: false,
  replanEnabled: false,
  maxReplanAttempts: 3,
};
```

---

## 依赖说明

SDK 使用以下 LangChain 包中的类型，你可能在多轮对话时需要导入：

```typescript
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
```

这些包作为 SDK 的依赖自动安装，无需额外安装。
