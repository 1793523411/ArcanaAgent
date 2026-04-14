# 第 8 章：MCP 协议集成

MCP（Model Context Protocol）是一种标准化的工具扩展协议，允许 Agent 连接外部工具服务器。SDK 支持 stdio 和 streamablehttp 两种传输方式。

## MCP 概述

MCP 让你的 Agent 可以连接任何实现了 MCP 协议的工具服务器，获得该服务器提供的所有工具能力，无需编写任何工具代码。

```
┌───────────────┐     stdio / HTTP     ┌──────────────────┐
│  Arcana Agent │ ◄──────────────────► │  MCP Server      │
│  (SDK)        │                      │  (GitHub/FS/DB)  │
└───────────────┘                      └──────────────────┘
```

---

## 两种传输方式

### stdio 传输

通过子进程 stdin/stdout 通信。适用于本地工具服务器：

```typescript
{
  name: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "ghp_xxxx" },
}
```

常见 stdio MCP 服务器：

| 服务器 | 安装命令 | 功能 |
|:---|:---|:---|
| GitHub | `npx -y @modelcontextprotocol/server-github` | Issues, PRs, Repos |
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem /path` | 文件操作 |
| PostgreSQL | `npx -y @modelcontextprotocol/server-postgres` | 数据库查询 |
| SQLite | `npx -y @modelcontextprotocol/server-sqlite` | SQLite 操作 |
| Brave Search | `npx -y @modelcontextprotocol/server-brave-search` | 网页搜索 |

### streamablehttp 传输

通过 HTTP 连接远程 MCP 服务器。适用于云端部署的工具服务：

```typescript
{
  name: "麦当劳",
  transport: "streamablehttp",
  url: "https://mcp.mcd.cn",
  headers: {
    Authorization: "Bearer your-token",
  },
}
```

---

## 配置方式

### 在 Agent 中使用

```typescript
const agent = createAgent({
  model,
  mcpServers: [
    // stdio 方式
    {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
    },
    // HTTP 方式
    {
      name: "my-api",
      transport: "streamablehttp",
      url: "https://my-mcp-server.com/mcp",
      headers: { "X-API-Key": "xxx" },
    },
  ],
});
```

MCP 工具会在 `agent.stream()` / `agent.run()` 首次调用时自动连接和加载。

### McpServerConfig 类型定义

```typescript
type McpServerConfig =
  | {
      name: string;                          // 服务器名称（用于工具命名前缀）
      transport: "stdio";                    // stdio 传输
      command: string;                       // 可执行命令
      args: string[];                        // 命令参数
      env?: Record<string, string>;          // 环境变量
    }
  | {
      name: string;                          // 服务器名称
      transport: "streamablehttp";           // HTTP 传输
      url: string;                           // MCP 服务器 URL
      headers?: Record<string, string>;      // HTTP 请求头
    };
```

---

## 工具命名

MCP 工具会以 `mcp_{serverName}__{toolName}` 的格式命名（`mcp_` 前缀 + 双下划线分隔，特殊字符替换为下划线），例如：

- 服务器名 `github`，工具名 `create_issue` → `mcp_github__create_issue`
- 服务器名 `my-api`，工具名 `query-data` → `mcp_my-api__query-data`

---

## 系统提示词自动注入

配置了 MCP 后，系统提示词会自动追加 MCP 工具列表：

```
## Available MCP Tools
The following tools are provided by external MCP servers. Use them when relevant:
- `mcp_github__create_issue`: Create a new issue in a GitHub repository
- `mcp_github__list_repos`: List repositories for a user or organization
- `mcp_my-api__query_data`: Query data from the custom API
```

---

## 独立使用 McpManager

不通过 Agent，直接管理 MCP 连接：

```typescript
import { McpManager } from "arcana-agent-sdk";

const mcp = new McpManager();

// 连接 MCP 服务器
await mcp.connect([
  {
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  },
]);

// 获取所有工具（LangChain StructuredTool 格式）
const tools = mcp.getTools();
console.log("MCP 工具列表:", tools.map(t => t.name));

// 打印每个工具的描述
for (const t of tools) {
  const desc = (t as any).description;
  console.log(`  - ${t.name}: ${desc}`);
}

// 手动调用工具
const listTool = tools.find(t => t.name === "mcp_filesystem__list_directory");
if (listTool) {
  const result = await listTool.invoke({ path: "/tmp" });
  console.log(result);
}

// 断开所有连接
await mcp.disconnectAll();
```

---

## McpManager API

```typescript
class McpManager {
  // 连接 MCP 服务器列表
  async connect(servers: McpServerConfig[]): Promise<void>;

  // 获取所有已连接服务器的工具
  getTools(): StructuredToolInterface[];

  // 断开所有 MCP 连接
  async disconnectAll(): Promise<void>;
}
```

---

## 资源清理

使用了 MCP 的 Agent，在不再需要时应调用 `destroy()` 清理资源：

```typescript
const agent = createAgent({
  model,
  mcpServers: [/* ... */],
});

// 使用 agent...
for await (const event of agent.stream("...")) {
  // ...
}

// 清理 MCP 连接
await agent.destroy();
```

> **重要**：stdio 类型的 MCP 服务器会启动子进程。如果不调用 `destroy()`，子进程可能不会被正确清理，导致进程无法退出。

---

## JSON Schema → Zod 转换

MCP 工具的参数定义使用 JSON Schema 格式，SDK 内部会自动转换为 Zod schema：

- `string` → `z.string()`
- `number` / `integer` → `z.number()`
- `boolean` → `z.boolean()`
- `array` → `z.array()`
- `object` → `z.object()`
- 可选参数 → `.optional().nullable()`（兼容 OpenAI Structured Outputs）
- `enum` → `z.enum()`

这个转换是透明的，你不需要手动处理。

---

## 完整示例：Agent + MCP

```typescript
import { createAgent } from "arcana-agent-sdk";

const agent = createAgent({
  model: {
    provider: "openai",
    apiKey: process.env.API_KEY!,
    modelId: "gpt-4o",
  },
  workspacePath: "/my/project",
  mcpServers: [
    {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
    },
  ],
});

for await (const event of agent.stream(
  "查看 my-org/my-repo 仓库最近的 5 个 issue，并总结主要问题"
)) {
  if (event.type === "tool_call") {
    console.log(`🔧 MCP 工具: ${event.name}`);
  }
  if (event.type === "token") {
    process.stdout.write(event.content);
  }
}

await agent.destroy();
```
