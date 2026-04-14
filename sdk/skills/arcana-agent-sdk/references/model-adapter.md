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

## 自定义 ModelAdapter（注入非标模型）

SDK 内置的两个 adapter（OpenAI 兼容 / Anthropic）覆盖了标准 `/chat/completions` 和 Anthropic `/v1/messages` 协议。对于使用非标协议的模型服务（如 OpenAI Responses API `/responses`、内部私有网关、自定义认证方式等），可以通过 `AgentConfig.modelAdapter` 注入自定义实现，**完全绕过内置 adapter**。

### 何时需要自定义

| 场景 | 是否需要自定义 |
|:---|:---|
| 标准 OpenAI `/chat/completions` 兼容 API | ❌ 用 `provider: "openai"` + `baseUrl` |
| 标准 Anthropic API | ❌ 用 `provider: "anthropic"` |
| OpenAI Responses API（`/responses` 端点） | ✅ 需要自定义 |
| 认证方式非 `Authorization: Bearer`（如 URL query param `?ak=xxx`） | ✅ 需要自定义 |
| 请求/响应格式与 OpenAI Chat Completions 不同 | ✅ 需要自定义 |
| 内部模型网关、私有协议 | ✅ 需要自定义 |

### 基本用法

```typescript
import { createAgent, type ModelAdapter } from "arcana-agent-sdk";

const agent = createAgent({
  model: { provider: "openai", apiKey: "placeholder", modelId: "my-model" },
  modelAdapter: myCustomAdapter,  // 注入后完全忽略 model 中的 provider/baseUrl/apiKey
});
```

> `model` 字段仍需提供（类型约束），但当 `modelAdapter` 存在时，`model` 中的 `provider`、`baseUrl`、`apiKey` 不会被使用。`model.modelId` 建议与自定义 adapter 的 `modelId` 保持一致，因为 SDK 内部会用它推断上下文窗口大小。

### 完整实现示例：接入 OpenAI Responses API

以下示例演示如何为使用 `/responses` 端点、URL query param 认证、非标消息格式的内部模型编写自定义 adapter：

```typescript
import type { BaseMessage } from "@langchain/core/messages";
import type { ModelAdapter, ChatModel, StreamReasoningResult, ToolCallResult } from "arcana-agent-sdk";

class ResponsesAPIAdapter implements ModelAdapter {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly ak: string;

  constructor(config: { modelId: string; baseUrl: string; ak: string }) {
    this.modelId = config.modelId;
    this.baseUrl = config.baseUrl;
    this.ak = config.ak;
  }

  supportsReasoningStream(): boolean {
    // 返回 true 时 Agent 走 streamSingleTurn 路径（推荐）
    // 返回 false 时 Agent 走 getLLM().stream() 路径
    return true;
  }

  getLLM(): ChatModel {
    // supportsReasoningStream() 返回 true 时不会被调用，可以直接抛错
    throw new Error("此 adapter 不支持 LangChain 路径，请确保 supportsReasoningStream() 返回 true");
  }

  async streamSingleTurn(
    messages: BaseMessage[],
    onToken: (token: string) => void,
    onReasoningToken: (token: string) => void,
    tools?: Array<Record<string, unknown>>,
    abortSignal?: AbortSignal,
  ): Promise<StreamReasoningResult> {
    // 1. 将 LangChain BaseMessage[] 转换为 Responses API 的 input 格式
    const input = messages.flatMap((m) => this.convertMessage(m));

    // 2. 构造请求体
    const body: Record<string, unknown> = {
      model: this.modelId,
      input,
      stream: true,
    };
    if (tools?.length) {
      body.tools = tools.map((t) => this.convertTool(t));
    }

    // 3. 发送请求（注意认证方式为 URL query param）
    const url = `${this.baseUrl}/responses?ak=${this.ak}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!res.ok) {
      throw new Error(`Responses API error: ${res.status} ${await res.text()}`);
    }

    // 4. 解析 SSE 流
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let reasoningContent = "";
    const toolCalls: ToolCallResult[] = [];
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(trimmed.slice(6));

          switch (event.type) {
            // 文本内容增量
            case "response.output_text.delta":
              content += event.delta ?? "";
              onToken(event.delta ?? "");
              break;

            // 推理过程增量（如模型支持）
            case "response.reasoning.delta":
              reasoningContent += event.delta ?? "";
              onReasoningToken(event.delta ?? "");
              break;

            // 工具调用完成 — 从 response.output_item.done 中提取完整的 function_call
            case "response.output_item.done":
              if (event.item?.type === "function_call") {
                toolCalls.push({
                  id: event.item.call_id,
                  name: event.item.name,
                  arguments: event.item.arguments ?? "{}",
                });
              }
              break;

            // 请求完成 — 提取 usage
            case "response.completed":
              if (event.response?.usage) {
                const u = event.response.usage;
                usage = {
                  prompt_tokens: u.input_tokens ?? 0,
                  completion_tokens: u.output_tokens ?? 0,
                  total_tokens: u.total_tokens ?? (u.input_tokens + u.output_tokens) ?? 0,
                };
              }
              break;
          }
        } catch { /* ignore parse errors */ }
      }
    }

    return { content, reasoningContent, toolCalls, usage };
  }

  private convertMessage(m: BaseMessage): Record<string, unknown> | Record<string, unknown>[] {
    const type = (m as any)._getType?.() ?? "user";

    // ToolMessage → function_call_output
    if (type === "tool") {
      return {
        type: "function_call_output",
        call_id: (m as any).tool_call_id,
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      };
    }

    // AIMessage with tool_calls → assistant content + function_call items
    if (type === "ai") {
      const tc = (m as any).tool_calls;
      if (tc?.length) {
        const items: Record<string, unknown>[] = [];
        const c = (m as any).content;
        if (c && c !== " ") {
          items.push({ role: "assistant", content: [{ type: "output_text", text: typeof c === "string" ? c : JSON.stringify(c) }] });
        }
        for (const call of tc) {
          items.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}),
          });
        }
        return items;
      }
      const c = (m as any).content;
      return { role: "assistant", content: [{ type: "output_text", text: typeof c === "string" ? c : JSON.stringify(c) }] };
    }

    // HumanMessage / SystemMessage
    const role = type === "human" ? "user" : type === "system" ? "developer" : "user";
    const c = (m as any).content;

    if (typeof c === "string") {
      return { role, content: [{ type: "input_text", text: c }] };
    }
    if (Array.isArray(c)) {
      const parts = c.map((x: any) => {
        if (x?.type === "image_url" && x?.image_url?.url) {
          return { type: "input_image", image_url: x.image_url.url };
        }
        return { type: "input_text", text: x?.text ?? String(x) };
      });
      return { role, content: parts };
    }
    return { role, content: [{ type: "input_text", text: String(c) }] };
  }

  private convertTool(t: Record<string, unknown>): Record<string, unknown> {
    // SDK 传入的是 Chat Completions 格式: { type: "function", function: { name, description, parameters } }
    // Responses API 需要扁平格式: { type: "function", name, description, parameters }
    const fn = (t as any).function;
    if (fn) {
      return { type: "function", name: fn.name, description: fn.description, parameters: fn.parameters };
    }
    return t;
  }
}
```

使用：

```typescript
const adapter = new ResponsesAPIAdapter({
  modelId: "gpt-5.4-pro-2026-03-05",
  baseUrl: "https://aidp.xxx.net/api/modelhub/online",
  ak: "xxx",
});

const agent = createAgent({
  model: { provider: "openai", apiKey: "unused", modelId: "gpt-5.4-pro-2026-03-05" },
  modelAdapter: adapter,
  workspacePath: "/path/to/workspace",
});

for await (const event of agent.stream("分析这段代码")) {
  if (event.type === "token") process.stdout.write(event.content);
  if (event.type === "reasoning_token") process.stderr.write(event.content);
}
```

### 接口契约详解

自定义 adapter 必须实现 `ModelAdapter` 接口。SDK 内部通过两条路径调用 adapter：

```
supportsReasoningStream() === true
  → Agent 走 streamReasoningPath → 调用 streamSingleTurn()
  → 不会调用 getLLM()

supportsReasoningStream() === false
  → Agent 走 streamLangChainPath → 调用 getLLM().bindTools().stream()
  → 不会调用 streamSingleTurn()
```

#### StreamReasoningResult 返回值要求

```typescript
interface StreamReasoningResult {
  content: string;             // 模型最终文本输出（完整拼接）
  reasoningContent: string;    // 思考过程文本（无则为空串）
  toolCalls: ToolCallResult[]; // 工具调用列表（无则为空数组）
  usage?: TokenUsage;          // token 用量（可选）
}

interface ToolCallResult {
  id: string;        // 工具调用 ID（唯一标识，用于匹配工具返回值）
  name: string;      // 工具函数名（必须与 Agent 注册的工具名一致）
  arguments: string; // 工具参数（JSON 字符串）
}

interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
```

#### 回调函数要求

| 回调 | 调用时机 | 说明 |
|:---|:---|:---|
| `onToken(token)` | 每收到一个内容 token 时 | 触发 `{ type: "token" }` 事件推送给上层 |
| `onReasoningToken(token)` | 每收到一个推理 token 时 | 触发 `{ type: "reasoning_token" }` 事件推送给上层 |

> **关键**：`onToken` / `onReasoningToken` 是实时流式推送，必须在收到每个 delta 时立即调用，而不是等到请求结束后批量调用。`StreamReasoningResult.content` 和 `reasoningContent` 则是完整拼接后的最终结果。两者内容应一致。

#### 工具调用字段映射参考

不同 API 的工具调用格式需映射到统一的 `ToolCallResult`：

| 字段 | OpenAI Chat Completions | OpenAI Responses API | 你的实现 |
|:---|:---|:---|:---|
| `id` | `delta.tool_calls[i].id` | `output_item.done → item.call_id` | 自行映射 |
| `name` | `delta.tool_calls[i].function.name` | `output_item.done → item.name` | 自行映射 |
| `arguments` | `delta.tool_calls[i].function.arguments` | `output_item.done → item.arguments` | JSON 字符串 |

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
