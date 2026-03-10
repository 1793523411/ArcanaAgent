import { createLogger, format, transports, Logger } from "winston";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const LOGS_DIR = join(DATA_DIR, "logs");
const CONVERSATIONS_DIR = join(DATA_DIR, "conversations");

// 确保日志目录存在
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

// ─── 日志格式 ─────────────────────────────────────────────

const { combine, timestamp, printf, colorize, errors } = format;

// 可读格式（用于 console）
const readableFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

// JSON 格式（用于文件）
const jsonFormat = format.json();

// ─── 全局日志（服务器级别）─────────────────────────────────

export const serverLogger: Logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), errors({ stack: true })),
  transports: [
    // Console 输出（带颜色）
    new transports.Console({
      format: combine(colorize(), readableFormat),
    }),
    // 全局日志文件（JSON 格式）
    new transports.File({
      filename: join(LOGS_DIR, "server.log"),
      format: jsonFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    // 错误日志单独记录
    new transports.File({
      filename: join(LOGS_DIR, "error.log"),
      level: "error",
      format: jsonFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

// ─── 对话级日志（每个对话独立）────────────────────────────

const conversationLoggers = new Map<string, Logger>();

/**
 * 获取对话专属日志器
 * 日志会写入 data/conversations/{convId}/conversation.log
 */
export function getConversationLogger(conversationId: string): Logger {
  if (conversationLoggers.has(conversationId)) {
    return conversationLoggers.get(conversationId)!;
  }

  const convDir = join(CONVERSATIONS_DIR, conversationId);
  if (!existsSync(convDir)) {
    mkdirSync(convDir, { recursive: true });
  }

  const logger = createLogger({
    level: "debug",
    format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), errors({ stack: true })),
    transports: [
      new transports.File({
        filename: join(convDir, "conversation.log"),
        format: jsonFormat,
        maxsize: 5 * 1024 * 1024, // 5MB
        maxFiles: 2,
      }),
    ],
  });

  conversationLoggers.set(conversationId, logger);
  return logger;
}

/**
 * 清理对话日志器（对话删除时调用）
 */
export function closeConversationLogger(conversationId: string): void {
  const logger = conversationLoggers.get(conversationId);
  if (logger) {
    logger.close();
    conversationLoggers.delete(conversationId);
  }
}

// ─── 便捷日志方法 ─────────────────────────────────────────

export interface LLMCallLog {
  modelId: string;
  provider: string;
  messageCount: number;
  hasTools: boolean;
  reasoning?: boolean;
  durationMs?: number;
  tokensEstimate?: number;
}

export interface ToolCallLog {
  toolName: string;
  input: string;
  output?: string;
  success: boolean;
  durationMs?: number;
  error?: string;
}

/**
 * 记录 LLM 调用
 */
export function logLLMCall(conversationId: string | null, data: LLMCallLog): void {
  const msg = `LLM call: ${data.modelId} (${data.messageCount} msgs, ${data.hasTools ? "with tools" : "no tools"})`;
  const meta = { type: "llm_call", ...data };

  if (conversationId) {
    getConversationLogger(conversationId).info(msg, meta);
  }
  serverLogger.debug(msg, { ...meta, conversationId });
}

/**
 * 记录工具调用
 */
export function logToolCall(conversationId: string | null, data: ToolCallLog): void {
  const status = data.success ? "success" : "failed";
  const msg = `Tool call: ${data.toolName} (${status})`;
  const meta = { type: "tool_call", ...data };

  if (conversationId) {
    const logger = getConversationLogger(conversationId);
    data.success ? logger.info(msg, meta) : logger.warn(msg, meta);
  }
  serverLogger.debug(msg, { ...meta, conversationId });
}

/**
 * 记录 HTTP 请求
 */
export function logHTTPRequest(
  method: string,
  path: string,
  statusCode?: number,
  durationMs?: number
): void {
  const msg = `${method} ${path}${statusCode ? ` → ${statusCode}` : ""}${durationMs ? ` (${durationMs}ms)` : ""}`;
  serverLogger.info(msg, { type: "http_request", method, path, statusCode, durationMs });
}

/**
 * 记录错误
 */
export function logError(
  conversationId: string | null,
  error: Error | string,
  context?: Record<string, unknown>
): void {
  const msg = error instanceof Error ? error.message : String(error);
  const meta = {
    type: "error",
    ...(error instanceof Error ? { stack: error.stack } : {}),
    ...context,
  };

  if (conversationId) {
    getConversationLogger(conversationId).error(msg, meta);
  }
  serverLogger.error(msg, { ...meta, conversationId });
}

/**
 * 记录 MCP 相关事件
 */
export function logMCP(event: "connect" | "disconnect" | "error", serverName: string, details?: string): void {
  const msg = `MCP ${event}: ${serverName}${details ? ` - ${details}` : ""}`;
  const level = event === "error" ? "error" : "info";
  serverLogger[level](msg, { type: "mcp", event, serverName, details });
}

/**
 * 记录对话创建/删除
 */
export function logConversation(event: "create" | "delete", conversationId: string, title?: string): void {
  const msg = `Conversation ${event}: ${conversationId}${title ? ` (${title})` : ""}`;
  serverLogger.info(msg, { type: "conversation", event, conversationId, title });
}

// ─── 性能跟踪工具 ─────────────────────────────────────────

/**
 * 性能计时器
 */
export class PerformanceTimer {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /** 获取已消耗时间（ms） */
  elapsed(): number {
    return Date.now() - this.startTime;
  }

  /** 重置计时器 */
  reset(): void {
    this.startTime = Date.now();
  }
}

// 导出默认 logger
export default serverLogger;
