import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { getLLM } from "../llm/index.js";
import { streamChatCompletionsWithReasoning } from "../llm/streamWithReasoning.js";
import type { ToolCallResult } from "../llm/streamWithReasoning.js";
import { getToolsByIds } from "../tools/index.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { loadModelConfig } from "../config/models.js";
import { getModelReasoning } from "../config/models.js";
import { getSkillContextForAgent } from "../skills/manager.js";

type MessagesState = typeof MessagesAnnotation.State;

const BASE_SYSTEM_PROMPT = `You are a powerful AI assistant with access to tools and skills.

## Core Capabilities
- Execute shell commands and scripts via the \`run_command\` tool
- Read files via the \`read_file\` tool
- Perform calculations, get current time, and more via other tools

## How to Use Skills
When a user's request matches an available skill:
1. Read the skill's instructions carefully
2. Follow the instructions step by step
3. Use \`run_command\` to execute any scripts referenced in the skill
4. If a script requires dependencies, install them first (e.g. \`pip install ...\`)
5. Use \`read_file\` to check reference docs or saved outputs when needed

## Guidelines
- Always prefer using skill scripts when available — they are tested and reliable
- For script execution, provide the full absolute path as shown in skill instructions
- If a command fails, read the error and try to fix it (install missing deps, fix paths, etc.)
- When a skill produces file output, read and present the results to the user
- Be proactive: if a skill needs setup steps, handle them automatically`;

function buildSystemPrompt(skillContext?: string): string {
  return BASE_SYSTEM_PROMPT + (skillContext || getSkillContextForAgent());
}

const SYSTEM_PROMPT = buildSystemPrompt();

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

function safeParseArgs(argsStr: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsStr);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const CORE_TOOL_IDS = ["run_command", "read_file"];

export function buildAgent(enabledToolIds: string[] = [], modelId?: string) {
  const userTools = enabledToolIds.length ? enabledToolIds : ["calculator", "get_time", "echo"];
  const mergedIds = [...new Set([...CORE_TOOL_IDS, ...userTools])];
  const tools = getToolsByIds(mergedIds);
  const model = getLLM(modelId).bindTools(tools);
  const toolNode = new ToolNode(tools);

  const callModel = async (state: MessagesState) => {
    const response = await model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
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
  const systemMessage = new SystemMessage(buildSystemPrompt(skillContext));
  const useReasoningStream = getModelReasoning(modelId) && typeof onReasoningToken === "function";

  if (useReasoningStream) {
    try {
      const { baseUrl, apiKey, modelId: resolved } = loadModelConfig(modelId);
      const userTools = enabledToolIds.length ? enabledToolIds : ["calculator", "get_time", "echo"];
      const mergedToolIds = [...new Set([...CORE_TOOL_IDS, ...userTools])];
      const lcTools = getToolsByIds(mergedToolIds);
      const openAITools = lcTools.map((t) => convertToOpenAITool(t) as unknown as Record<string, unknown>);
      const toolMap = new Map<string, StructuredToolInterface>(lcTools.map((t) => [t.name, t]));

      let conversationMessages: BaseMessage[] = [systemMessage, ...messages];
      const maxRounds = 15;

      for (let round = 0; round < maxRounds; round++) {
        const { content, reasoningContent, toolCalls } = await streamChatCompletionsWithReasoning(
          baseUrl, apiKey, resolved, conversationMessages, onToken, onReasoningToken!, openAITools
        );

        const aiMsg = new AIMessage({
          content: content || " ",
          ...(toolCalls.length > 0 ? {
            tool_calls: toolCalls.map((tc: ToolCallResult) => ({
              id: tc.id, name: tc.name, args: safeParseArgs(tc.arguments),
            })),
          } : {}),
        });
        conversationMessages = [...conversationMessages, aiMsg];
        yield {
          llmCall: {
            messages: [aiMsg],
            ...(reasoningContent.trim() ? { reasoning: reasoningContent.trim() } : {}),
          },
        };

        if (toolCalls.length === 0) return;

        const toolMessages: BaseMessage[] = [];
        for (const tc of toolCalls) {
          const tool = toolMap.get(tc.name);
          let result: string;
          if (tool) {
            try {
              const args = safeParseArgs(tc.arguments);
              result = String(await tool.invoke(args));
            } catch (e) {
              result = `[error] ${e instanceof Error ? e.message : String(e)}`;
            }
          } else {
            result = `[error] Unknown tool: ${tc.name}`;
          }
          toolMessages.push(new ToolMessage({ content: result, tool_call_id: tc.id, name: tc.name }));
        }
        conversationMessages = [...conversationMessages, ...toolMessages];
        yield { toolNode: { messages: toolMessages } };
      }
      return;
    } catch (e) {
      // 降级：走 LangChain 流（不包含 reasoning）
    }
  }

  const userTools = enabledToolIds.length ? enabledToolIds : ["calculator", "get_time", "echo"];
  const mergedIds = [...new Set([...CORE_TOOL_IDS, ...userTools])];
  const tools = getToolsByIds(mergedIds);
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
