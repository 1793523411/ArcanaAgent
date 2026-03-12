import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { getModelAdapter } from "../llm/adapter.js";
import type { ToolCallResult } from "../llm/adapter.js";
import { getToolsByIds, listToolIds } from "../tools/index.js";
import { getMcpTools } from "../mcp/client.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { getSkillContextForAgent } from "../skills/manager.js";
import { serverLogger } from "../lib/logger.js";
import { buildPlanningPrelude } from "./planning.js";
import { resolve } from "path";

type MessagesState = typeof MessagesAnnotation.State;
export interface PlanStreamEvent {
  phase: "created" | "running" | "completed";
  steps: string[];
  currentStep: number;
  toolName?: string;
}

interface AgentExecutionOptions {
  planningEnabled?: boolean;
  workspacePath?: string;
}

interface StreamAgentOptions extends AgentExecutionOptions {
  planProgressEnabled?: boolean;
  onPlanEvent?: (event: PlanStreamEvent) => void;
}

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
- For run_command, if output contains signal \`__RUN_COMMAND_SUCCESS__\`, treat the command as completed successfully
- For run_command, if output contains signal \`__RUN_COMMAND_DUPLICATE_SKIPPED__\`, do not repeat the same command; move to next step or summarize

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

const MAX_TOOL_CALL_ROUNDS_MESSAGE = "(已达到最大工具调用轮次)";
const NO_VISIBLE_OUTPUT_MESSAGE = "(工具调用已结束，但未生成可展示文本)";
const FINAL_ONLY_PROMPT = "请不要继续思考，也不要调用任何工具。请直接输出给用户的最终答复正文。";

function getAllTools(): StructuredToolInterface[] {
  const allIds = listToolIds();
  const builtIn = getToolsByIds(allIds);
  const mcp = getMcpTools();
  return [...builtIn, ...mcp];
}

function isPathInWorkspace(pathText: string, workspacePath: string): boolean {
  const workspace = resolve(workspacePath);
  const target = resolve(pathText);
  return target === workspace || target.startsWith(`${workspace}/`);
}

function isLikelyProjectMirrorPath(pathText: string): boolean {
  const normalized = pathText.replace(/\\/g, "/").replace(/^['"]|['"]$/g, "");
  return (
    normalized.startsWith("data/conversations/") ||
    normalized.startsWith("./data/conversations/") ||
    normalized.includes("/data/conversations/")
  );
}

function findForbiddenOutputPath(command: string, workspacePath: string): string | null {
  const outputFlagRegex = /(?:^|\s)(?:-o|--output|--out|--out-dir|--output-dir)\s+([^\s"']+|"[^"]+"|'[^']+')/g;
  for (const m of command.matchAll(outputFlagRegex)) {
    const raw = (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (isLikelyProjectMirrorPath(raw)) return raw;
    if (raw.startsWith("/") && !isPathInWorkspace(raw, workspacePath)) return raw;
  }
  const redirectRegex = /(?:^|[;&]\s*|&&\s*|\|\|\s*)>\s*([^\s"']+|"[^"]+"|'[^']+')/g;
  for (const m of command.matchAll(redirectRegex)) {
    const raw = (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (isLikelyProjectMirrorPath(raw)) return raw;
    if (raw.startsWith("/") && !isPathInWorkspace(raw, workspacePath)) return raw;
  }
  const cdRegex = /(?:^|[;&]\s*|&&\s*|\|\|\s*)cd\s+([^\s"']+|"[^"]+"|'[^']+')/g;
  for (const m of command.matchAll(cdRegex)) {
    const raw = (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (isLikelyProjectMirrorPath(raw)) return raw;
    if (raw.startsWith("/") && !isPathInWorkspace(raw, workspacePath)) return raw;
  }
  return null;
}

function buildRuntimeTools(options?: AgentExecutionOptions): StructuredToolInterface[] {
  const tools = getAllTools();
  const workspacePath = options?.workspacePath;
  if (!workspacePath) return tools;
  return tools.map((t) => {
    if (t.name !== "run_command") return t;
    const wrapped = tool(
      async (input: { command: string; timeout_ms?: number; working_directory?: string }) => {
        const cmd = typeof input?.command === "string" ? input.command : "";
        const forbidden = findForbiddenOutputPath(cmd, workspacePath);
        if (forbidden) {
          return `[run_command]\nstatus: blocked\ncommand: ${cmd}\ncwd: ${workspacePath}\nnote: 输出路径 ${forbidden} 不在当前会话 workspace 内。请改为 ${workspacePath} 下路径。`;
        }
        const safeWorkingDirectory = isPathInWorkspace(input.working_directory ?? workspacePath, workspacePath)
          ? (input.working_directory ?? workspacePath)
          : workspacePath;
        return String(await t.invoke({
          ...input,
          working_directory: safeWorkingDirectory,
        }));
      },
      {
        name: "run_command",
        description: t.description,
        schema: (t as unknown as { schema: unknown }).schema as never,
      }
    );
    return wrapped as unknown as StructuredToolInterface;
  });
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
  skillContext?: string,
  options?: AgentExecutionOptions
): Promise<BaseMessage[]> {
  const tools = buildRuntimeTools(options);
  const systemMessage = new SystemMessage(buildSystemPrompt(skillContext));
  const adapter = getModelAdapter(modelId);
  const model = adapter.getLLM().bindTools(tools);
  const toolNode = new ToolNode(tools);
  const planningPrelude = await buildPlanningPrelude(adapter, systemMessage, messages, options?.planningEnabled ?? true);
  const initialState: BaseMessage[] = [
    ...messages,
    ...(planningPrelude.executionConstraint ? [planningPrelude.executionConstraint] : []),
  ];

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

  const result = await graph.invoke({ messages: initialState });
  return result.messages;
}

export async function* streamAgentWithTokens(
  messages: BaseMessage[],
  onToken: (token: string) => void,
  modelId?: string,
  onReasoningToken?: (token: string) => void,
  skillContext?: string,
  options?: StreamAgentOptions
): AsyncGenerator<Record<string, { messages?: BaseMessage[]; reasoning?: string } | { prompt_tokens: number; completion_tokens: number; total_tokens: number }>, void, unknown> {
  const systemMessage = new SystemMessage(buildSystemPrompt(skillContext));
  const adapter = getModelAdapter(modelId);
  const planningPrelude = await buildPlanningPrelude(adapter, systemMessage, messages, options?.planningEnabled ?? true);
  const planSteps = planningPrelude.planSteps ?? [];
  let planCurrentStep = 0;
  const emitPlan = (event: PlanStreamEvent) => {
    if (options?.planProgressEnabled && options.onPlanEvent) {
      options.onPlanEvent(event);
    }
  };
  const stateMessages: BaseMessage[] = [
    ...messages,
    ...(planningPrelude.executionConstraint ? [planningPrelude.executionConstraint] : []),
  ];
  if (planSteps.length > 0) {
    emitPlan({ phase: "created", steps: planSteps, currentStep: 0 });
  }
  const useReasoningStream = adapter.supportsReasoningStream() && typeof onReasoningToken === "function";

  const streamFinalOnlyWithRetryByAdapter = async (
    baseMessages: BaseMessage[],
    reasoningCb: (token: string) => void
  ): Promise<{ content: string; reasoningContent: string; usage?: import("../llm/streamWithReasoning.js").TokenUsage }> => {
    const first = await adapter.streamSingleTurn(baseMessages, onToken, reasoningCb, []);
    const firstContent = first.content?.trim() ?? "";
    if (firstContent) {
      return {
        content: first.content,
        reasoningContent: first.reasoningContent,
        usage: first.usage,
      };
    }
    let latestReasoning = first.reasoningContent ?? "";
    let lastUsage = first.usage;
    for (let retry = 0; retry < 2; retry++) {
      const attempt = await adapter.streamSingleTurn(
        [...baseMessages, new HumanMessage(FINAL_ONLY_PROMPT)],
        onToken,
        reasoningCb,
        []
      );
      const attemptContent = attempt.content?.trim() ?? "";
      if (attempt.usage) lastUsage = attempt.usage;
      if (attemptContent) {
        return {
          content: attempt.content,
          reasoningContent: attempt.reasoningContent,
          usage: attempt.usage,
        };
      }
      if (!latestReasoning.trim() && typeof attempt.reasoningContent === "string" && attempt.reasoningContent.trim()) {
        latestReasoning = attempt.reasoningContent;
      }
    }
    return { content: "", reasoningContent: latestReasoning, usage: lastUsage };
  };

  const streamFinalOnlyWithRetryByModel = async (
    baseMessages: BaseMessage[]
  ): Promise<string> => {
    const modelNoTools = adapter.getLLM();
    const streamOnce = async (msgs: BaseMessage[]) => {
      const stream = await modelNoTools.stream(msgs);
      let content = "";
      for await (const chunk of stream) {
        const text = getTextFromChunk(chunk);
        if (text) {
          onToken(text);
          content += text;
        }
      }
      return content;
    };
    const firstContent = await streamOnce([systemMessage, ...baseMessages]);
    if (firstContent.trim()) return firstContent;
    for (let retry = 0; retry < 2; retry++) {
      const attemptContent = await streamOnce([systemMessage, ...baseMessages, new HumanMessage(FINAL_ONLY_PROMPT)]);
      if (attemptContent.trim()) return attemptContent;
    }
    return "";
  };

  if (useReasoningStream) {
    try {
      const tools = buildRuntimeTools(options);
      const openAITools = tools.map((t) => convertToOpenAITool(t) as unknown as Record<string, unknown>);
      const toolMap = new Map<string, StructuredToolInterface>(tools.map((t) => [t.name, t]));

      let conversationMessages: BaseMessage[] = [systemMessage, ...stateMessages];
      const maxRounds = 50;

      let lastHadContent = false;
      let reachedMaxRounds = false;
      for (let round = 0; round < maxRounds; round++) {
        const { content, reasoningContent, toolCalls, usage: turnUsage } = await adapter.streamSingleTurn(
          conversationMessages, onToken, onReasoningToken!, openAITools
        );
        if (turnUsage) yield { usage: turnUsage };

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
          emitPlan({ phase: "completed", steps: planSteps, currentStep: planSteps.length });
          // 如果最后一轮没有内容，强制生成总结
          if (!lastHadContent) {
            const { content: finalContent, reasoningContent: finalReasoning, usage: finalUsage } = await streamFinalOnlyWithRetryByAdapter(conversationMessages, onReasoningToken!);
            const summaryMsg = new AIMessage({ content: finalContent || NO_VISIBLE_OUTPUT_MESSAGE });
            yield {
              llmCall: {
                messages: [summaryMsg],
                ...(finalReasoning?.trim() ? { reasoning: finalReasoning.trim() } : {}),
              },
            };
            if (finalUsage) yield { usage: finalUsage };
          }
          return;
        }

        const toolMessages: BaseMessage[] = [];
        if (toolCalls.length > 0 && planSteps.length > 0) {
          planCurrentStep = Math.min(planSteps.length, planCurrentStep + 1);
          emitPlan({
            phase: "running",
            steps: planSteps,
            currentStep: planCurrentStep,
            toolName: toolCalls[0]?.name,
          });
        }
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
        if (round === maxRounds - 1) reachedMaxRounds = true;
      }

      if (!lastHadContent) {
        const { content: finalContent, reasoningContent: finalReasoning, usage: finalUsage } = await streamFinalOnlyWithRetryByAdapter(conversationMessages, onReasoningToken!);
        const summaryMsg = new AIMessage({ content: finalContent || (reachedMaxRounds ? MAX_TOOL_CALL_ROUNDS_MESSAGE : NO_VISIBLE_OUTPUT_MESSAGE) });
        yield {
          llmCall: {
            messages: [summaryMsg],
            ...(finalReasoning?.trim() ? { reasoning: finalReasoning.trim() } : {}),
          },
        };
        if (finalUsage) yield { usage: finalUsage };
      }
      return;
    } catch (e) {
      serverLogger.warn("Reasoning stream failed, falling back to standard LangChain stream", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const tools = buildRuntimeTools(options);
  const toolNode = new ToolNode(tools);
  const model = adapter.getLLM().bindTools(tools);
  let state: BaseMessage[] = [...stateMessages];
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
  let reachedMaxRounds = false;
  for (let round = 0; round < maxRounds; round++) {
    const stream = await model.stream([systemMessage, ...state]);
    let fullChunk: BaseMessage | null = null;
    let accumulatedContent = "";
    let accumulatedReasoning = "";
    let lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
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
      const meta = (chunk as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
      if (meta && typeof meta.input_tokens === "number" && typeof meta.output_tokens === "number") {
        lastUsage = {
          prompt_tokens: meta.input_tokens,
          completion_tokens: meta.output_tokens,
          total_tokens: meta.input_tokens + meta.output_tokens,
        };
      }
      if (fullChunk && "concat" in fullChunk && typeof (fullChunk as { concat: (other: BaseMessage) => BaseMessage }).concat === "function") {
        fullChunk = (fullChunk as { concat: (other: BaseMessage) => BaseMessage }).concat(chunk as BaseMessage) as BaseMessage;
      } else {
        fullChunk = chunk as BaseMessage;
      }
    }
    if (lastUsage) yield { usage: lastUsage };
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
    if (!shouldContinue(fullChunk)) {
      emitPlan({ phase: "completed", steps: planSteps, currentStep: planSteps.length });
      break;
    }
    const fullChunkTools = (fullChunk as AIMessage).tool_calls ?? [];
    if (fullChunkTools.length > 0 && planSteps.length > 0) {
      planCurrentStep = Math.min(planSteps.length, planCurrentStep + 1);
      emitPlan({
        phase: "running",
        steps: planSteps,
        currentStep: planCurrentStep,
        toolName: fullChunkTools[0]?.name,
      });
    }
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
    if (round === maxRounds - 1) reachedMaxRounds = true;
  }

  if (!lastHadContent && state.length > messages.length) {
    const summaryContent = await streamFinalOnlyWithRetryByModel(state);
    const summaryMsg = new AIMessage({ content: summaryContent || (reachedMaxRounds ? MAX_TOOL_CALL_ROUNDS_MESSAGE : NO_VISIBLE_OUTPUT_MESSAGE) });
    yield { llmCall: { messages: [summaryMsg] } };
  }
}
