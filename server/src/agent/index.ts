import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { getModelAdapter } from "../llm/adapter.js";
import type { ToolCallResult } from "../llm/adapter.js";
import { getToolsByIds, listToolIds } from "../tools/index.js";
import { getMcpTools } from "../mcp/client.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { getSkillContextForAgent } from "../skills/manager.js";
import { serverLogger } from "../lib/logger.js";

type MessagesState = typeof MessagesAnnotation.State;

const BASE_SYSTEM_PROMPT = `You are a versatile, highly capable AI assistant with access to tools, skills, and MCP (Model Context Protocol) integrations. You help users effectively with any task — from coding and data analysis to research and creative work.

## Communication
- **Match the user's language**: respond in Chinese if they write in Chinese, English for English, etc. Never mix languages unnecessarily.
- **Be concise**: avoid filler, preambles like "Sure!" or "Of course!", and unnecessary verbosity. Get straight to the point.
- **Format clearly**: use Markdown — code blocks with language tags, headers for structure, bullet points for lists, tables for comparisons.
- **Show results**: after tool execution, summarize what happened and present outputs clearly. Don't just say "done" — show the key results.

## Tool Usage Strategy
You have access to built-in tools (run_command, read_file, calculator, get_time, etc.) and MCP tools from external servers (listed below if connected).

**When to use tools vs. direct response:**
- Answer from knowledge when no system interaction is needed
- Use tools when you need to: execute code, read/write files, run commands, fetch data, or perform any system operation
- For complex tasks, plan the steps first, then execute tools sequentially, checking results between each step

**CRITICAL — Always provide a final text response:**
- After ALL tool calls are complete, you MUST generate a clear text response summarizing the results, findings, or output for the user.
- NEVER end your turn with only tool calls and no text — the user needs to see a human-readable summary.
- If tools produced data or files, present the key results, not just "done".
- If a multi-step task is complete, provide a structured summary of what was accomplished.

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

function buildMcpToolsSection(): string {
  const mcpTools = getMcpTools();
  if (mcpTools.length === 0) return "";
  const lines = mcpTools.map((t) => `- \`${t.name}\`: ${t.description ?? t.name}`);
  return `\n\n## Available MCP Tools\nThe following MCP tools are currently connected and ready to use. Call them directly without asking the user for tool names:\n${lines.join("\n")}`;
}

function buildSystemPrompt(skillContext?: string): string {
  return BASE_SYSTEM_PROMPT + buildMcpToolsSection() + (skillContext || getSkillContextForAgent());
}

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
    .filter((x) => x && typeof x === "object" && (
      (x as { type?: string }).type === "reasoning" ||
      (x as { type?: string }).type === "thinking"
    ))
    .map((x) => {
      const obj = x as { text?: string; thinking?: string };
      return typeof obj.thinking === "string" ? obj.thinking : (obj.text ?? "");
    })
    .join("");
  return parts.trim() || undefined;
}

function getReasoningFromChunk(chunk: { content?: unknown }): string {
  const c = chunk.content;
  if (!Array.isArray(c)) return "";
  return c
    .filter((x) => x && typeof x === "object" && (
      (x as { type?: string }).type === "reasoning" ||
      (x as { type?: string }).type === "thinking"
    ))
    .map((x) => {
      const obj = x as { text?: string; thinking?: string };
      return typeof obj.thinking === "string" ? obj.thinking : (obj.text ?? "");
    })
    .join("");
}

function safeParseArgs(argsStr: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsStr);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const WRITE_FILE_SCHEMA_HINT = `write_file 需要 path（字符串）以及 content（字符串）或 content_base64（Base64 字符串）二选一。大段 HTML/CSS 强烈建议用 content_base64 传参，避免 JSON 转义问题。`;

function getWriteFileArgsError(args: Record<string, unknown>): string | null {
  if (typeof args.path !== "string" || args.path.trim() === "") return "缺少或无效的 path（必须为非空字符串）";
  const hasContent = typeof args.content === "string" && args.content.length > 0;
  const hasBase64 = typeof args.content_base64 === "string" && args.content_base64.length > 0;
  if (!hasContent && !hasBase64) return "必须提供 content 或 content_base64 之一。大段 HTML 请用 content_base64。";
  return null;
}

function getAllTools(): StructuredToolInterface[] {
  const allIds = listToolIds();
  const builtIn = getToolsByIds(allIds);
  const mcp = getMcpTools();
  return [...builtIn, ...mcp];
}

export function buildAgent(modelId?: string) {
  const tools = getAllTools();
  const model = getModelAdapter(modelId).getLLM().bindTools(tools);
  const toolNode = new ToolNode(tools);

  const callModel = async (state: MessagesState) => {
    const response = await model.invoke([
      new SystemMessage(buildSystemPrompt()),
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
  const model = getModelAdapter(modelId).getLLM().bindTools(tools);
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
  const adapter = getModelAdapter(modelId);
  const useReasoningStream = adapter.supportsReasoningStream() && typeof onReasoningToken === "function";

  if (useReasoningStream) {
    try {
      const tools = getAllTools();
      const openAITools = tools.map((t) => convertToOpenAITool(t) as unknown as Record<string, unknown>);
      const toolMap = new Map<string, StructuredToolInterface>(tools.map((t) => [t.name, t]));

      let conversationMessages: BaseMessage[] = [systemMessage, ...messages];
      const maxRounds = 50;

      let lastHadContent = false;
      for (let round = 0; round < maxRounds; round++) {
        const { content, reasoningContent, toolCalls } = await adapter.streamSingleTurn(
          conversationMessages, onToken, onReasoningToken!, openAITools
        );

        lastHadContent = !!(content && content.trim());
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

        // 如果没有工具调用，检查是否需要生成总结
        if (toolCalls.length === 0) {
          // 如果最后一轮没有内容，强制生成总结
          if (!lastHadContent) {
            const { content: finalContent, reasoningContent: finalReasoning } = await adapter.streamSingleTurn(
              conversationMessages, onToken, onReasoningToken!, []
            );
            const summaryMsg = new AIMessage({ content: finalContent || "(已达到最大工具调用轮次)" });
            yield {
              llmCall: {
                messages: [summaryMsg],
                ...(finalReasoning?.trim() ? { reasoning: finalReasoning.trim() } : {}),
              },
            };
          }
          return;
        }

        const toolMessages: BaseMessage[] = [];
        for (const tc of toolCalls) {
          const tool = toolMap.get(tc.name);
          let result: string;
          if (tool) {
            const args = safeParseArgs(tc.arguments);
            if (tc.name === "write_file") {
              const argsErr = getWriteFileArgsError(args as { path?: unknown; content?: unknown });
              if (argsErr) {
                result = `[error] ${argsErr} ${WRITE_FILE_SCHEMA_HINT}`;
              } else {
                try {
                  result = String(await tool.invoke(args));
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  result = msg.includes("expected schema") ? `[error] ${msg} ${WRITE_FILE_SCHEMA_HINT}` : `[error] ${msg}`;
                }
              }
            } else {
              try {
                result = String(await tool.invoke(args));
              } catch (e) {
                result = `[error] ${e instanceof Error ? e.message : String(e)}`;
              }
            }
          } else {
            result = `[error] Unknown tool: ${tc.name}`;
          }
          toolMessages.push(new ToolMessage({ content: result, tool_call_id: tc.id, name: tc.name }));
        }
        conversationMessages = [...conversationMessages, ...toolMessages];
        yield { toolNode: { messages: toolMessages } };
      }

      if (!lastHadContent) {
        const { content: finalContent, reasoningContent: finalReasoning } = await adapter.streamSingleTurn(
          conversationMessages, onToken, onReasoningToken!, []
        );
        const summaryMsg = new AIMessage({ content: finalContent || "(已达到最大工具调用轮次)" });
        yield {
          llmCall: {
            messages: [summaryMsg],
            ...(finalReasoning?.trim() ? { reasoning: finalReasoning.trim() } : {}),
          },
        };
      }
      return;
    } catch (e) {
      serverLogger.warn("Reasoning stream failed, falling back to standard LangChain stream", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const tools = getAllTools();
  const toolNode = new ToolNode(tools);
  const model = adapter.getLLM().bindTools(tools);
  const modelNoTools = adapter.getLLM();
  let state: BaseMessage[] = [...messages];
  const maxRounds = 50;

  const shouldContinue = (last: BaseMessage): boolean => {
    return !!(
      last &&
      "tool_calls" in last &&
      Array.isArray(last.tool_calls) &&
      last.tool_calls.length > 0
    );
  };

  let lastHadContent = false;
  for (let round = 0; round < maxRounds; round++) {
    const stream = await model.stream([systemMessage, ...state]);
    let fullChunk: BaseMessage | null = null;
    let accumulatedContent = "";
    let accumulatedReasoning = "";
    for await (const chunk of stream) {
      const text = getTextFromChunk(chunk);
      if (text) {
        onToken(text);
        accumulatedContent += text;
      }
      const reasoningChunk = getReasoningFromChunk(chunk);
      if (reasoningChunk) {
        accumulatedReasoning += reasoningChunk;
        if (onReasoningToken) onReasoningToken(reasoningChunk);
      }
      if (fullChunk && "concat" in fullChunk && typeof (fullChunk as { concat: (other: BaseMessage) => BaseMessage }).concat === "function") {
        fullChunk = (fullChunk as { concat: (other: BaseMessage) => BaseMessage }).concat(chunk as BaseMessage) as BaseMessage;
      } else {
        fullChunk = chunk as BaseMessage;
      }
    }
    if (!fullChunk) break;
    const fromChunk = getTextFromMessage(fullChunk);
    const content = accumulatedContent || fromChunk;
    lastHadContent = !!(content && content.trim());
    const finalMessage =
      content || (fullChunk as AIMessage).tool_calls?.length
        ? new AIMessage({
            content: content || " ",
            tool_calls: (fullChunk as AIMessage).tool_calls ?? [],
          })
        : fullChunk;
    state = [...state, finalMessage];
    const reasoning = accumulatedReasoning.trim() || getReasoningFromMessage(fullChunk);
    yield { llmCall: { messages: [finalMessage], ...(reasoning ? { reasoning } : {}) } };
    if (!shouldContinue(fullChunk)) break;
    const toolResult = await toolNode.invoke({ messages: state });
    let toolMessages = (toolResult as { messages?: BaseMessage[] }).messages ?? [];
    toolMessages = toolMessages.map((m: BaseMessage) => {
      if (m._getType() !== "tool") return m;
      const content = typeof m.content === "string" ? m.content : "";
      const tm = m as { name?: string; tool_call_id?: string };
      if (tm.name === "write_file" && content.includes("expected schema")) {
        return new ToolMessage({
          content: `[error] 工具参数格式不符合要求。${WRITE_FILE_SCHEMA_HINT}`,
          tool_call_id: tm.tool_call_id ?? "",
          name: tm.name ?? "write_file",
        });
      }
      return m;
    });
    state = [...state, ...toolMessages];
    yield { toolNode: { messages: toolMessages } };
  }

  if (!lastHadContent && state.length > messages.length) {
    const summaryStream = await modelNoTools.stream([systemMessage, ...state]);
    let summaryContent = "";
    for await (const chunk of summaryStream) {
      const text = getTextFromChunk(chunk);
      if (text) {
        onToken(text);
        summaryContent += text;
      }
    }
    const summaryMsg = new AIMessage({ content: summaryContent || "(已达到最大工具调用轮次)" });
    yield { llmCall: { messages: [summaryMsg] } };
  }
}
