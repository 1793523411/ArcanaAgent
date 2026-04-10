# 第 4 章：工具系统

Arcana Agent SDK 内置了 14 个开发工具（10 个默认 + 4 个扩展），另有 1 个动态工具（`load_skill`），覆盖文件操作、代码搜索、命令执行、后台任务等场景。你可以灵活裁剪、排除、或添加自定义工具。

## 内置工具一览

### 默认工具（10 个）

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

### 扩展工具（需显式启用）

| 工具名 | 功能 | 类型 | 说明 |
|:---|:---|:---|:---|
| `web_search` | 网页搜索 | 只读 | 需在 `builtinTools` 中显式指定 |
| `background_run` | 启动后台进程 | 写入 | 需在 `builtinTools` 中显式指定 |
| `background_check` | 查询后台进程状态/输出 | 只读 | 需在 `builtinTools` 中显式指定 |
| `background_cancel` | 取消后台进程 | 写入 | 需在 `builtinTools` 中显式指定 |

### 动态工具

| 工具名 | 功能 | 类型 | 说明 |
|:---|:---|:---|:---|
| `load_skill` | 加载 Skill 技能 | 只读 | 配置了 `skills` 时自动加入，不在 `BuiltinToolId` 类型中 |

> `load_skill` 不是通过 `builtinTools` 配置的——它在配置了 `skills` 时由 SDK 自动创建并加入工具集。

---

## 工具配置

### 使用默认工具集

不传 `tools` 配置，自动加载 10 个默认工具：

```typescript
createAgent({ model, workspacePath: "/path" });
```

### 显式指定工具

只加载你需要的工具，其他全部不加载：

```typescript
createAgent({
  model,
  tools: {
    builtinTools: ["read_file", "list_files", "search_code", "get_time"],
  },
});
```

### 排除工具

从默认集中排除特定工具：

```typescript
createAgent({
  model,
  tools: {
    excludeTools: ["run_command", "git_operations"],
  },
});
```

> **注意**：`builtinTools` 和 `excludeTools` 不能同时使用。如果传了 `builtinTools`，`excludeTools` 会被忽略。

### 无工具模式

传空数组完全禁用内置工具：

```typescript
createAgent({
  model,
  tools: { builtinTools: [] },
});
```

### 列出所有可用工具 ID

```typescript
import { listBuiltinToolIds } from "arcana-agent-sdk";

console.log(listBuiltinToolIds());
// ["run_command", "read_file", "write_file", "edit_file", "search_code",
//  "list_files", "git_operations", "test_runner", "web_search", "get_time",
//  "fetch_url", "background_run", "background_check", "background_cancel"]
```

> **注意**：`listBuiltinToolIds()` 返回 `string[]`（不是 `BuiltinToolId[]`），包含 core 注册表中的所有工具。`load_skill` 不在此列表中——它由 Skills 模块动态创建。

---

## 自定义工具

使用 LangChain 的 `tool()` 函数创建自定义工具，通过 `customTools` 传入：

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const queryDB = tool(
  async (input: { sql: string; database?: string }) => {
    const results = await db.execute(input.sql, input.database);
    return JSON.stringify(results);
  },
  {
    name: "query_database",
    description: "对数据库执行 SQL 查询。可以查询用户数据、订单记录等。",
    schema: z.object({
      sql: z.string().describe("要执行的 SQL 查询语句"),
      database: z.string().optional().describe("目标数据库名，默认 main"),
    }),
  },
);

const sendEmail = tool(
  async (input: { to: string; subject: string; body: string }) => {
    await emailService.send(input);
    return `邮件已发送至 ${input.to}`;
  },
  {
    name: "send_email",
    description: "发送邮件给指定收件人",
    schema: z.object({
      to: z.string().describe("收件人邮箱"),
      subject: z.string().describe("邮件主题"),
      body: z.string().describe("邮件正文"),
    }),
  },
);

const agent = createAgent({
  model,
  tools: {
    builtinTools: ["read_file", "write_file"],
    customTools: [queryDB, sendEmail],
  },
});
```

### 自定义工具最佳实践

1. **`description` 要详细**：模型根据 description 决定何时调用工具
2. **`schema` 用 Zod**：使用 `.describe()` 描述每个参数的含义
3. **返回字符串**：工具函数必须返回 `string`（JSON 序列化对象也可以）
4. **错误处理**：工具内部 try-catch，返回 `"Error: xxx"` 而不是抛异常
5. **`.optional()` 参数建议加 `.nullable()`**：兼容 OpenAI Structured Outputs

---

## Workspace 沙箱

设置 `workspacePath` 后，所有文件操作工具会：

1. **路径解析**：相对路径自动基于 workspace 解析（`./src/index.ts` → `/workspace/src/index.ts`）
2. **写入限制**：`write_file`、`edit_file`、`test_runner` 只能写入 workspace 内的文件
3. **读取限制**：`read_file`、`search_code`、`list_files` 限制为 workspace + allowedDirs（Skill 目录）
4. **命令限制**：`run_command` 的工作目录限制为 workspace + allowedDirs

```typescript
// 假设 workspacePath = "/app/workspace"

// ✅ read_file("./src/index.ts")     → 读取 /app/workspace/src/index.ts
// ❌ read_file("/etc/hostname")       → 拒绝（超出 workspace 和 allowedDirs）
// ✅ write_file("./output.txt", ...) → 写入 /app/workspace/output.txt
// ❌ write_file("/etc/passwd", ...)   → 拒绝（超出 workspace）
```

> **注意**：读取操作也受沙箱限制。只有 workspace 内和 Skill 目录（allowedDirs）内的文件可以被读取。`fetch_url` 和 `get_time` 不涉及文件路径，不受沙箱限制。

### allowedDirs（Skill 目录白名单）

当配置了 Skills 时，Skill 目录会自动加入写入白名单，允许 Agent 在 Skill 目录中执行脚本：

```typescript
createAgent({
  model,
  workspacePath: "/app/workspace",
  skills: { dirs: ["/path/to/skills"] },
  // /path/to/skills 内的文件也可以被读取和执行
});
```

---

## 独立使用 buildToolSet

不通过 Agent，直接构建工具集：

```typescript
import { buildToolSet, listBuiltinToolIds } from "arcana-agent-sdk";

// 查看所有可用工具
console.log(listBuiltinToolIds());

// 构建指定工具集
const tools = buildToolSet({
  builtinTools: ["read_file", "list_files"],
});

// 手动调用工具
const readFileTool = tools.find(t => t.name === "read_file");
const content = await readFileTool.invoke({ path: "/path/to/file.txt" });
console.log(content);
```

---

## 工具执行策略

SDK 的工具执行遵循以下规则：

### 并行 vs 串行

- **只读工具**（`read_file`, `list_files`, `search_code`, `get_time`, `fetch_url`, `background_check`）：**并行执行**
- **写入工具**（`write_file`, `edit_file`, `run_command`, `git_operations`, `test_runner`, `background_run`）：**串行执行**
- 混合情况：只读工具并行执行完毕后，写入工具按顺序依次执行

### 工具错误级联检测

连续 3 轮中，每轮有 ≥50% 的工具调用失败时，Agent 会：

1. 注入恢复提示到对话中
2. 发出 `{ type: "stop", reason: "tool_error_cascade" }` 事件
3. 停止执行

### Background 工具

适用于需要长时间运行的任务（如启动开发服务器、运行大规模测试）：

```typescript
createAgent({
  model,
  tools: {
    builtinTools: [
      "read_file", "write_file", "run_command",
      "background_run",    // 启动后台进程
      "background_check",  // 查看进程状态/输出
      "background_cancel", // 取消进程
    ],
  },
});
```

Agent 可以用 `background_run` 启动一个不阻塞的进程，用 `background_check` 定期检查其状态和输出，用 `background_cancel` 在需要时终止。
