# 第 1 章：快速开始

## 安装

```bash
npm install arcana-agent-sdk
```

SDK 依赖 `@arcana-agent/core` 作为核心逻辑层（安装 SDK 时自动安装）。

### 前置要求

- **Node.js >= 18**（使用了 `AsyncGenerator`、`AbortSignal` 等现代 API）
- **ESM 项目**：`package.json` 中需要 `"type": "module"`，或使用 `.mjs` 后缀
- **模型 API Key**：至少需要一个 LLM 提供商的 API Key（OpenAI / Anthropic / 火山引擎等 OpenAI 兼容服务）

## 最简示例：3 行代码创建 Agent

```typescript
import { createAgent } from "arcana-agent-sdk";

const agent = createAgent({
  model: {
    provider: "openai",
    apiKey: "sk-xxxx",
    modelId: "gpt-4o",
  },
});

// 流式输出
for await (const event of agent.stream("你好，介绍一下自己")) {
  if (event.type === "token") process.stdout.write(event.content);
}
```

## 同步调用

如果不需要流式输出，可以使用 `run()` 方法：

```typescript
const result = await agent.run("1+1等于几？");
console.log(result.content);       // "1+1等于2。"
console.log(result.stopReason);    // "completed"
console.log(result.toolCallCount); // 0
console.log(result.usage);         // { promptTokens: 42, completionTokens: 8, totalTokens: 50 }
```

## 带工具调用的 Agent

设置 `workspacePath` 后，Agent 自动获得文件操作、命令执行等能力：

```typescript
const agent = createAgent({
  model: {
    provider: "openai",
    apiKey: "sk-xxxx",
    modelId: "gpt-4o",
  },
  workspacePath: "/path/to/your/project",
});

for await (const event of agent.stream("帮我看看当前目录有哪些文件")) {
  switch (event.type) {
    case "token":
      process.stdout.write(event.content);
      break;
    case "tool_call":
      console.log(`\n🔧 调用工具: ${event.name}`);
      break;
    case "tool_result":
      console.log(`📋 结果: ${event.result.slice(0, 100)}...`);
      break;
    case "stop":
      console.log(`\n✅ 完成 (${event.reason})`);
      break;
  }
}
```

## 使用火山引擎（Doubao）

SDK 支持所有 OpenAI 兼容 API，包括字节跳动的火山引擎（豆包）：

```typescript
const agent = createAgent({
  model: {
    provider: "openai",
    apiKey: "your-volcengine-api-key",
    modelId: "doubao-seed-2-0-mini-260215",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  workspacePath: "/path/to/workspace",
});
```

## 使用推理模型

开启 `reasoning: true` 可以获取模型的思考过程：

```typescript
const agent = createAgent({
  model: {
    provider: "openai",
    apiKey: "sk-xxxx",
    modelId: "doubao-seed-2-0-mini-260215",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    reasoning: true,
  },
});

for await (const event of agent.stream("证明根号2是无理数")) {
  if (event.type === "reasoning_token") {
    // 模型的思考过程（逐 token 流式输出）
    process.stderr.write(event.content);
  }
  if (event.type === "token") {
    // 最终回答内容
    process.stdout.write(event.content);
  }
}
```

## Express SSE 集成

SDK 的 `stream()` 返回 `AsyncGenerator`，可以直接对接 SSE：

```typescript
import express from "express";
import { createAgent } from "arcana-agent-sdk";

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const agent = createAgent({
    model: {
      provider: "openai",
      apiKey: process.env.API_KEY!,
      modelId: "gpt-4o",
    },
    workspacePath: "/path/to/workspace",
  });

  for await (const event of agent.stream(req.body.message)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

app.listen(3000, () => console.log("Server running on port 3000"));
```

## 下一步

- 了解所有配置选项 → [Agent 配置全解](./agent-config.md)
- 了解事件系统 → [流式事件系统](./streaming-events.md)
- 了解内置工具 → [工具系统](./tools.md)
