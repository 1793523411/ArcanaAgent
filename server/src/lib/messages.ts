import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import type { StoredMessage } from "../storage/index.js";
import { readAttachmentBase64 } from "../storage/index.js";

function buildHumanContent(m: StoredMessage, convId?: string): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const attachments = m.attachments ?? [];
  if (attachments.length === 0) return m.content || " ";
  const textPart = m.content || " ";
  const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  for (const a of attachments) {
    if (a.type !== "image") continue;
    let dataUrl: string | null = null;
    if (a.data) {
      dataUrl = a.mimeType ? `data:${a.mimeType};base64,${a.data}` : `data:image/png;base64,${a.data}`;
    } else if (a.file && convId) {
      const b64 = readAttachmentBase64(convId, a.file);
      if (b64) dataUrl = `data:${a.mimeType || "image/png"};base64,${b64}`;
    }
    if (dataUrl) imageParts.push({ type: "image_url", image_url: { url: dataUrl } });
  }
  if (imageParts.length === 0) return textPart;
  return [{ type: "text", text: textPart }, ...imageParts];
}

export function storedToLangChain(m: StoredMessage, convId?: string): BaseMessage {
  if (m.type === "human") return new HumanMessage({ content: buildHumanContent(m, convId) });
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
