# 第 5 章：模型适配器

ModelAdapter 是 SDK 的模型抽象层，负责将不同 LLM 提供商的 API 统一为一致的接口。

## 支持的模型提供商

| Provider | 值 | 适用模型 | 推理模式 |
|:---|:---|:---|:---|
| OpenAI 兼容 | `"openai"` | GPT-4o, GPT-4, DeepSeek-R1, Doubao, Qwen, Moonshot | ✅ |
| Anthropic | `"anthropic"` | Claude 3.5 Sonnet, Claude 3 Opus, Claude 3 Haiku | ✅ |

### OpenAI 兼容 API

所有实现了 OpenAI API 格式的服务都可以使用 `provider: "openai"`：

```typescript
// OpenAI 官方
{ provider: "openai", apiKey: "sk-xxx", modelId: "gpt-4o" }

// 火山引擎（Doubao 豆包）
{ provider: "openai", apiKey: "key", modelId: "doubao-seed-2-0-mini-260215",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }

// DeepSeek
{ provider: "openai", apiKey: "key", modelId: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1" }

// 月之暗面 Moonshot
{ provider: "openai", apiKey: "key", modelId: "moonshot-v1-8k",
  baseUrl: "https://api.moonshot.cn/v1" }

// 通义千问
{ provider: "openai", apiKey: "key", modelId: "qwen-turbo",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }
```

### Anthropic

```typescript
{ provider: "anthropic", apiKey: "sk-ant-xxx", modelId: "claude-sonnet-4-20250514" }
```

---

## 推理模式

设置 `reasoning: true` 启用推理模式，SDK 会使用特殊的流式路径来获取模型的思考过程。

### OpenAI 兼容推理模式

通过 `streamSingleTurn()` 方法调用，使用原生 HTTP SSE 接收推理 token：

```typescript
const agent = createAgent({
  model: {
    provider: "openai",
    apiKey: "key",
    modelId: "doubao-seed-2-0-mini-260215",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    reasoning: true,  // 启用推理
  },
});

for await (const event of agent.stream("分析这段代码的时间复杂度")) {
  if (event.type === "reasoning_token") {
    // 模型思考过程（逐 token）
    process.stderr.write(event.content);
  }
  if (event.type === "token") {
    // 最终回答
    process.stdout.write(event.content);
  }
}
```

### Anthropic 推理模式

使用 Claude 的 `thinking` 功能（`extended_thinking`），SDK 自动配置：

```typescript
{
  thinking: { type: "enabled", budget_tokens: 8000 },
  temperature: 1,  // Claude thinking 要求 temperature=1
}
```

### 推理模式的影响

| 行为 | 普通模式 | 推理模式 |
|:---|:---|:---|
| 温度 | `0`（精确） | `1`（推理需要） |
| 流式路径 | LangChain `model.stream()` | 原生 SSE（OpenAI）/ LangChain with thinking（Anthropic）|
| 事件 | `token` | `reasoning_token` + `token` |
| 工具调用 | 从 LLM 响应解析 | 从 SSE 事件解析 |

---

## createModelAdapter() — 独立使用

不通过 Agent，直接创建模型适配器：

```typescript
import { createModelAdapter } from "arcana-agent-sdk";

const adapter = createModelAdapter({
  provider: "openai",
  apiKey: "sk-xxx",
  modelId: "gpt-4o",
});

// 基本信息
console.log(adapter.modelId);                  // "gpt-4o"
console.log(adapter.supportsReasoningStream()); // false

// 获取 LangChain ChatModel 实例
const llm = adapter.getLLM();

// 直接调用
import { HumanMessage } from "@langchain/core/messages";
const response = await llm.invoke([new HumanMessage("你好")]);
console.log(response.content);

// 流式调用
const stream = await llm.stream([new HumanMessage("你好")]);
for await (const chunk of stream) {
  process.stdout.write(chunk.content as string);
}

// 带工具绑定
import { z } from "zod";
const llmWithTools = llm.bindTools([{
  name: "get_weather",
  description: "获取天气",
  schema: z.object({ city: z.string() }),
}]);
```

---

## ModelAdapter 接口

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

### supportsReasoningStream()

返回是否支持推理流模式。当 `reasoning: true` 且 provider 为 `"openai"` 时返回 `true`。Anthropic 始终返回 `false`。

### getLLM()

返回 `ChatModel` 实例（`ChatOpenAI` 或 `ChatAnthropic`），可以直接用于：
- `llm.invoke(messages)` — 单次调用
- `llm.stream(messages)` — 流式调用
- `llm.bindTools(tools)` — 绑定工具

### streamSingleTurn()

推理模式专用方法，通过回调函数接收 token：

- `onToken(token)` — 最终内容 token
- `onReasoningToken(token)` — 推理过程 token
- `tools` — OpenAI API 格式的工具描述数组（可选）

返回 `StreamReasoningResult`，包含 `content`、`reasoningContent`、`toolCalls`、`usage`。

> **注意**：Anthropic 适配器的 `streamSingleTurn()` 会直接抛出异常——Anthropic 走 LangChain 的 `getLLM()` 流。

### Anthropic 特殊行为

| 配置 | 推理模式 | 非推理模式 |
|:---|:---|:---|
| `maxTokens` | 默认 `16000` | 默认 `8192` |
| `temperature` | 固定 `1`（thinking 要求） | 默认 `0` |
| `thinking` | `{ type: "enabled", budget_tokens: 8000 }` | 无 |
| `supportsReasoningStream()` | `false`（走 LangChain 流） | `false` |

---

## Token Cap 与上下文管理

SDK 会根据模型 ID 自动推断上下文窗口大小（`resolveConversationTokenCap`），用于：

1. **消息裁剪**：对话超过上下文限制时，自动进行 5 级渐进式压缩
2. **模型错误恢复**：连续 2 次模型调用失败时，压缩到 70% 容量后重试

支持的上下文窗口推断：

| 模型关键字 | 上下文窗口 |
|:---|:---|
| `gpt-4o`, `gpt-4-turbo` | 128K |
| `gpt-3.5-turbo-16k` | 16K |
| `claude-3` | 200K |
| `deepseek` | 64K |
| `doubao` | 128K |
| 其他 | 默认 8K |
