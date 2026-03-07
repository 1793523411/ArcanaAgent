import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import type { StoredMessage } from "./storage.js";

export function storedToLangChain(m: StoredMessage): BaseMessage {
  if (m.type === "human") return new HumanMessage(m.content);
  if (m.type === "ai") {
    return new AIMessage({
      content: m.content,
      tool_calls: m.tool_calls as never,
    });
  }
  return new SystemMessage(m.content);
}

export function langChainToStored(msg: BaseMessage): StoredMessage {
  const type = msg._getType();
  if (type === "human") return { type: "human", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) };
  if (type === "ai") {
    const ai = msg as { content: string; tool_calls?: Array<{ name: string; args: string }> };
    return {
      type: "ai",
      content: typeof ai.content === "string" ? ai.content : JSON.stringify(ai.content ?? ""),
      tool_calls: ai.tool_calls?.map((tc) => ({ name: tc.name, args: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args) })),
    };
  }
  return { type: "system", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) };
}

export function getTextContent(msg: BaseMessage): string {
  const c = (msg as { content?: string }).content;
  return typeof c === "string" ? c : "";
}
