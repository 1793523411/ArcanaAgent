# Arcana Agent SDK 文档

> **版本**: 0.1.0 | **运行环境**: Node.js >= 18 | **语言**: TypeScript ESM

Arcana Agent SDK 是一个功能完备的 AI Agent 开发库，支持多模型、流式输出、工具调用、自动规划、Skill 技能系统和 MCP 协议。你可以用几行代码创建一个带工具调用能力的 AI Agent，也可以深度定制每一个细节。

---

## 文档目录

| 章节 | 文件 | 内容 |
|:---:|:---|:---|
| 1 | [快速开始](../skills/arcana-agent-sdk/references/getting-started.md) | 安装、最小示例、5 分钟上手 |
| 2 | [Agent 配置全解](../skills/arcana-agent-sdk/references/agent-config.md) | `AgentConfig` 所有字段详解、默认值、组合用法 |
| 3 | [流式事件系统](../skills/arcana-agent-sdk/references/streaming-events.md) | `stream()` / `run()` 双模式、10 种事件类型（含 harness/harness_driver）、SSE 集成 |
| 4 | [工具系统](../skills/arcana-agent-sdk/references/tools.md) | 14 个内置 + 1 个动态工具、工具裁剪/排除、自定义工具、workspace 沙箱 |
| 5 | [模型适配器](../skills/arcana-agent-sdk/references/model-adapter.md) | 多模型支持（OpenAI/Anthropic/火山引擎）、推理模型、自定义 ModelAdapter 注入、独立使用 |
| 6 | [规划与 Harness](../skills/arcana-agent-sdk/references/planning-harness.md) | Planning 模式、进度追踪、eval guard、循环检测、重规划、外层重试、prompt 增强注入 |
| 7 | [Skill 技能系统](../skills/arcana-agent-sdk/references/skills.md) | SKILL.md 规范、加载方式、Skill 目录权限、运行时脚本 |
| 8 | [MCP 协议集成](../skills/arcana-agent-sdk/references/mcp.md) | stdio/streamablehttp 传输、McpManager 独立使用、工具命名 |
| 9 | [完整 API 参考](../skills/arcana-agent-sdk/references/api-reference.md) | 所有导出函数/类/类型的签名与说明 |

---

## 架构概览

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
│  │  (OpenAI / Anthropic / 火山引擎       │   │
│  │   / 自定义 adapter 注入)              │   │
│  └───────────────────────────────────────┘   │
├─────────────────────────────────────────────┤
│             @arcana-agent/core              │
│       (纯逻辑层 — 工具定义/规划/Harness)       │
└─────────────────────────────────────────────┘
```

## 快速一览

```typescript
import { createAgent } from "arcana-agent-sdk";

const agent = createAgent({
  model: {
    provider: "openai",
    apiKey: "your-api-key",
    modelId: "gpt-4o",
  },
  workspacePath: "/path/to/workspace",
});

for await (const event of agent.stream("帮我分析这个项目的结构")) {
  if (event.type === "token") process.stdout.write(event.content);
  if (event.type === "tool_call") console.log(`🔧 ${event.name}`);
  if (event.type === "stop") console.log(`\n✅ ${event.reason}`);
}
```
