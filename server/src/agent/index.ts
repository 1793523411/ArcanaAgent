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
import { getSkillCatalogForAgent } from "../skills/manager.js";
import { serverLogger } from "../lib/logger.js";
import { buildPlanningPrelude, type PlanStep } from "./planning.js";
import { resolve } from "path";
import { z } from "zod";

type MessagesState = typeof MessagesAnnotation.State;
export interface PlanStreamEvent {
  phase: "created" | "running" | "completed";
  steps: Array<PlanStep & { evidences: string[]; completed: boolean }>;
  currentStep: number;
  toolName?: string;
}

interface AgentExecutionOptions {
  planningEnabled?: boolean;
  workspacePath?: string;
  subagentEnabled?: boolean;
  subagentDepth?: number;
  onSubagentEvent?: (event: SubagentStreamEvent) => void;
}

interface StreamAgentOptions extends AgentExecutionOptions {
  planProgressEnabled?: boolean;
  onPlanEvent?: (event: PlanStreamEvent) => void;
}

export type SubagentStreamEvent =
  | {
      kind: "lifecycle";
      phase: "started" | "completed" | "failed";
      subagentId: string;
      subagentName?: string;
      depth: number;
      prompt: string;
      summary?: string;
      error?: string;
    }
  | {
      kind: "token";
      subagentId: string;
      content: string;
    }
  | {
      kind: "reasoning";
      subagentId: string;
      content: string;
    }
  | ({
      kind: "plan";
      subagentId: string;
    } & PlanStreamEvent)
  | {
      kind: "tool_call";
      subagentId: string;
      name: string;
      input: string;
    }
  | {
      kind: "tool_result";
      subagentId: string;
      name: string;
      output: string;
    }
  | {
      kind: "subagent_name";
      subagentId: string;
      subagentName: string;
    };

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
- For run_command, if output contains signal \`__RUN_COMMAND_EXECUTED__\`, treat the command as command executed successfully
- For run_command, if output contains signal \`__RUN_COMMAND_DUPLICATE_SKIPPED__\`, do not repeat the same command; move to next step or summarize
- Use \`task\` only for complex tasks that benefit from decomposition; for simple tasks, solve directly in the main agent
- When multiple independent subtasks exist, you may call \`task\` multiple times in the same turn

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
Skills are specialized capabilities defined in SKILL.md files. When a user's request matches a listed skill:
1. Call load_skill with the exact skill name first
2. Follow the loaded instructions precisely
3. Execute scripts with their full absolute paths via run_command
4. Install dependencies automatically if needed (pip install, npm install, etc.)
5. Use read_file to check reference docs or saved outputs when mentioned
6. Handle setup steps proactively without asking the user
7. Present skill outputs clearly and completely

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
  return BASE_SYSTEM_PROMPT + buildMcpToolsSection() + (skillContext || getSkillCatalogForAgent());
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

function getLastAssistantText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg._getType() !== "ai") continue;
    const text = getTextFromMessage(msg).trim();
    if (text) return text;
  }
  return "";
}

function createSubagentId(): string {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 从任务 prompt 生成简短可读的子 Agent 展示名（约 24 字内），用于 AI 名称返回前的占位 */
function deriveSubagentName(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  const maxLen = 24;
  if (oneLine.length <= maxLen) return oneLine || "子任务";
  return oneLine.slice(0, maxLen) + "…";
}

const SUBAGENT_NAME_SYSTEM = "你只输出一个极短的标题，不要任何解释、标点或换行。中文 4～10 字或英文 2～6 个词。";
const SUBAGENT_NAME_MAX_LEN = 12;

/** 用 LLM 根据任务 prompt 生成简短语义化名称（异步，不阻塞子任务启动） */
async function generateShortSubagentName(prompt: string, modelId?: string): Promise<string> {
  const llm = getModelAdapter(modelId).getLLM();
  const oneLine = prompt.replace(/\s+/g, " ").trim().slice(0, 200);
  const msg = await llm.invoke([
    new SystemMessage(SUBAGENT_NAME_SYSTEM),
    new HumanMessage(`任务：${oneLine}\n短标题：`),
  ]);
  const text = typeof msg.content === "string" ? msg.content : "";
  const name = text.replace(/\s+/g, " ").trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, SUBAGENT_NAME_MAX_LEN) || "子任务";
  return name;
}

function stringifyToolArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
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

interface RuntimeToolBuildContext {
  modelId?: string;
  skillContext?: string;
  options?: AgentExecutionOptions;
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

function buildRuntimeTools(options?: AgentExecutionOptions, context?: RuntimeToolBuildContext): StructuredToolInterface[] {
  const tools = getAllTools();
  const workspacePath = options?.workspacePath;
  const wrappedTools = tools.map((t) => {
    if (t.name !== "run_command") return t;
    const wrapped = tool(
      async (input: { command: string; timeout_ms?: number; working_directory?: string }) => {
        if (!workspacePath) {
          return String(await t.invoke(input));
        }
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
  const depth = context?.options?.subagentDepth ?? 0;
  const subagentEnabled = context?.options?.subagentEnabled ?? true;
  if (!subagentEnabled || depth >= 1) {
    return wrappedTools;
  }
  if (!context) {
    return wrappedTools;
  }
  const taskTool = tool(
    async (input: { prompt: string }) => {
      const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
      if (!prompt) return "Error: prompt is required.";
      const subagentId = createSubagentId();
      let subagentName = deriveSubagentName(prompt);
      try {
        // 为了在会话历史中也能看到 AI 生成的简短名称，这里同步等待一次极短 LLM 调用。
        // 子 Agent 本身的执行仍然是异步流式的，这个命名步骤只增加很小的前置延迟。
        subagentName = await generateShortSubagentName(prompt, context.modelId);
      } catch {
        // 保留基于 prompt 的回退名称
      }
      context.options?.onSubagentEvent?.({
        kind: "lifecycle",
        phase: "started",
        subagentId,
        subagentName,
        depth: depth + 1,
        prompt,
      });
      try {
        let summaryText = "";
        for await (const chunk of streamAgentWithTokens(
          [new HumanMessage(prompt)],
          (token) => {
            summaryText += token;
            context.options?.onSubagentEvent?.({
              kind: "token",
              subagentId,
              content: token,
            });
          },
          context.modelId,
          (reasoning) => {
            context.options?.onSubagentEvent?.({
              kind: "reasoning",
              subagentId,
              content: reasoning,
            });
          },
          context.skillContext,
          {
            ...context.options,
            planningEnabled: true,
            planProgressEnabled: true,
            subagentDepth: depth + 1,
            onPlanEvent: (event) => {
              context.options?.onSubagentEvent?.({
                kind: "plan",
                subagentId,
                ...event,
              });
            },
          }
        )) {
          const key = chunk && typeof chunk === "object" ? Object.keys(chunk as object)[0] : "";
          const part = key
            ? (chunk as Record<string, { messages?: BaseMessage[]; reasoning?: string }>)[key]
            : undefined;
          if (key === "llmCall" && part?.messages?.length) {
            const aiMsg = part.messages.find((m) => (m as { _getType?: () => string })._getType?.() === "ai") as
              | { tool_calls?: Array<{ name: string; args?: unknown }> }
              | undefined;
            if (Array.isArray(aiMsg?.tool_calls)) {
              for (const tc of aiMsg.tool_calls) {
                context.options?.onSubagentEvent?.({
                  kind: "tool_call",
                  subagentId,
                  name: tc.name,
                  input: stringifyToolArgs(tc.args),
                });
              }
            }
          }
          if (key === "toolNode" && part?.messages?.length) {
            for (const msg of part.messages) {
              const toolMsg = msg as { _getType?: () => string; name?: string; content?: string };
              if (toolMsg._getType?.() === "tool" && toolMsg.name) {
                context.options?.onSubagentEvent?.({
                  kind: "tool_result",
                  subagentId,
                  name: toolMsg.name,
                  output: typeof toolMsg.content === "string" ? toolMsg.content : "",
                });
              }
            }
          }
          if (!summaryText && part?.messages?.length) {
            const ai = part.messages
              .filter((m) => (m as { _getType?: () => string })._getType?.() === "ai")
              .pop();
            if (ai) {
              summaryText = getTextFromMessage(ai).trim();
            }
          }
        }
        const summary = summaryText.trim() || NO_VISIBLE_OUTPUT_MESSAGE;
        context.options?.onSubagentEvent?.({
          kind: "lifecycle",
          phase: "completed",
          subagentId,
          subagentName,
          depth: depth + 1,
          prompt,
          summary,
        });
        return summary;
      } catch (error) {
        const errText = error instanceof Error ? error.message : String(error);
        context.options?.onSubagentEvent?.({
          kind: "lifecycle",
          phase: "failed",
          subagentId,
          subagentName,
          depth: depth + 1,
          prompt,
          error: errText,
        });
        return `[error] Subagent failed: ${errText}`;
      }
    },
    {
      name: "task",
      description: "Spawn a subagent with isolated context and return only its final summary.",
      schema: z.object({
        prompt: z.string().describe("Subtask instruction for the subagent"),
      }),
    }
  );
  return [...wrappedTools, taskTool as unknown as StructuredToolInterface];
}

type RuntimePlanStep = PlanStep & {
  evidences: string[];
  completed: boolean;
};

function createRuntimePlanSteps(steps: PlanStep[]): RuntimePlanStep[] {
  return steps.map((s) => ({
    ...s,
    evidences: [],
    completed: false,
  }));
}

function summarizeToolEvidence(toolName: string | undefined, output: string): string {
  const oneLine = output.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 180 ? `${oneLine.slice(0, 180)}…` : oneLine;
  return toolName ? `${toolName}: ${short || "(no output)"}` : (short || "(no output)");
}

function applyEvidenceToPlan(steps: RuntimePlanStep[], evidence: string): RuntimePlanStep[] {
  const firstPending = steps.findIndex((s) => !s.completed);
  if (firstPending < 0) return steps;
  const target = steps[firstPending];
  const nextEvidences = [...target.evidences, evidence].slice(-6);
  const requiredChecks = Math.max(1, target.acceptance_checks.length);
  const completed = nextEvidences.length >= requiredChecks;
  // 保留严格门槛：证据条数需覆盖验收项数量，避免“单条证据”导致步骤过早完成。
  const cloned = [...steps];
  cloned[firstPending] = {
    ...target,
    evidences: nextEvidences,
    completed,
  };
  return cloned;
}

function computeCurrentStep(steps: RuntimePlanStep[]): number {
  let done = 0;
  for (const step of steps) {
    if (!step.completed) break;
    done += 1;
  }
  return done;
}

function forceCompletePlan(steps: RuntimePlanStep[]): RuntimePlanStep[] {
  return steps.map((step) => ({
    ...step,
    completed: true,
  }));
}

export function buildAgent(modelId?: string) {
  const tools = buildRuntimeTools(undefined, { modelId, options: {} });
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
  const tools = buildRuntimeTools(options, { modelId, skillContext, options });
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
  let runtimePlanSteps = createRuntimePlanSteps(planningPrelude.planSteps ?? []);
  let planCurrentStep = computeCurrentStep(runtimePlanSteps);
  const emitCurrentPlan = (phase: "created" | "running" | "completed", toolName?: string) => {
    emitPlan({
      phase,
      steps: runtimePlanSteps,
      currentStep: planCurrentStep,
      toolName,
    });
  };
  const emitPlan = (event: PlanStreamEvent) => {
    if (options?.planProgressEnabled && options.onPlanEvent) {
      options.onPlanEvent(event);
    }
  };
  const stateMessages: BaseMessage[] = [
    ...messages,
    ...(planningPrelude.executionConstraint ? [planningPrelude.executionConstraint] : []),
  ];
  if (runtimePlanSteps.length > 0) {
    emitCurrentPlan("created");
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

  const executeToolCall = async (
    tc: ToolCallResult,
    toolMap: Map<string, StructuredToolInterface>
  ): Promise<{ id: string; name: string; result: string }> => {
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
    return { id: tc.id, name: tc.name, result };
  };

  const executeToolCalls = async (
    toolCalls: ToolCallResult[],
    toolMap: Map<string, StructuredToolInterface>
  ): Promise<Array<{ id: string; name: string; result: string }>> => {
    const taskPromiseMap = new Map<string, Promise<{ id: string; name: string; result: string }>>();
    for (const tc of toolCalls) {
      if (tc.name === "task") {
        taskPromiseMap.set(tc.id, executeToolCall(tc, toolMap));
      }
    }
    const outputs: Array<{ id: string; name: string; result: string }> = [];
    for (const tc of toolCalls) {
      if (tc.name === "task") {
        const taskResult = await taskPromiseMap.get(tc.id);
        outputs.push(taskResult ?? { id: tc.id, name: tc.name, result: "[error] Unknown task execution failure" });
        continue;
      }
      outputs.push(await executeToolCall(tc, toolMap));
    }
    return outputs;
  };

  if (useReasoningStream) {
    try {
      const tools = buildRuntimeTools(options, { modelId, skillContext, options });
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
          if (runtimePlanSteps.length > 0) {
            runtimePlanSteps = forceCompletePlan(runtimePlanSteps);
            planCurrentStep = computeCurrentStep(runtimePlanSteps);
          }
          emitCurrentPlan("completed");
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

        const toolOutputs = await executeToolCalls(toolCalls, toolMap);
        const toolMessages: BaseMessage[] = [];
        let lastToolNameForPlan: string | undefined;
        for (const out of toolOutputs) {
          lastToolNameForPlan = out.name;
          toolMessages.push(new ToolMessage({ content: out.result, tool_call_id: out.id, name: out.name }));
          if (runtimePlanSteps.length > 0) {
            runtimePlanSteps = applyEvidenceToPlan(runtimePlanSteps, summarizeToolEvidence(out.name, out.result));
            planCurrentStep = computeCurrentStep(runtimePlanSteps);
          }
        }
        conversationMessages = [...conversationMessages, ...toolMessages];
        if (runtimePlanSteps.length > 0) emitCurrentPlan("running", lastToolNameForPlan);
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

  const tools = buildRuntimeTools(options, { modelId, skillContext, options });
  const toolMap = new Map<string, StructuredToolInterface>(tools.map((t) => [t.name, t]));
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
      if (runtimePlanSteps.length > 0) {
        runtimePlanSteps = forceCompletePlan(runtimePlanSteps);
        planCurrentStep = computeCurrentStep(runtimePlanSteps);
      }
      emitCurrentPlan("completed");
      break;
    }
    const fullChunkTools = ((fullChunk as AIMessage).tool_calls ?? []).map((tc) => ({
      id: tc.id ?? "",
      name: tc.name,
      arguments: JSON.stringify(tc.args ?? {}),
    }));
    const toolOutputs = await executeToolCalls(fullChunkTools, toolMap);
    const toolMessages: BaseMessage[] = toolOutputs.map((out) => (
      new ToolMessage({ content: out.result, tool_call_id: out.id, name: out.name })
    ));
    if (runtimePlanSteps.length > 0) {
      const toolOutputs: Array<{ name?: string; content: string }> = [];
      for (const m of toolMessages) {
        if (m._getType() !== "tool") continue;
        toolOutputs.push({
          name: (m as { name?: string }).name,
          content: typeof m.content === "string" ? m.content : "",
        });
      }
      for (const out of toolOutputs) {
        runtimePlanSteps = applyEvidenceToPlan(runtimePlanSteps, summarizeToolEvidence(out.name, out.content));
      }
      planCurrentStep = computeCurrentStep(runtimePlanSteps);
      emitCurrentPlan("running", fullChunkTools[0]?.name);
    }
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
