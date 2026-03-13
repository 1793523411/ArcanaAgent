import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getLLM } from "../llm/index.js";
import type { StoredMessage } from "../storage/index.js";

const SYSTEM_INSTRUCTION = `你是对话摘要器。只输出对话的摘要内容，禁止任何自我介绍、开场白或说明。
摘要需保留：角色设定、场景/剧情、用户偏好、关键决定、重要事实。若为角色扮演，写出场景、双方角色、剧情进展。用中文，150-250字。`;

const USER_TEMPLATE = `请将以下对话压缩成摘要：\n\n`;

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
