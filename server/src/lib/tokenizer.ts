import type { StoredMessage } from "../storage/index.js";
import type { BaseMessage } from "@langchain/core/messages";

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Split text into tokens that work for both CJK and Latin text.
 * CJK characters are yielded as bigrams (2-char sliding window) so that
 * "项目管理" becomes ["项目", "目管", "管理"] — much better matching than
 * single chars, without needing a dictionary-based segmenter.
 * Latin words are split on whitespace/punctuation as before.
 */
export function splitTokens(text: string): string[] {
  const tokens: string[] = [];
  // First split on whitespace/punctuation to separate Latin words from CJK runs
  const parts = text.split(/[\s,;.!?，。！？、；：""''（）【】\-_/\\]+/);
  for (const part of parts) {
    if (!part) continue;
    // Check if this part contains CJK characters
    if (CJK_RANGE.test(part)) {
      // Extract CJK runs and generate bigrams
      let cjkRun = "";
      let latinRun = "";
      for (const ch of part) {
        if (CJK_RANGE.test(ch)) {
          if (latinRun.length > 1) tokens.push(latinRun);
          latinRun = "";
          cjkRun += ch;
        } else {
          if (cjkRun.length > 0) {
            // Emit bigrams from the CJK run
            if (cjkRun.length === 1) tokens.push(cjkRun);
            for (let i = 0; i < cjkRun.length - 1; i++) {
              tokens.push(cjkRun[i] + cjkRun[i + 1]);
            }
            cjkRun = "";
          }
          latinRun += ch;
        }
      }
      // Flush remaining
      if (cjkRun.length === 1) tokens.push(cjkRun);
      for (let i = 0; i < cjkRun.length - 1; i++) {
        tokens.push(cjkRun[i] + cjkRun[i + 1]);
      }
      if (latinRun.length > 1) tokens.push(latinRun);
    } else {
      // Pure Latin/ASCII word
      if (part.length > 2) tokens.push(part);
    }
  }
  return tokens;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const other = len - chinese;
  const chineseTokens = Math.ceil(chinese / 1.5);
  const otherTokens = Math.ceil(other / 4);
  return chineseTokens + otherTokens;
}

const IMAGE_TOKENS_ESTIMATE = 500;
const MESSAGE_OVERHEAD_TOKENS = 4;

function estimatePartTokens(part: unknown): number {
  if (!part) return 0;
  if (typeof part === "string") return estimateTextTokens(part);
  if (Array.isArray(part)) return part.reduce((sum, item) => sum + estimatePartTokens(item), 0);
  if (typeof part !== "object") return estimateTextTokens(String(part));
  const record = part as {
    type?: string;
    text?: string;
    image_url?: unknown;
    input_text?: string;
    input_image?: unknown;
    content?: unknown;
  };
  if (record.type === "text" && typeof record.text === "string") return estimateTextTokens(record.text);
  if (record.type === "input_text" && typeof record.input_text === "string") return estimateTextTokens(record.input_text);
  if (record.type === "image_url" || record.type === "input_image") return IMAGE_TOKENS_ESTIMATE;
  if (record.image_url || record.input_image) return IMAGE_TOKENS_ESTIMATE;
  if (record.content) return estimatePartTokens(record.content);
  return estimateTextTokens(JSON.stringify(record));
}

export function estimateMessageTokens(m: StoredMessage): number {
  // 与 estimateBaseMessageTokens 共用同一估算口径，避免上下文估算与 usage 回退出现两套算法。
  let t = estimatePartTokens(m.content ?? "");
  const attachments = m.attachments ?? [];
  for (const a of attachments) {
    if (a.type === "image") t += IMAGE_TOKENS_ESTIMATE;
  }
  return t + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateContextTokens(messages: StoredMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

export function estimateBaseMessageTokens(messages: BaseMessage[]): number {
  // 用于 API 层 usage 回退估算，兼容文本与多模态消息结构。
  let total = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    total += estimatePartTokens(content);
    // AIMessage 的 tool_calls 也占 token：每个 call 包含 name + JSON args
    const toolCalls = (m as unknown as { tool_calls?: Array<{ name?: string; args?: unknown }> }).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        total += estimateTextTokens(tc.name ?? "");
        const argsStr = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {});
        total += estimateTextTokens(argsStr);
      }
    }
    total += MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}
