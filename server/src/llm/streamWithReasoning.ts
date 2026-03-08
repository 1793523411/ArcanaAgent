/**
 * 直接调用 Chat Completions 流式接口并解析 delta.reasoning_content / delta.content / delta.tool_calls，
 * 供支持思考的模型使用（LangChain 可能不透传 reasoning_content）。
 */
import type { BaseMessage } from "@langchain/core/messages";

type OpenAIContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

interface OpenAIMessage {
  role: string;
  content: OpenAIContent;
  tool_call_id?: string;
  name?: string;
}

function messageToOpenAI(m: BaseMessage): OpenAIMessage {
  const type = (m as { _getType?: () => string })._getType?.() ?? "user";
  const role = type === "human" ? "user" : type === "ai" ? "assistant" : type === "tool" ? "tool" : "system";
  const c = (m as { content?: unknown }).content;

  const msg: OpenAIMessage = { role, content: " " };

  if (type === "tool") {
    const toolMsg = m as { tool_call_id?: string; name?: string };
    msg.tool_call_id = toolMsg.tool_call_id ?? "";
    msg.name = toolMsg.name;
  }

  if (typeof c === "string") {
    msg.content = c || " ";
    return msg;
  }
  if (Array.isArray(c)) {
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    for (const x of c) {
      if (!x || typeof x !== "object") continue;
      const obj = x as { type?: string; text?: string; image_url?: { url: string } };
      if (obj.type === "image_url" && obj.image_url?.url) {
        parts.push({ type: "image_url", image_url: obj.image_url });
      } else if (obj.type === "text" || typeof obj.text === "string") {
        parts.push({ type: "text", text: obj.text ?? "" });
      }
    }
    if (parts.length > 0) {
      msg.content = parts;
      return msg;
    }
  }
  return msg;
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamReasoningResult {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCallResult[];
}

export async function streamChatCompletionsWithReasoning(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: BaseMessage[],
  onToken: (token: string) => void,
  onReasoningToken: (token: string) => void,
  tools?: Array<Record<string, unknown>>,
  temperature = 0
): Promise<StreamReasoningResult> {
  const openAIMessages = messages.map(messageToOpenAI);
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";

  const body: Record<string, unknown> = {
    model: modelId,
    messages: openAIMessages,
    stream: true,
    temperature,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
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

  const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

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
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
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
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, { id: tc.id ?? "", name: "", arguments: "" });
              }
              const acc = toolCallAccum.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  }

  const toolCalls: ToolCallResult[] = Array.from(toolCallAccum.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v)
    .filter((tc) => tc.name);

  return { content, reasoningContent, toolCalls };
}
