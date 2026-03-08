/**
 * 直接调用 Chat Completions 流式接口并解析 delta.reasoning_content / delta.content，
 * 供支持思考的模型使用（LangChain 可能不透传 reasoning_content）。
 */
import type { BaseMessage } from "@langchain/core/messages";

type OpenAIContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

function messageToOpenAI(m: BaseMessage): { role: string; content: OpenAIContent } {
  const type = (m as { _getType?: () => string })._getType?.() ?? "user";
  const role = type === "human" ? "user" : type === "ai" ? "assistant" : "system";
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return { role, content: c || " " };
  if (Array.isArray(c)) {
    const parts = c
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        const obj = x as { type?: string; text?: string; image_url?: { url: string } };
        if (obj.type === "image_url" && obj.image_url?.url) return { type: "image_url" as const, image_url: obj.image_url };
        if (obj.type === "text" || typeof obj.text === "string") return { type: "text" as const, text: obj.text ?? "" };
        return null;
      })
      .filter((p): p is { type: "text" | "image_url"; text?: string; image_url?: { url: string } } => p !== null);
    if (parts.length > 0) return { role, content: parts };
  }
  return { role, content: " " };
}

export interface StreamReasoningResult {
  content: string;
  reasoningContent: string;
}

export async function streamChatCompletionsWithReasoning(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: BaseMessage[],
  onToken: (token: string) => void,
  onReasoningToken: (token: string) => void
): Promise<StreamReasoningResult> {
  const openAIMessages = messages.map(messageToOpenAI);
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: openAIMessages,
      stream: true,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`stream chat failed: ${res.status} ${t}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No body");
  const decoder = new TextDecoder();
  let content = "";
  let reasoningContent = "";
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (trimmed.startsWith("data: ")) {
        try {
          const json = JSON.parse(trimmed.slice(6)) as {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            reasoningContent += delta.reasoning_content;
            onReasoningToken(delta.reasoning_content);
          }
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            onToken(delta.content);
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  }
  return { content, reasoningContent };
}
