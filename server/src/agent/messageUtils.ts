import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { backgroundManager } from "./backgroundManager.js";
import { getModelContextWindow } from "../config/models.js";

export function getTextFromChunk(chunk: { content?: unknown }): string {
  const c = chunk.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? "")).join("");
  return "";
}

export function getTextFromMessage(msg: { content?: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? "")).join("");
  return "";
}

export function getReasoningFromMessage(msg: BaseMessage): string | undefined {
  const m = msg as { additional_kwargs?: { reasoning_content?: string }; content?: unknown };
  const fromKwargs = m.additional_kwargs?.reasoning_content;
  if (typeof fromKwargs === "string" && fromKwargs.trim()) return fromKwargs.trim();
  const c = m.content;
  if (!Array.isArray(c)) return undefined;
  const parts = c
    .filter((x) => x && typeof x === "object" && (
      (x as { type?: string }).type === "reasoning" ||
      (x as { type?: string }).type === "thinking"
    ))
    .map((x) => {
      const obj = x as { text?: string; thinking?: string };
      return typeof obj.thinking === "string" ? obj.thinking : (obj.text ?? "");
    })
    .join("");
  return parts.trim() || undefined;
}

export function getReasoningFromChunk(chunk: { content?: unknown; additional_kwargs?: Record<string, unknown> }): string {
  // OpenAI / DeepSeek reasoning models: reasoning_content in additional_kwargs
  const fromKwargs = chunk.additional_kwargs?.reasoning_content;
  if (typeof fromKwargs === "string" && fromKwargs) return fromKwargs;
  // Anthropic thinking models: content block array with type "thinking"/"reasoning"
  const c = chunk.content;
  if (!Array.isArray(c)) return "";
  return c
    .filter((x) => x && typeof x === "object" && (
      (x as { type?: string }).type === "reasoning" ||
      (x as { type?: string }).type === "thinking"
    ))
    .map((x) => {
      const obj = x as { text?: string; thinking?: string };
      return typeof obj.thinking === "string" ? obj.thinking : (obj.text ?? "");
    })
    .join("");
}

export function getLastAssistantText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg._getType() !== "ai") continue;
    const text = getTextFromMessage(msg).trim();
    if (text) return text;
  }
  return "";
}

export function buildBackgroundResultMessage(): HumanMessage | null {
  const notifications = backgroundManager.drainNotifications();
  if (notifications.length === 0) return null;
  const lines = notifications.map((item) => `[bg:${item.taskId}][${item.status}] ${item.result}`);
  return new HumanMessage(`<background-results>\n${lines.join("\n")}\n</background-results>`);
}

export function stringifyToolArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

export function safeParseArgs(argsStr: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsStr);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export const WRITE_FILE_SCHEMA_HINT = `write_file 需要 path（字符串）以及 content（字符串）或 content_base64（Base64 字符串）二选一。大段 HTML/CSS 强烈建议用 content_base64 传参，避免 JSON 转义问题。`;

export function getWriteFileArgsError(args: Record<string, unknown>): string | null {
  if (typeof args.path !== "string" || args.path.trim() === "") return "缺少或无效的 path（必须为非空字符串）";
  const hasContent = typeof args.content === "string" && args.content.length > 0;
  const hasBase64 = typeof args.content_base64 === "string" && args.content_base64.length > 0;
  if (!hasContent && !hasBase64) return "必须提供 content 或 content_base64 之一。大段 HTML 请用 content_base64。";
  return null;
}

export const MAX_TOOL_CALL_ROUNDS_MESSAGE = "(已达到最大工具调用轮次)";
export const NO_VISIBLE_OUTPUT_MESSAGE = "(工具调用已结束，但未生成可展示文本)";
export const FINAL_ONLY_PROMPT = "请不要继续思考，也不要调用任何工具。请直接输出给用户的最终答复正文。";

export const MAX_SINGLE_TOOL_RESULT_CHARS = 5000;
/** Per-task result cap: expanded for richer context passing */
export const MAX_TASK_TOOL_RESULT_CHARS = 16000;
/** DependsOn context cap per dependency */
export const MAX_DEPENDS_ON_SUMMARY_CHARS = 16000;
export const MIN_CONVERSATION_TOKENS_CAP = 16000;
export const CONVERSATION_TOKEN_CAP_RATIO = 0.55;
/** Maximum review-fix iterations before reporting unresolved issues */
export const MAX_REVIEW_ITERATIONS = 3;
export const MAX_CONVERSATION_TOKENS = 60_000;

export function truncateToolResult(result: string, maxChars = MAX_SINGLE_TOOL_RESULT_CHARS): string {
  if (result.length <= maxChars) return result;
  const omitted = result.length - maxChars;
  const looksLikeJson = result.trimStart().startsWith("{") || result.trimStart().startsWith("[");
  if (looksLikeJson) {
    return result.slice(0, maxChars) + `\n... [truncated ${omitted} chars, output too long]`;
  }
  const half = Math.floor(maxChars / 2);
  return `${result.slice(0, half)}\n\n... [truncated ${omitted} chars] ...\n\n${result.slice(-half)}`;
}

export function resolveConversationTokenCap(modelId?: string): number {
  let contextWindow: number;
  try {
    contextWindow = getModelContextWindow(modelId);
  } catch {
    // Config file read/parse failure — fall back to a safe default
    contextWindow = 128000;
  }
  const dynamicCap = Math.floor(contextWindow * CONVERSATION_TOKEN_CAP_RATIO);
  return Math.max(MIN_CONVERSATION_TOKENS_CAP, Math.min(MAX_CONVERSATION_TOKENS, dynamicCap));
}

export function createSubagentId(): string {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 从任务 prompt 生成简短可读的子 Agent 展示名（约 24 字内），用于 AI 名称返回前的占位 */
export function deriveSubagentName(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  const maxLen = 24;
  if (oneLine.length <= maxLen) return oneLine || "子任务";
  return oneLine.slice(0, maxLen) + "…";
}
