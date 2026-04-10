# 第 3 章：流式事件系统

Arcana Agent SDK 提供两种调用模式：**流式 `stream()`** 和 **同步 `run()`**。流式模式通过 `AsyncGenerator` 逐个 yield 事件，是 SDK 的核心交互方式。

## 两种调用模式

### stream() — 流式模式

```typescript
async *stream(input: string | BaseMessage[]): AsyncGenerator<AgentEvent>
```

接收用户消息（字符串或消息数组），返回事件流。每个事件都是一个 `AgentEvent` 对象。

```typescript
for await (const event of agent.stream("你好")) {
  // 处理每个事件
}
```

### run() — 同步模式

```typescript
async run(input: string | BaseMessage[]): Promise<AgentRunResult>
```

内部调用 `stream()` 并聚合所有事件，返回最终结果：

```typescript
interface AgentRunResult {
  content: string;        // 所有 token 拼接的完整文本
  stopReason: StopReason; // 停止原因
  toolCallCount: number;  // 工具调用总次数
  usage?: {               // Token 用量（最后一次）
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  messages: BaseMessage[]; // 完整消息历史（可用于多轮对话）
}
```

---

## 多轮对话

`run()` 返回的 `messages` 数组可直接传入下一轮：

```typescript
// 第一轮
const r1 = await agent.run("创建一个 hello.txt");
console.log(r1.content);

// 第二轮：传入历史消息 + 新消息
const history = r1.messages;
history.push(new HumanMessage("把内容改成 Hello World"));
const r2 = await agent.run(history);

// 第三轮：也可以用 stream()
const history2 = r2.messages;
history2.push(new HumanMessage("读取文件确认内容"));
for await (const event of agent.stream(history2)) {
  // ...
}
```

---

## 8 种事件类型

```typescript
type AgentEvent =
  | TokenEvent           // 模型输出文本
  | ReasoningTokenEvent  // 模型思考过程
  | ToolCallEvent        // 工具调用开始
  | ToolResultEvent      // 工具调用结果
  | PlanUpdateEvent      // 计划更新
  | UsageEvent           // Token 用量
  | StopEvent            // 流结束
  | ErrorEvent;          // 错误信息
```

### 1. TokenEvent

```typescript
interface TokenEvent {
  type: "token";
  content: string;  // 一个或多个字符（真流式，逐 token 输出）
}
```

模型生成的最终回答内容。每个事件包含一小段文本，拼接起来就是完整回答。

```typescript
let fullText = "";
for await (const event of agent.stream("你好")) {
  if (event.type === "token") {
    process.stdout.write(event.content);  // 打字机效果
    fullText += event.content;
  }
}
```

### 2. ReasoningTokenEvent

```typescript
interface ReasoningTokenEvent {
  type: "reasoning_token";
  content: string;  // 思考过程片段
}
```

仅在 `reasoning: true` 时出现。包含模型的内部推理过程。

> **时序**：`reasoning_token` 在 `token` 之前输出。模型先思考完，再输出最终回答。

```typescript
for await (const event of agent.stream("证明勾股定理")) {
  if (event.type === "reasoning_token") {
    process.stderr.write(`[思考] ${event.content}`);
  }
  if (event.type === "token") {
    process.stdout.write(event.content);
  }
}
```

### 3. ToolCallEvent

```typescript
interface ToolCallEvent {
  type: "tool_call";
  id: string;                          // 工具调用 ID
  name: string;                        // 工具名称
  arguments: Record<string, unknown>;  // 工具参数
}
```

模型决定调用工具时触发。一轮可能有多个 tool_call（并行工具调用）。

### 4. ToolResultEvent

```typescript
interface ToolResultEvent {
  type: "tool_result";
  id: string;    // 对应 tool_call 的 ID
  name: string;  // 工具名称
  result: string; // 工具执行结果（纯文本）
}
```

工具执行完毕后触发。`tool_call` 和对应的 `tool_result` 总是成对出现。

```typescript
for await (const event of agent.stream("读取 config.json")) {
  if (event.type === "tool_call") {
    console.log(`🔧 调用 ${event.name}(${JSON.stringify(event.arguments)})`);
  }
  if (event.type === "tool_result") {
    console.log(`📋 结果: ${event.result.slice(0, 200)}`);
  }
}
```

### 5. PlanUpdateEvent

```typescript
interface PlanUpdateEvent {
  type: "plan_update";
  steps: Array<{
    title: string;
    status: "pending" | "in_progress" | "completed" | "failed";
  }>;
  currentStepIndex: number;
}
```

仅在 `planningEnabled: true` 时出现。每次计划状态变化时触发。

```typescript
if (event.type === "plan_update") {
  event.steps.forEach((step, i) => {
    const icon = { pending: "⬜", in_progress: "🔄", completed: "✅", failed: "❌" }[step.status];
    console.log(`${icon} ${i + 1}. ${step.title}`);
  });
}
```

### 6. UsageEvent

```typescript
interface UsageEvent {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

每轮 LLM 调用结束后触发，报告该轮的 Token 消耗。

### 7. StopEvent

```typescript
interface StopEvent {
  type: "stop";
  reason: StopReason;
}
```

**事件流的最后一个事件**，表示 Agent 执行结束。

```typescript
type StopReason =
  | "completed"           // 正常完成（模型不再调用工具）
  | "aborted"             // 被 AbortSignal 中断
  | "max_rounds"          // 达到最大轮数
  | "model_error"         // 模型连续 3 次出错
  | "harness_abort"       // Harness 安全护栏中断
  | "tool_error_cascade"  // 连续 3 轮工具大面积失败
  | "context_overflow"    // 上下文超限
  | "empty_response";     // 模型返回空响应
```

### 8. ErrorEvent

```typescript
interface ErrorEvent {
  type: "error";
  message: string;      // 错误描述
  recoverable: boolean; // 是否可恢复
}
```

错误不一定导致流结束。`recoverable: true` 时 Agent 会自动重试。

---

## 完整事件处理模板

```typescript
const stats = { tokens: 0, tools: 0, errors: 0 };

for await (const event of agent.stream("你的问题")) {
  switch (event.type) {
    case "token":
      process.stdout.write(event.content);
      stats.tokens += event.content.length;
      break;

    case "reasoning_token":
      // 仅 reasoning: true 时出现
      process.stderr.write(`[思考] ${event.content}`);
      break;

    case "tool_call":
      console.log(`\n🔧 ${event.name}(${JSON.stringify(event.arguments)})`);
      stats.tools++;
      break;

    case "tool_result":
      console.log(`📋 ${event.result.slice(0, 200)}`);
      break;

    case "plan_update":
      // 仅 planningEnabled: true 时出现
      const done = event.steps.filter(s => s.status === "completed").length;
      console.log(`📋 进度: ${done}/${event.steps.length}`);
      break;

    case "usage":
      console.log(`📊 tokens: ${event.totalTokens}`);
      break;

    case "error":
      console.error(`❌ ${event.recoverable ? "可恢复" : "致命"}: ${event.message}`);
      stats.errors++;
      break;

    case "stop":
      console.log(`\n✅ ${event.reason} | 字符=${stats.tokens} 工具=${stats.tools}`);
      break;
  }
}
```

---

## SSE 集成

`stream()` 返回的 `AsyncGenerator` 天然适合 Server-Sent Events：

```typescript
app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const agent = createAgent({ model, workspacePath: "/app/workspace" });

  for await (const event of agent.stream(req.body.message)) {
    // 每个事件作为一个 SSE message
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
});
```

前端消费：

```javascript
const eventSource = new EventSource("/api/chat");
// 或者用 fetch + ReadableStream 处理 POST 请求的 SSE
```

---

## 事件时序图

一次典型的带工具调用的 Agent 流：

```
stream("读取 config.json 并分析")
  │
  ├── reasoning_token (可选，仅 reasoning 模式)
  ├── reasoning_token
  ├── ...
  │
  ├── token (模型开始输出，可能为空)
  ├── usage
  │
  ├── tool_call { name: "read_file", arguments: { path: "config.json" } }
  ├── tool_result { name: "read_file", result: "{ ... }" }
  │
  ├── plan_update (可选，仅 planning 模式)
  │
  ├── reasoning_token (第二轮思考)
  ├── ...
  ├── token "config.json 包含以下配置..."
  ├── token "..."
  ├── usage
  │
  └── stop { reason: "completed" }
```

---

## 真流式 vs 伪流式

SDK 使用 **async queue 模式** 实现真流式输出：

- **推理模型路径**（`reasoning: true`）：通过 HTTP SSE 原生流接收 token，每收到一个立刻 yield
- **LangChain 路径**（标准模型）：通过 LangChain 的 `model.stream()` 逐 chunk yield

两种路径都是**真打字机效果**，不是等全部生成完再一次性返回。
