#!/usr/bin/env node
/**
 * 测试日志系统
 * 运行: npx tsx src/scripts/test-logger.ts
 */

import {
  serverLogger,
  getConversationLogger,
  logLLMCall,
  logToolCall,
  logError,
  logMCP,
  logConversation,
  logHTTPRequest,
  PerformanceTimer,
} from "../lib/logger.js";

console.log("\n=== 日志系统测试 ===\n");

// 1. 测试全局日志
console.log("1. 测试全局日志...");
serverLogger.info("This is an info message");
serverLogger.warn("This is a warning message");
serverLogger.debug("This is a debug message (only in files)");

// 2. 测试对话日志
console.log("2. 测试对话日志...");
const testConvId = "test_conv_" + Date.now();
const convLogger = getConversationLogger(testConvId);
convLogger.info("对话开始", { userId: "test_user" });
convLogger.debug("处理上下文", { messageCount: 5 });

// 3. 测试 LLM 调用日志
console.log("3. 测试 LLM 调用日志...");
logLLMCall(testConvId, {
  modelId: "gemini-3-flash-preview-thinking",
  provider: "google",
  messageCount: 3,
  hasTools: true,
  reasoning: true,
  durationMs: 1234,
  tokensEstimate: 500,
});

// 4. 测试工具调用日志
console.log("4. 测试工具调用日志...");
logToolCall(testConvId, {
  toolName: "read_file",
  input: JSON.stringify({ path: "/test/file.txt" }),
  output: "Test file content",
  success: true,
  durationMs: 56,
});

logToolCall(testConvId, {
  toolName: "run_command",
  input: JSON.stringify({ command: "ls -la" }),
  success: false,
  error: "Permission denied",
});

// 5. 测试 MCP 日志
console.log("5. 测试 MCP 日志...");
logMCP("connect", "test-server", "3 tools available");
logMCP("error", "test-server", "Connection timeout");
logMCP("disconnect", "test-server");

// 6. 测试对话事件日志
console.log("6. 测试对话事件日志...");
logConversation("create", testConvId, "测试对话");

// 7. 测试 HTTP 请求日志
console.log("7. 测试 HTTP 请求日志...");
logHTTPRequest("POST", "/conversations/test/messages", 200, 1500);
logHTTPRequest("GET", "/conversations", 200, 45);

// 8. 测试错误日志
console.log("8. 测试错误日志...");
const testError = new Error("This is a test error");
logError(testConvId, testError, { stage: "test", userId: "test_user" });

logError(null, "String error message", { context: "global" });

// 9. 测试性能计时器
console.log("9. 测试性能计时器...");
const timer = new PerformanceTimer();
// 模拟一些工作
await new Promise((resolve) => setTimeout(resolve, 100));
convLogger.info("任务完成", { durationMs: timer.elapsed() });

// 10. 测试对话删除（清理日志器）
console.log("10. 测试日志清理...");
logConversation("delete", testConvId);

console.log("\n=== 测试完成 ===\n");
console.log("日志文件位置:");
console.log("- 全局日志: data/logs/server.log");
console.log("- 错误日志: data/logs/error.log");
console.log(`- 对话日志: data/conversations/${testConvId}/conversation.log\n`);

console.log("查看日志命令:");
console.log("  tail -f data/logs/server.log | jq");
console.log(`  cat data/conversations/${testConvId}/conversation.log | jq\n`);
