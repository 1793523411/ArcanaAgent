# 日志系统说明

本项目使用 Winston 作为日志库，支持**全局日志**和**对话级日志**。

## 📂 日志文件位置

### 1. 全局日志（服务器级别）

- **位置**: `data/logs/`
- **文件**:
  - `server.log` - 所有级别的日志（JSON 格式）
  - `error.log` - 仅错误日志（JSON 格式）

### 2. 对话级日志（每个对话独立）

- **位置**: `data/conversations/{conversationId}/conversation.log`
- **格式**: JSON
- **内容**: 该对话中的所有操作（用户消息、LLM 调用、工具执行等）

## 📝 日志内容

### 记录的事件类型

| 事件类型 | 说明 | 日志位置 |
|---------|------|---------|
| **HTTP 请求** | 请求方法、路径、状态码、耗时 | 全局 |
| **对话创建/删除** | 对话 ID、标题 | 全局 |
| **用户消息** | 用户输入内容（前 100 字符） | 对话 |
| **LLM 调用** | 模型 ID、消息数、是否使用工具、耗时 | 对话 + 全局 |
| **工具调用** | 工具名、输入、输出、成功/失败、耗时 | 对话 + 全局 |
| **MCP 连接** | 连接/断开/错误、服务器名、工具数量 | 全局 |
| **错误** | 错误消息、堆栈、上下文 | 对话 + 全局 |
| **性能指标** | 请求总耗时、LLM 调用次数、工具调用次数 | 对话 |

## 🔍 查看日志示例

### 1. 实时查看全局日志（控制台输出）

```bash
cd server
pnpm dev
```

控制台会显示带颜色的可读日志：

```
2026-03-10 11:45:02 [info] Server running at http://localhost:3001
2026-03-10 11:45:03 [info] MCP connect: context7 - 5 tool(s) available
2026-03-10 11:45:10 [info] POST /conversations → 201 (45ms)
```

### 2. 查看全局日志文件（JSON 格式）

```bash
# 查看最新的服务器日志
tail -f data/logs/server.log | jq

# 仅查看错误日志
tail -f data/logs/error.log | jq
```

### 3. 查看对话日志

```bash
# 查看某个对话的完整日志
cat data/conversations/conv_1710055000_abc123/conversation.log | jq

# 实时监控对话日志
tail -f data/conversations/conv_1710055000_abc123/conversation.log | jq
```

### 4. 分析日志示例

#### 查看所有 LLM 调用

```bash
cat data/logs/server.log | jq 'select(.type == "llm_call")'
```

#### 查看失败的工具调用

```bash
cat data/logs/server.log | jq 'select(.type == "tool_call" and .success == false)'
```

#### 统计某个对话的请求次数

```bash
cat data/conversations/conv_*/conversation.log | jq 'select(.message == "Request completed")' | wc -l
```

#### 查看平均响应时间

```bash
cat data/conversations/conv_*/conversation.log | \
  jq -r 'select(.message == "Request completed") | .durationMs' | \
  awk '{sum+=$1; n++} END {print "平均耗时:", sum/n, "ms"}'
```

## 🛠️ 在代码中使用日志

### 导入日志工具

```typescript
import {
  serverLogger,           // 全局日志
  getConversationLogger,  // 获取对话日志器
  logLLMCall,            // 记录 LLM 调用
  logToolCall,           // 记录工具调用
  logError,              // 记录错误
  logMCP,                // 记录 MCP 事件
  logConversation,       // 记录对话创建/删除
  PerformanceTimer,      // 性能计时器
} from "./lib/logger.js";
```

### 基本使用示例

```typescript
// 1. 全局日志
serverLogger.info("Server starting...");
serverLogger.error("Failed to connect", { host: "example.com", port: 3000 });

// 2. 对话日志
const logger = getConversationLogger(conversationId);
logger.info("User message received", { text: "Hello!" });
logger.debug("Processing context", { messageCount: 10 });

// 3. 记录 LLM 调用
logLLMCall(conversationId, {
  modelId: "gemini-3-flash-preview-thinking",
  provider: "google",
  messageCount: 5,
  hasTools: true,
  reasoning: true,
  durationMs: 1234,
});

// 4. 记录工具调用
logToolCall(conversationId, {
  toolName: "read_file",
  input: JSON.stringify({ path: "/path/to/file" }),
  output: "File content...",
  success: true,
  durationMs: 56,
});

// 5. 记录错误
try {
  // some code
} catch (error) {
  logError(conversationId, error, { stage: "context_build" });
}

// 6. 性能计时
const timer = new PerformanceTimer();
// ... do some work ...
logger.info("Task completed", { durationMs: timer.elapsed() });
```

## ⚙️ 配置

### 环境变量

```bash
# 设置日志级别（debug, info, warn, error）
LOG_LEVEL=debug pnpm dev

# 自定义数据目录
DATA_DIR=/custom/path pnpm dev
```

### 日志级别

- **debug**: 详细调试信息（默认在对话日志中启用）
- **info**: 一般信息（默认在全局日志中）
- **warn**: 警告信息
- **error**: 错误信息

### 日志轮转

日志文件会自动轮转：

- **全局日志**: 单文件最大 10MB，保留 5 个历史文件
- **错误日志**: 单文件最大 10MB，保留 3 个历史文件
- **对话日志**: 单文件最大 5MB，保留 2 个历史文件

## 📊 实际示例

### 对话日志示例（conversation.log）

```json
{
  "level": "info",
  "message": "User message received",
  "timestamp": "2026-03-10 11:45:10",
  "text": "帮我分析一下这个项目的性能"
}
{
  "level": "info",
  "message": "Tool call: read_file (success)",
  "timestamp": "2026-03-10 11:45:12",
  "type": "tool_call",
  "toolName": "read_file",
  "input": "{\"path\":\"/project/package.json\"}",
  "output": "{\"name\":\"my-project\"...}",
  "success": true
}
{
  "level": "info",
  "message": "Request completed",
  "timestamp": "2026-03-10 11:45:20",
  "llmCalls": 3,
  "toolCalls": 2,
  "durationMs": 10234
}
```

### 全局日志示例（server.log）

```json
{
  "level": "info",
  "message": "POST /conversations/conv_123/messages → 200 (10234ms)",
  "timestamp": "2026-03-10 11:45:20",
  "type": "http_request",
  "method": "POST",
  "path": "/conversations/conv_123/messages",
  "statusCode": 200,
  "durationMs": 10234
}
{
  "level": "debug",
  "message": "LLM call: gemini-3-flash-preview-thinking (5 msgs, with tools)",
  "timestamp": "2026-03-10 11:45:12",
  "type": "llm_call",
  "modelId": "gemini-3-flash-preview-thinking",
  "provider": "google",
  "messageCount": 5,
  "hasTools": true,
  "reasoning": true,
  "conversationId": "conv_123"
}
```

## 🚨 故障排查

### 1. 日志文件未生成

检查数据目录权限：

```bash
ls -la data/logs/
ls -la data/conversations/
```

### 2. 日志过多导致磁盘空间不足

清理旧日志：

```bash
# 删除 7 天前的日志
find data/logs/ -name "*.log.*" -mtime +7 -delete
find data/conversations/*/conversation.log.* -mtime +7 -delete
```

### 3. 查看特定时间段的日志

```bash
# 查看今天的日志
cat data/logs/server.log | jq 'select(.timestamp | startswith("2026-03-10"))'

# 查看过去 1 小时的错误
cat data/logs/error.log | jq --arg since "$(date -u -v-1H '+%Y-%m-%d %H')" \
  'select(.timestamp >= $since)'
```

## 💡 最佳实践

1. **定期检查错误日志**: `tail -f data/logs/error.log`
2. **分析性能瓶颈**: 查看 `durationMs` 字段找出慢请求
3. **调试时启用 DEBUG 级别**: `LOG_LEVEL=debug pnpm dev`
4. **生产环境使用 INFO 级别**: 减少日志量
5. **对话结束后查看完整日志**: 了解整个对话的执行流程

## 📈 监控建议

- 监控 `error.log` 的大小和增长速度
- 定期检查 LLM 调用次数和平均耗时
- 关注工具调用失败率
- 跟踪 MCP 连接稳定性

---

更新时间: 2026-03-10
