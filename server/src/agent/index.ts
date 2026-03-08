import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { getLLM } from "../llm/index.js";
import { streamChatCompletionsWithReasoning } from "../llm/streamWithReasoning.js";
import type { ToolCallResult } from "../llm/streamWithReasoning.js";
import { getToolsByIds, listToolIds } from "../tools/index.js";
import { getMcpTools } from "../mcp/client.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { loadModelConfig } from "../config/models.js";
import { getModelReasoning } from "../config/models.js";
import { getSkillContextForAgent } from "../skills/manager.js";

type MessagesState = typeof MessagesAnnotation.State;

const BASE_SYSTEM_PROMPT = `You are a versatile, highly capable AI assistant with access to tools, skills, and MCP (Model Context Protocol) integrations. You help users effectively with any task — from coding and data analysis to research and creative work.

## Communication
- **Match the user's language**: respond in Chinese if they write in Chinese, English for English, etc. Never mix languages unnecessarily.
- **Be concise**: avoid filler, preambles like "Sure!" or "Of course!", and unnecessary verbosity. Get straight to the point.
- **Format clearly**: use Markdown — code blocks with language tags, headers for structure, bullet points for lists, tables for comparisons.
- **Show results**: after tool execution, summarize what happened and present outputs clearly. Don't just say "done" — show the key results.

## Tool Usage Strategy
You have access to built-in tools (run_command, read_file, calculator, get_time, etc.) and possibly MCP tools from external servers.

**When to use tools vs. direct response:**
- Answer from knowledge when no system interaction is needed
- Use tools when you need to: execute code, read/write files, run commands, fetch data, or perform any system operation
- For complex tasks, plan the steps first, then execute tools sequentially, checking results between each step

**Error handling:**
- If a tool fails, read the error carefully, diagnose the issue, and retry with a fix
- Common fixes: install missing dependencies, correct file paths, adjust permissions, fix syntax
- If repeated failures occur, explain the issue to the user and suggest alternatives
- Never silently ignore errors — always report what happened

## Skills
Skills are specialized, tested capabilities defined in SKILL.md files. When a user's request matches a skill:
1. Follow the skill's instructions precisely — they are tested and reliable
2. Execute scripts with their full absolute paths via run_command
3. Install dependencies automatically if needed (pip install, npm install, etc.)
4. Use read_file to check reference docs or saved outputs when mentioned
5. Handle setup steps proactively without asking the user
6. Present skill outputs clearly and completely

## MCP Tools
Tools from MCP servers are prefixed with their server name (e.g., mcp_servername__toolname). Use them like any other tool — call with the required parameters as described.

## Safety
- **NEVER** execute destructive system commands (rm -rf /, mkfs, dd to disk, shutdown, reboot, etc.)
- **NEVER** read or expose credentials, private keys, API keys, or sensitive environment variables
- **NEVER** modify system-critical files (/etc/passwd, /etc/shadow, boot configs, etc.)
- For potentially risky operations, briefly state what you plan to do before executing
- When uncertain about safety, ask the user for confirmation

## Workspace & Artifacts
Each conversation has a dedicated workspace directory. Save ALL generated files (search results, downloads, processed data, etc.) to this workspace using absolute paths. The user can preview these files directly in the UI.

## Context Awareness
- Earlier parts of this conversation may have been summarized (marked as [此前对话摘要]) to save context space. Treat summaries as reliable context.
- If the user references something not in your available context, acknowledge this honestly and ask for clarification rather than guessing.
- When the conversation is long, briefly recap relevant context before diving into a complex task.`;

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

function getAllTools(): StructuredToolInterface[] {
  const allIds = listToolIds();
  const builtIn = getToolsByIds(allIds);
  const mcp = getMcpTools();
  return [...builtIn, ...mcp];
}

export function buildAgent(modelId?: string) {
  const tools = getAllTools();
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
  modelId?: string,
  skillContext?: string
): Promise<BaseMessage[]> {
  const tools = getAllTools();
  const systemMessage = new SystemMessage(buildSystemPrompt(skillContext));
  const model = getLLM(modelId).bindTools(tools);
  const toolNode = new ToolNode(tools);

  const callModel = async (state: MessagesState) => {
    const response = await model.invoke([systemMessage, ...state.messages]);
    return { messages: [response] };
  };

  const shouldContinue = (state: MessagesState): "toolNode" | typeof END => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (
      lastMessage &&
      "tool_calls" in lastMessage &&
      Array.isArray(lastMessage.tool_calls) &&
      lastMessage.tool_calls.length > 0
    ) return "toolNode";
    return END;
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("llmCall", callModel)
    .addNode("toolNode", toolNode)
    .addEdge(START, "llmCall")
    .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
    .addEdge("toolNode", "llmCall")
    .compile();

  const result = await graph.invoke({ messages });
  return result.messages;
}

export async function* streamAgentWithTokens(
  messages: BaseMessage[],
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
      const tools = getAllTools();
      const openAITools = tools.map((t) => convertToOpenAITool(t) as unknown as Record<string, unknown>);
      const toolMap = new Map<string, StructuredToolInterface>(tools.map((t) => [t.name, t]));

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
      console.warn("[Agent] Reasoning stream failed, falling back to standard LangChain stream:", e instanceof Error ? e.message : String(e));
    }
  }

  const tools = getAllTools();
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
