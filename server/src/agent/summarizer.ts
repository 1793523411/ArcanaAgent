import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getLLM } from "../llm/index.js";
import type { StoredMessage } from "../storage/index.js";

const SYSTEM_INSTRUCTION = `你是结构化对话摘要器。严格按以下格式输出，不要任何开场白或说明。
每个部分如果没有相关信息则输出"（无）"。

## 当前目标
（用户最新的请求/目标，1-2句话）

## 关键决策
（已做出的重要决定，每条一行，用 - 开头）

## 已修改文件
（文件路径列表，每个一行，用 - 开头。若无文件操作则写"（无）"）

## 遇到的错误
（关键错误及其解决状态，每条一行）

## 进行中的任务
（尚未完成的工作项）

## 重要上下文
（需要记住的关键事实、用户偏好、技术约束等）`;

const USER_TEMPLATE = `请将以下对话压缩为结构化摘要。注意提取文件路径、错误信息、用户决策等关键信息：\n\n`;

function messagesToText(msgs: StoredMessage[]): string {
  const parts: string[] = [];
  for (const m of msgs) {
    const raw = (m.content || "").trim() || "[空]";
    const truncated = raw.length > 800 ? raw.slice(0, 800) + "..." : raw;
    if (m.type === "human") parts.push(`用户：${truncated}`);
    else if (m.type === "ai") parts.push(`助手：${truncated}`);
  }
  return parts.join("\n\n");
}

export async function summarizeMessages(older: StoredMessage[], modelId?: string): Promise<string> {
  if (older.length === 0) return "";
  console.log(`[Summarizer] Starting to summarize ${older.length} messages with model ${modelId || 'default'}...`);
  const startTime = Date.now();
  const text = messagesToText(older);
  const llm = getLLM(modelId);
  const res = await llm.invoke([
    new SystemMessage(SYSTEM_INSTRUCTION),
    new HumanMessage(USER_TEMPLATE + text),
  ]);
  const content = typeof res.content === "string" ? res.content : "";
  const summary = content.trim();
  const duration = Date.now() - startTime;
  console.log(`[Summarizer] Completed in ${duration}ms, summary length: ${summary.length} chars`);
  return summary || "（摘要生成失败）";
}
