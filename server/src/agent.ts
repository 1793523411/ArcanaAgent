import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { getLLM } from "./llm.js";
import { getSkillsByIds } from "./skills.js";

type MessagesState = typeof MessagesAnnotation.State;

function getTextFromChunk(chunk: { content?: unknown }): string {
  const c = chunk.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? "")).join("");
  return "";
}

export function buildAgent(enabledSkillIds: string[] = [], modelId?: string) {
  const tools = getSkillsByIds(
    enabledSkillIds.length ? enabledSkillIds : ["calculator", "get_time", "echo"]
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
  enabledSkillIds: string[] = [],
  modelId?: string
): Promise<BaseMessage[]> {
  const agent = buildAgent(enabledSkillIds, modelId);
  const result = await agent.invoke({ messages });
  return result.messages;
}

export async function* streamAgent(
  messages: BaseMessage[],
  enabledSkillIds: string[] = []
): AsyncGenerator<Record<string, { messages?: BaseMessage[] }>, void, unknown> {
  const agent = buildAgent(enabledSkillIds);
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

/** Stream agent with token-level callback for real-time UI. Yields full state updates and calls onToken for each LLM content delta. */
export async function* streamAgentWithTokens(
  messages: BaseMessage[],
  enabledSkillIds: string[],
  onToken: (token: string) => void,
  modelId?: string
): AsyncGenerator<Record<string, { messages?: BaseMessage[] }>, void, unknown> {
  const tools = getSkillsByIds(
    enabledSkillIds.length ? enabledSkillIds : ["calculator", "get_time", "echo"]
  );
  const toolNode = new ToolNode(tools);
  const model = getLLM(modelId).bindTools(tools);
  const systemMessage = new SystemMessage("You are a helpful assistant. Use tools when needed.");
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
    const finalMessage =
      accumulatedContent
        ? new AIMessage({
            content: accumulatedContent,
            tool_calls: (fullChunk as AIMessage).tool_calls ?? [],
          })
        : fullChunk;
    state = [...state, finalMessage];
    yield { llmCall: { messages: [finalMessage] } };
    if (!shouldContinue(fullChunk)) break;
    const toolResult = await toolNode.invoke({ messages: state });
    const toolMessages = (toolResult as { messages?: BaseMessage[] }).messages ?? [];
    state = [...state, ...toolMessages];
    yield { toolNode: { messages: toolMessages } };
  }
}
