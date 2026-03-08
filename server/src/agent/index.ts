import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { getLLM } from "../llm/index.js";
import { streamChatCompletionsWithReasoning } from "../llm/streamWithReasoning.js";
import { getToolsByIds } from "../tools/index.js";
import { loadModelConfig } from "../config/models.js";
import { getModelReasoning } from "../config/models.js";

type MessagesState = typeof MessagesAnnotation.State;

function getTextFromChunk(chunk: { content?: unknown }): string {
  const c = chunk.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? "")).join("");
  return "";
}

function getTextFromMessage(msg: { content?: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? "")).join("");
  return "";
}

/** 从消息中提取推理/思考内容（additional_kwargs.reasoning_content 或 content 数组中 type 为 reasoning 的项） */
function getReasoningFromMessage(msg: BaseMessage): string | undefined {
  const m = msg as { additional_kwargs?: { reasoning_content?: string }; content?: unknown };
  const fromKwargs = m.additional_kwargs?.reasoning_content;
  if (typeof fromKwargs === "string" && fromKwargs.trim()) return fromKwargs.trim();
  const c = m.content;
  if (!Array.isArray(c)) return undefined;
  const parts = c
    .filter((x) => x && typeof x === "object" && (x as { type?: string }).type === "reasoning")
    .map((x) => (typeof (x as { text?: string }).text === "string" ? (x as { text: string }).text : ""))
    .join("");
  return parts.trim() || undefined;
}

export function buildAgent(enabledToolIds: string[] = [], modelId?: string) {
  const tools = getToolsByIds(
    enabledToolIds.length ? enabledToolIds : ["calculator", "get_time", "echo"]
  );
  const model = getLLM(modelId).bindTools(tools);
  const toolNode = new ToolNode(tools);

  const callModel = async (state: MessagesState) => {
    const response = await model.invoke([
      new SystemMessage("You are a helpful assistant. Use tools when needed."),
      ...state.messages,
    ]);
    return { messages: [response] };
  };

  const shouldContinue = (state: MessagesState): "toolNode" | typeof END => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (
      lastMessage &&
      "tool_calls" in lastMessage &&
      Array.isArray(lastMessage.tool_calls) &&
      lastMessage.tool_calls.length > 0
    ) {
      return "toolNode";
    }
    return END;
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("llmCall", callModel)
    .addNode("toolNode", toolNode)
    .addEdge(START, "llmCall")
    .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
    .addEdge("toolNode", "llmCall");

  return graph.compile();
}

export async function runAgent(
  messages: BaseMessage[],
  enabledToolIds: string[] = [],
  modelId?: string
): Promise<BaseMessage[]> {
  const agent = buildAgent(enabledToolIds, modelId);
  const result = await agent.invoke({ messages });
  return result.messages;
}

export async function* streamAgent(
  messages: BaseMessage[],
  enabledToolIds: string[] = []
): AsyncGenerator<Record<string, { messages?: BaseMessage[] }>, void, unknown> {
  const agent = buildAgent(enabledToolIds);
  const stream = await agent.stream(
    { messages },
    { streamMode: "updates" }
  );
  for await (const chunk of stream) {
    if (chunk && typeof chunk === "object") {
      yield chunk as Record<string, { messages?: BaseMessage[] }>;
    }
  }
}

export async function* streamAgentWithTokens(
  messages: BaseMessage[],
  enabledToolIds: string[],
  onToken: (token: string) => void,
  modelId?: string,
  onReasoningToken?: (token: string) => void,
  skillContext?: string
): AsyncGenerator<Record<string, { messages?: BaseMessage[] }>, void, unknown> {
  const systemText = "You are a helpful assistant. Use tools when needed." + (skillContext ?? "");
  const systemMessage = new SystemMessage(systemText);
  const useReasoningStream = getModelReasoning(modelId) && typeof onReasoningToken === "function";

  if (useReasoningStream) {
    try {
      const { baseUrl, apiKey, modelId: resolved } = loadModelConfig(modelId);
      const inputMessages = [systemMessage, ...messages];
      const { content, reasoningContent } = await streamChatCompletionsWithReasoning(
        baseUrl,
        apiKey,
        resolved,
        inputMessages,
        onToken,
        onReasoningToken
      );
      const finalMessage = new AIMessage({ content: content || " " });
      yield { llmCall: { messages: [finalMessage], ...(reasoningContent.trim() ? { reasoning: reasoningContent.trim() } : {}) } };
      return;
    } catch (e) {
      // 降级：走 LangChain 流（不包含 reasoning）
    }
  }

  const tools = getToolsByIds(
    enabledToolIds.length ? enabledToolIds : ["calculator", "get_time", "echo"]
  );
  const toolNode = new ToolNode(tools);
  const model = getLLM(modelId).bindTools(tools);
  let state: BaseMessage[] = [...messages];

  const shouldContinue = (last: BaseMessage): boolean => {
    return !!(
      last &&
      "tool_calls" in last &&
      Array.isArray(last.tool_calls) &&
      last.tool_calls.length > 0
    );
  };

  while (true) {
    const stream = await model.stream([systemMessage, ...state]);
    let fullChunk: BaseMessage | null = null;
    let accumulatedContent = "";
    for await (const chunk of stream) {
      const text = getTextFromChunk(chunk);
      if (text) {
        onToken(text);
        accumulatedContent += text;
      }
      if (fullChunk && "merge" in fullChunk && typeof (fullChunk as { merge: (other: BaseMessage) => BaseMessage }).merge === "function") {
        fullChunk = (fullChunk as { merge: (other: BaseMessage) => BaseMessage }).merge(chunk as BaseMessage) as BaseMessage;
      } else {
        fullChunk = chunk as BaseMessage;
      }
    }
    if (!fullChunk) break;
    const fromChunk = getTextFromMessage(fullChunk);
    const content = accumulatedContent || fromChunk;
    const finalMessage =
      content || (fullChunk as AIMessage).tool_calls?.length
        ? new AIMessage({
            content: content || " ",
            tool_calls: (fullChunk as AIMessage).tool_calls ?? [],
          })
        : fullChunk;
    state = [...state, finalMessage];
    const reasoning = getReasoningFromMessage(fullChunk);
    yield { llmCall: { messages: [finalMessage], ...(reasoning ? { reasoning } : {}) } };
    if (!shouldContinue(fullChunk)) break;
    const toolResult = await toolNode.invoke({ messages: state });
    const toolMessages = (toolResult as { messages?: BaseMessage[] }).messages ?? [];
    state = [...state, ...toolMessages];
    yield { toolNode: { messages: toolMessages } };
  }
}
