import { HumanMessage, AIMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import type { StoredMessage } from "../storage/index.js";
import { readAttachmentBase64, getAttachmentAbsolutePath } from "../storage/index.js";

function buildHumanContent(m: StoredMessage, convId?: string): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const attachments = m.attachments ?? [];
  if (attachments.length === 0) return m.content || " ";
  let textPart = m.content || " ";

  // Append absolute file paths so the agent knows where attachment files are on disk
  if (convId && attachments.length > 0) {
    const pathLines: string[] = [];
    attachments.forEach((a, i) => {
      if (a.file) {
        const absPath = getAttachmentAbsolutePath(convId, a.file);
        if (absPath) {
          pathLines.push(`- Attachment ${i + 1}: ${absPath} (${a.mimeType ?? "image/png"})`);
        }
      }
    });
    if (pathLines.length > 0) {
      textPart += `\n\n[Attached files on disk — use these absolute paths if you need to read/process the files]\n${pathLines.join("\n")}`;
    }
  }

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
  if (m.type === "tool") {
    return new ToolMessage({
      content: m.content,
      tool_call_id: m.tool_call_id ?? "",
      name: m.name ?? "",
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
  if (type === "tool") {
    const tool = msg as { content: string; tool_call_id?: string; name?: string };
    return {
      type: "tool",
      content: typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content ?? ""),
      tool_call_id: tool.tool_call_id,
      name: tool.name,
    };
  }
  return { type: "system", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) };
}

export function getTextContent(msg: BaseMessage): string {
  const c = (msg as { content?: string }).content;
  return typeof c === "string" ? c : "";
}
