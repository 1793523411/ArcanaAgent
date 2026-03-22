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
    // 恢复 tool_calls 并确保 id 存在
    const toolCalls = m.tool_calls?.map((tc, index) => ({
      id: tc.id || `call_restored_${index}`,
      name: tc.name,
      args: typeof tc.args === "string" ? (() => { try { return JSON.parse(tc.args); } catch { return tc.args; } })() : tc.args,
    }));
    return new AIMessage({
      content: m.content,
      tool_calls: toolCalls,
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

/** Extract plain text from content that may be a string or Anthropic content block array */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((x) => x && typeof x === "object" && (x as { type?: string }).type === "text")
      .map((x) => (x as { text?: string }).text ?? "")
      .join("");
  }
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

/** Extract reasoning/thinking content from Anthropic content block array */
function extractReasoningContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((x) => x && typeof x === "object" && (
      (x as { type?: string }).type === "thinking" ||
      (x as { type?: string }).type === "reasoning"
    ))
    .map((x) => {
      const obj = x as { text?: string; thinking?: string };
      return typeof obj.thinking === "string" ? obj.thinking : (obj.text ?? "");
    })
    .join("");
  return parts.trim() || undefined;
}

export function langChainToStored(msg: BaseMessage): StoredMessage {
  const type = msg._getType();
  if (type === "human") return { type: "human", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) };
  if (type === "ai") {
    const ai = msg as { content: unknown; tool_calls?: Array<{ id?: string; name: string; args: string }>; additional_kwargs?: { reasoning_content?: string } };
    const textContent = extractTextContent(ai.content);
    // Extract reasoning from Anthropic content blocks or additional_kwargs
    const reasoning = extractReasoningContent(ai.content)
      ?? (typeof ai.additional_kwargs?.reasoning_content === "string" ? ai.additional_kwargs.reasoning_content : undefined);
    return {
      type: "ai",
      content: textContent,
      tool_calls: ai.tool_calls?.map((tc) => ({ id: tc.id, name: tc.name, args: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args) })),
      ...(reasoning ? { reasoningContent: reasoning } : {}),
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

/**
 * 修复消息序列中的孤立 tool messages。
 * 如果 tool 消息没有前置 AI 消息包含匹配的 tool_call_id，
 * 则补充缺失的 tool_calls 到已有 AI 消息或插入合成 AI 消息。
 */
export function sanitizeMessageSequence(messages: StoredMessage[]): StoredMessage[] {
  const result: StoredMessage[] = [];

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];

    if (m.type !== "tool") {
      result.push(m);
      i++;
      continue;
    }

    // 收集连续的 tool messages
    const toolGroup: StoredMessage[] = [];
    while (i < messages.length && messages[i].type === "tool") {
      toolGroup.push(messages[i]);
      i++;
    }

    // 检查前置 AI 消息是否包含这些 tool_call_id
    const lastIdx = result.length - 1;
    const prevMsg = lastIdx >= 0 ? result[lastIdx] : null;
    const prevIsAi = prevMsg?.type === "ai";
    const prevToolCallIds = new Set(
      prevIsAi && prevMsg!.tool_calls
        ? prevMsg!.tool_calls.map((tc) => tc.id).filter(Boolean)
        : []
    );

    // 收集未匹配的 tool messages 并为它们生成 tool_calls
    const missingToolCalls: Array<{ id: string; name: string; args: string }> = [];
    for (let j = 0; j < toolGroup.length; j++) {
      const t = toolGroup[j];
      if (!t.tool_call_id || !prevToolCallIds.has(t.tool_call_id)) {
        const synId = t.tool_call_id || `call_synthetic_${Date.now()}_${j}`;
        if (!t.tool_call_id) {
          toolGroup[j] = { ...t, tool_call_id: synId };
        }
        missingToolCalls.push({
          id: synId,
          name: t.name || "unknown",
          args: "{}",
        });
      }
    }

    if (missingToolCalls.length > 0) {
      if (prevIsAi) {
        // 补充 missing tool_calls 到已有 AI 消息
        result[lastIdx] = {
          ...prevMsg!,
          tool_calls: [...(prevMsg!.tool_calls || []), ...missingToolCalls],
        };
      } else {
        // 插入合成 AI 消息
        result.push({
          type: "ai",
          content: "",
          tool_calls: missingToolCalls,
        });
      }
    }

    result.push(...toolGroup);
  }

  return result;
}
