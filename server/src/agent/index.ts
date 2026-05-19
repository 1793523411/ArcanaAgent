import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ToolCallResult } from "../llm/adapter.js";
import { getModelAdapter } from "../llm/adapter.js";
import { serverLogger } from "../lib/logger.js";
import { buildPlanningPrelude } from "./planning.js";
import { buildRuntimeTools, injectStreamAgent } from "./toolBuilder.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { isReadOnlyTool } from "../tools/index.js";
import {
  getTextFromChunk,
  getTextFromMessage,
  getReasoningFromMessage,
  getReasoningFromChunk,
  buildBackgroundResultMessage,
  safeParseArgs,
  getWriteFileArgsError,
  WRITE_FILE_SCHEMA_HINT,
  MAX_TOOL_CALL_ROUNDS_MESSAGE,
  NO_VISIBLE_OUTPUT_MESSAGE,
  FINAL_ONLY_PROMPT,
  MAX_SINGLE_TOOL_RESULT_CHARS,
  MIN_CONVERSATION_TOKENS_CAP,
  MAX_CONVERSATION_TOKENS,
  truncateToolResult,
  resolveConversationTokenCap,
  type StopReason,
} from "./messageUtils.js";
import { pruneConversationIfNeeded } from "./pruning.js";
import {
  createRuntimePlanSteps,
  summarizeToolEvidence,
  applyEvidenceToPlan,
  computeCurrentStep,
  forceCompletePlan,
} from "./planTracker.js";
import { HarnessMiddleware } from "./harness/middleware.js";
import type { AgentExecutionOptions, StreamAgentOptions, PlanStreamEvent, SubagentStreamEvent } from "./riskDetection.js";
import { filterToolsByAllowedList } from "./riskDetection.js";

export type { AgentRole } from "./roles.js";
export type { ConversationMode } from "./systemPrompt.js";
export type { PlanStreamEvent, SubagentStreamEvent } from "./riskDetection.js";
export type { HarnessConfig, HarnessEvent } from "./harness/types.js";
export type { HarnessDriverConfig, HarnessDriverEvent } from "./harness/harnessDriver.js";
export type { StopReason } from "./messageUtils.js";
export { streamHarnessAgent } from "./harness/harnessDriver.js";

type MessagesState = typeof MessagesAnnotation.State;

export function buildAgent(modelId?: string) {
  const tools = buildRuntimeTools(undefined, { modelId, options: {} });
  const model = getModelAdapter(modelId).getLLM().bindTools(tools);
  const toolNode = new ToolNode(tools);

  const truncateToolNode = async (state: MessagesState) => {
    const result = await toolNode.invoke(state);
    return {
      messages: (result.messages as BaseMessage[]).map((m) => {
        if (m._getType() === "tool" && typeof m.content === "string") {
          const truncated = truncateToolResult(m.content);
          if (truncated !== m.content) {
            const tm = m as ToolMessage;
            return new ToolMessage({ content: truncated, tool_call_id: tm.tool_call_id, name: (tm as unknown as { name?: string }).name });
          }
        }
        return m;
      }),
    };
  };

  const callModel = async (state: MessagesState) => {
    const prunedMessages = pruneConversationIfNeeded(state.messages);
    const response = await model.invoke([
      new SystemMessage(buildSystemPrompt(undefined, "default")),
      ...prunedMessages,
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
    .addNode("toolNode", truncateToolNode)
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
  const systemMessage = new SystemMessage(buildSystemPrompt(skillContext, options?.conversationMode ?? "default", options?.teamId, options?.workspacePath, options?.enhancements));
  const adapter = getModelAdapter(modelId);
  const model = adapter.getLLM().bindTools(tools);
  const toolNode = new ToolNode(tools);
  const planningPrelude = await buildPlanningPrelude(adapter, systemMessage, messages, options?.planningEnabled ?? true);
  const initialState: BaseMessage[] = [
    ...messages,
    ...(planningPrelude.executionConstraint ? [planningPrelude.executionConstraint] : []),
  ];

  const truncateToolNode = async (state: MessagesState) => {
    const result = await toolNode.invoke(state);
    return {
      messages: (result.messages as BaseMessage[]).map((m) => {
        if (m._getType() === "tool" && typeof m.content === "string") {
          const truncated = truncateToolResult(m.content);
          if (truncated !== m.content) {
            const tm = m as ToolMessage;
            return new ToolMessage({ content: truncated, tool_call_id: tm.tool_call_id, name: (tm as unknown as { name?: string }).name });
          }
        }
        return m;
      }),
    };
  };

  const callModel = async (state: MessagesState) => {
    const bgMessage = buildBackgroundResultMessage();
    const prunedMessages = pruneConversationIfNeeded(state.messages);
    const response = await model.invoke([systemMessage, ...prunedMessages, ...(bgMessage ? [bgMessage] : [])]);
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
    .addNode("toolNode", truncateToolNode)
    .addEdge(START, "llmCall")
    .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
    .addEdge("toolNode", "llmCall")
    .compile();

  const result = await graph.invoke({ messages: initialState });
  return result.messages;
}

/** Shared helper — creates an emitStop function that sets the local variable and notifies the caller. */
function makeEmitStop(
  setter: (reason: StopReason) => void,
  options?: StreamAgentOptions
): (reason: StopReason) => void {
  return (reason: StopReason) => { setter(reason); options?.onStopReason?.(reason); };
}

export async function* streamAgentWithTokens(
  messages: BaseMessage[],
  onToken: (token: string) => void,
  modelId?: string,
  onReasoningToken?: (token: string) => void,
  skillContext?: string,
  options?: StreamAgentOptions
): AsyncGenerator<Record<string, { messages?: BaseMessage[]; reasoning?: string } | { prompt_tokens: number; completion_tokens: number; total_tokens: number } | { reason: StopReason }>, void, unknown> {
  const systemPromptText = options?.subagentSystemPromptOverride ?? buildSystemPrompt(skillContext, options?.conversationMode ?? "default", options?.teamId, options?.workspacePath, options?.enhancements);
  const systemMessage = new SystemMessage(systemPromptText);
  const adapter = getModelAdapter(modelId);
  const planningPrelude = await buildPlanningPrelude(adapter, systemMessage, messages, options?.planningEnabled ?? true);
  let runtimePlanSteps = createRuntimePlanSteps(planningPrelude.planSteps ?? []);
  let planCurrentStep = computeCurrentStep(runtimePlanSteps);
  // Harness middleware: eval, loop detection, replanning (null-check only when not configured)
  const harness = options?.harnessConfig
    ? new HarnessMiddleware(options.harnessConfig, adapter)
    : null;
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
  const depth = options?.subagentDepth ?? 0;
  const baseCap = resolveConversationTokenCap(modelId);
  // Sub-agents get a reduced cap: 75% per depth level (depth 0 = 100%, depth 1 = 75%, depth 2 = 56%)
  const conversationTokenCap = depth > 0
    ? Math.max(MIN_CONVERSATION_TOKENS_CAP, Math.floor(baseCap * Math.pow(0.75, depth)))
    : baseCap;
  if (runtimePlanSteps.length > 0) {
    emitCurrentPlan("created");
  }
  const useReasoningStream = adapter.supportsReasoningStream() && typeof onReasoningToken === "function";

  const streamFinalOnlyWithRetryByAdapter = async (
    baseMessages: BaseMessage[],
    reasoningCb: (token: string) => void
  ): Promise<{ content: string; reasoningContent: string; usage?: import("../llm/streamWithReasoning.js").TokenUsage }> => {
    const pruned = pruneConversationIfNeeded(baseMessages, conversationTokenCap);
    const first = await adapter.streamSingleTurn(pruned, onToken, reasoningCb, [], options?.abortSignal);
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
        [...pruned, new HumanMessage(FINAL_ONLY_PROMPT)],
        onToken,
        reasoningCb,
        [],
        options?.abortSignal
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
    const pruned = pruneConversationIfNeeded(baseMessages, conversationTokenCap);
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
    const firstContent = await streamOnce([systemMessage, ...pruned]);
    if (firstContent.trim()) return firstContent;
    for (let retry = 0; retry < 2; retry++) {
      const attemptContent = await streamOnce([systemMessage, ...pruned, new HumanMessage(FINAL_ONLY_PROMPT)]);
      if (attemptContent.trim()) return attemptContent;
    }
    return "";
  };

  const executeToolCall = async (
    tc: ToolCallResult,
    toolMap: Map<string, StructuredToolInterface>
  ): Promise<{ id: string; name: string; result: string }> => {
    // Check abort before executing
    if (options?.abortSignal?.aborted) {
      return { id: tc.id, name: tc.name, result: "[aborted] Execution cancelled" };
    }
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
      result = `[error] Unknown tool: ${tc.name}. You do NOT have this tool. In team mode, delegate work via the \`task\` tool instead of calling execution tools directly.`;
    }
    // Task tool results are already truncated internally (with metadata prefix).
    // Only apply outer truncation for non-task tools.
    if (tc.name === "task") {
      return { id: tc.id, name: tc.name, result };
    }
    return { id: tc.id, name: tc.name, result: truncateToolResult(result, MAX_SINGLE_TOOL_RESULT_CHARS) };
  };

  const executeToolCalls = async (
    toolCalls: ToolCallResult[],
    toolMap: Map<string, StructuredToolInterface>
  ): Promise<Array<{ id: string; name: string; result: string }>> => {
    // Parse dependsOn from task arguments to determine execution order
    const taskDeps = new Map<string, string[]>(); // tc.id -> dependsOn subagent IDs
    for (const tc of toolCalls) {
      if (tc.name === "task") {
        const args = safeParseArgs(tc.arguments);
        const deps = Array.isArray((args as { dependsOn?: unknown }).dependsOn)
          ? ((args as { dependsOn: unknown[] }).dependsOn).filter((d): d is string => typeof d === "string")
          : [];
        taskDeps.set(tc.id, deps);
      }
    }

    const hasDependencies = Array.from(taskDeps.values()).some((deps) => deps.length > 0);

    // If there are task dependencies, run everything sequentially (original behavior)
    if (hasDependencies) {
      const outputs: Array<{ id: string; name: string; result: string }> = [];
      for (const tc of toolCalls) {
        outputs.push(await executeToolCall(tc, toolMap));
      }
      return outputs;
    }

    // ── Read/Write Lock Semantics ──
    // - Read-only tools: execute in parallel (Promise.all)
    // - Write tools: execute sequentially
    // - Mixed batch: parallel reads first, then sequential writes
    // - task tools: always parallel (as before)
    const reads: ToolCallResult[] = [];
    const writes: ToolCallResult[] = [];
    const tasks: ToolCallResult[] = [];

    for (const tc of toolCalls) {
      if (tc.name === "task") tasks.push(tc);
      else if (isReadOnlyTool(tc.name)) reads.push(tc);
      else writes.push(tc);
    }

    const resultMap = new Map<string, { id: string; name: string; result: string }>();

    // Phase 1: Execute reads + tasks in parallel
    const parallelCalls = [...reads, ...tasks];
    if (parallelCalls.length > 0) {
      const parallelResults = await Promise.all(
        parallelCalls.map((tc) => executeToolCall(tc, toolMap))
      );
      for (const r of parallelResults) resultMap.set(r.id, r);
    }

    // Phase 2: Execute writes sequentially
    for (const tc of writes) {
      const result = await executeToolCall(tc, toolMap);
      resultMap.set(result.id, result);
    }

    // Return in original order
    return toolCalls.map((tc) =>
      resultMap.get(tc.id) ?? { id: tc.id, name: tc.name, result: "[error] Unknown execution failure" }
    );
  };

  // ── 双路径架构 ──
  // 路径 1 (下方 if 块): adapter.streamSingleTurn() — 直接调原生 HTTP API
  //   - 适用于: OpenAI 兼容的 reasoning 模型 (DeepSeek-R1, QwQ 等)
  //   - 优势: 精确提取 reasoning_content、usage 等 LangChain 不透传的字段
  // 路径 2 (if 块之后): model.stream() — 通过 LangChain 标准 stream
  //   - 适用于: Anthropic 模型 (thinking 通过 content blocks 原生支持) + 非 reasoning 的 OpenAI 模型
  //   - 同时作为路径 1 的 fallback (路径 1 整体 try-catch 失败时降级)
  //   - 损失: OpenAI reasoning 模型降级到此路径时会丢失 reasoning_content
  // 两条路径的业务逻辑 (Planning/Harness/Pruning/错误恢复) 完全相同，仅 LLM 调用方式不同。
  //
  // [优化方向] 给 AnthropicAdapter 也实现 streamSingleTurn()，统一走路径 1，
  // 删除路径 2 的 ~200 行重复循环代码。详见 adapter.ts AnthropicAdapter.supportsReasoningStream() 注释。
  if (useReasoningStream) {
    try {
      const tools = filterToolsByAllowedList(
        buildRuntimeTools(options, { modelId, skillContext, options }),
        options?.allowedTools,
      );
      const openAITools = tools.map((t) => convertToOpenAITool(t) as unknown as Record<string, unknown>);
      const toolMap = new Map<string, StructuredToolInterface>(tools.map((t) => [t.name, t]));
      let conversationMessages: BaseMessage[] = [systemMessage, ...stateMessages];
      const maxRounds = 500;

      let lastHadContent = false;
      let reachedMaxRounds = false;
      let stopReason: StopReason = "completed";
      const emitStop = makeEmitStop((r) => { stopReason = r; }, options);

      // ── Continue Site counters (prevent infinite recovery loops) ──
      let modelErrorCount = 0;
      let toolCascadeCount = 0;
      const MAX_MODEL_ERRORS = 3;
      const MAX_TOOL_CASCADES = 3;

      for (let round = 0; round < maxRounds; round++) {
        // Check abort signal at the start of each round
        if (options?.abortSignal?.aborted) {
          serverLogger.info("[stream] Aborted by signal, stopping execution");
          emitStop("aborted");
          yield { stop: { reason: "aborted" as StopReason } };
          return;
        }
        const bgMessage = buildBackgroundResultMessage();
        if (bgMessage) conversationMessages = [...conversationMessages, bgMessage];
        // Prune old tool results to stay within context window
        conversationMessages = pruneConversationIfNeeded(conversationMessages, conversationTokenCap);

        // ── Continue Site 1: model_error — retry with backoff/compression ──
        let turnResult: { content: string; reasoningContent: string; toolCalls: ToolCallResult[]; usage?: import("../llm/streamWithReasoning.js").TokenUsage };
        try {
          turnResult = await adapter.streamSingleTurn(
            conversationMessages, onToken, onReasoningToken!, openAITools, options?.abortSignal
          );
          modelErrorCount = 0; // reset on success
        } catch (modelErr) {
          modelErrorCount++;
          serverLogger.warn(`[continue-site:model_error] Attempt ${modelErrorCount}/${MAX_MODEL_ERRORS}`, {
            error: modelErr instanceof Error ? modelErr.message : String(modelErr),
          });
          if (modelErrorCount >= MAX_MODEL_ERRORS) {
            emitStop("model_error");
            const errorMsg = new AIMessage({
              content: `[Agent stopped: model error after ${MAX_MODEL_ERRORS} retries] ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`,
            });
            yield { llmCall: { messages: [errorMsg] } };
            yield { stop: { reason: "model_error" as StopReason } };
            return;
          }
          // Recovery: compress context and retry
          if (modelErrorCount >= 2) {
            serverLogger.info("[continue-site:model_error] Compressing context before retry");
            conversationMessages = pruneConversationIfNeeded(conversationMessages, Math.floor(conversationTokenCap * 0.7));
          }
          // Brief delay before retry
          await new Promise((r) => setTimeout(r, modelErrorCount * 1000));
          continue; // re-enter loop
        }

        const { content, reasoningContent, toolCalls, usage: turnUsage } = turnResult;
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
          emitStop("completed");
          yield { stop: { reason: "completed" as StopReason } };
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

        // ── Continue Site 3: tool_error_cascade — detect mass tool failures ──
        const errorCount = toolOutputs.filter((o) => o.result.startsWith("[error]")).length;
        if (toolOutputs.length >= 2 && errorCount / toolOutputs.length > 0.5) {
          toolCascadeCount++;
          serverLogger.warn(`[continue-site:tool_error_cascade] ${errorCount}/${toolOutputs.length} tools failed (streak ${toolCascadeCount}/${MAX_TOOL_CASCADES})`);
          if (toolCascadeCount >= MAX_TOOL_CASCADES) {
            emitStop("tool_error_cascade");
            conversationMessages = [...conversationMessages, new HumanMessage(
              `[Agent Error] Tool execution failed ${MAX_TOOL_CASCADES} rounds in a row (${errorCount}/${toolOutputs.length} errors each). Stopping to prevent further damage. Please review the errors above and try a different approach.`
            )];
            break;
          }
          // Inject recovery hint
          conversationMessages = [...conversationMessages, new HumanMessage(
            `[Harness] Warning: ${errorCount}/${toolOutputs.length} tools returned errors this round (cascade ${toolCascadeCount}/${MAX_TOOL_CASCADES}). Try a completely different approach to avoid repeated failures.`
          )];
        } else {
          toolCascadeCount = 0; // reset streak when error ratio is acceptable
        }

        // ── Harness middleware hook (reasoning stream path) ──
        if (harness) {
          const mwResult = await harness.afterToolResults(
            runtimePlanSteps,
            toolOutputs.map((o) => ({ name: o.name, result: o.result })),
            conversationMessages.slice(-4).map((m) => getTextFromMessage(m)).join("\n")
          );
          for (const evt of mwResult.events) options?.onHarnessEvent?.(evt);
          if (mwResult.updatedPlanSteps) {
            runtimePlanSteps = mwResult.updatedPlanSteps;
            planCurrentStep = computeCurrentStep(runtimePlanSteps);
            emitCurrentPlan("running");
          }
          if (mwResult.injectMessages?.length) {
            conversationMessages = [...conversationMessages, ...mwResult.injectMessages];
          }
          if (mwResult.abort) { emitStop("harness_abort"); break; }
        }
        if (round === maxRounds - 1) { reachedMaxRounds = true; emitStop("max_rounds"); }
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
      if (stopReason === "completed" && reachedMaxRounds) emitStop("max_rounds");
      yield { stop: { reason: stopReason } };
      return;
    } catch (e) {
      serverLogger.warn("Reasoning stream failed, falling back to standard LangChain stream", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── 路径 2: LangChain 标准 stream ──
  // 到达此处有两种情况:
  //   1. useReasoningStream=false — Anthropic 模型 或 非 reasoning 的 OpenAI 模型，正常走此路径
  //   2. 路径 1 整体 try-catch 失败 — OpenAI reasoning 模型的 fallback 降级
  // 与路径 1 的差异:
  //   - LLM 调用: model.stream() (LangChain) 而非 adapter.streamSingleTurn() (原生 HTTP)
  //   - 需要手动从 chunk 逐片提取 content/reasoning/usage 并 concat
  //   - 最终总结用 streamFinalOnlyWithRetryByModel (无 reasoning/usage) 而非 ByAdapter
  //   - 正常结束用 break (走循环外收尾) 而非 return (就地退出)
  // 业务逻辑 (Planning/Harness/Pruning/错误恢复/读写锁并行) 与路径 1 完全一致。
  const tools = filterToolsByAllowedList(
    buildRuntimeTools(options, { modelId, skillContext, options }),
    options?.allowedTools,
  );
  const toolMap = new Map<string, StructuredToolInterface>(tools.map((t) => [t.name, t]));
  const model = adapter.getLLM().bindTools(tools);
  let state: BaseMessage[] = [...stateMessages];
  const maxRounds = 500;

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
  let stopReason2: StopReason = "completed";
  const emitStop2 = makeEmitStop((r) => { stopReason2 = r; }, options);

  // ── Continue Site counters for fallback path ──
  let modelErrorCount2 = 0;
  let toolCascadeCount2 = 0;
  const MAX_MODEL_ERRORS_FB = 3;
  const MAX_TOOL_CASCADES_FB = 3;

  for (let round = 0; round < maxRounds; round++) {
    // Check abort signal at the start of each round
    if (options?.abortSignal?.aborted) {
      serverLogger.info("[stream] Aborted by signal, stopping execution");
      emitStop2("aborted");
      yield { stop: { reason: "aborted" as StopReason } };
      return;
    }
    const bgMessage = buildBackgroundResultMessage();
    if (bgMessage) state = [...state, bgMessage];
    // Prune old tool results to stay within context window
    state = pruneConversationIfNeeded(state, conversationTokenCap);

    // ── Continue Site 1 (fallback): model_error — retry with backoff/compression ──
    const streamSignal = options?.abortSignal;
    let fullChunk: BaseMessage | null = null;
    let accumulatedContent = "";
    let accumulatedReasoning = "";
    let lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    try {
      const stream = await model.stream([systemMessage, ...state], streamSignal ? { signal: streamSignal } : undefined);
      for await (const chunk of stream) {
        // Check abort between chunks
        if (streamSignal?.aborted) {
          serverLogger.info("[stream] Aborted by signal during LangChain stream");
          emitStop2("aborted");
          yield { stop: { reason: "aborted" as StopReason } };
          return;
        }
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
      modelErrorCount2 = 0; // reset on success
    } catch (modelErr) {
      modelErrorCount2++;
      serverLogger.warn(`[continue-site:model_error:fallback] Attempt ${modelErrorCount2}/${MAX_MODEL_ERRORS_FB}`, {
        error: modelErr instanceof Error ? (modelErr as Error).message : String(modelErr),
      });
      if (modelErrorCount2 >= MAX_MODEL_ERRORS_FB) {
        emitStop2("model_error");
        const errorMsg = new AIMessage({
          content: `[Agent stopped: model error after ${MAX_MODEL_ERRORS_FB} retries] ${modelErr instanceof Error ? (modelErr as Error).message : String(modelErr)}`,
        });
        yield { llmCall: { messages: [errorMsg] } };
        yield { stop: { reason: "model_error" as StopReason } };
        return;
      }
      // Recovery: compress context and retry
      if (modelErrorCount2 >= 2) {
        serverLogger.info("[continue-site:model_error:fallback] Compressing context before retry");
        state = pruneConversationIfNeeded(state, Math.floor(conversationTokenCap * 0.7));
      }
      await new Promise((r) => setTimeout(r, modelErrorCount2 * 1000));
      continue; // re-enter loop
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
      const planEvidence: Array<{ name?: string; content: string }> = [];
      for (const m of toolMessages) {
        if (m._getType() !== "tool") continue;
        planEvidence.push({
          name: (m as { name?: string }).name,
          content: typeof m.content === "string" ? m.content : "",
        });
      }
      for (const out of planEvidence) {
        runtimePlanSteps = applyEvidenceToPlan(runtimePlanSteps, summarizeToolEvidence(out.name, out.content));
      }
      planCurrentStep = computeCurrentStep(runtimePlanSteps);
      emitCurrentPlan("running", fullChunkTools[0]?.name);
    }
    state = [...state, ...toolMessages];
    yield { toolNode: { messages: toolMessages } };

    // ── Continue Site 3 (fallback): tool_error_cascade — detect mass tool failures ──
    const errorCountFb = toolOutputs.filter((o) => o.result.startsWith("[error]")).length;
    if (toolOutputs.length >= 2 && errorCountFb / toolOutputs.length > 0.5) {
      toolCascadeCount2++;
      serverLogger.warn(`[continue-site:tool_error_cascade:fallback] ${errorCountFb}/${toolOutputs.length} tools failed (streak ${toolCascadeCount2}/${MAX_TOOL_CASCADES_FB})`);
      if (toolCascadeCount2 >= MAX_TOOL_CASCADES_FB) {
        emitStop2("tool_error_cascade");
        state = [...state, new HumanMessage(
          `[Agent Error] Tool execution failed ${MAX_TOOL_CASCADES_FB} rounds in a row (${errorCountFb}/${toolOutputs.length} errors each). Stopping to prevent further damage. Please review the errors above and try a different approach.`
        )];
        break;
      }
      state = [...state, new HumanMessage(
        `[Harness] Warning: ${errorCountFb}/${toolOutputs.length} tools returned errors this round (cascade ${toolCascadeCount2}/${MAX_TOOL_CASCADES_FB}). Try a completely different approach to avoid repeated failures.`
      )];
    } else {
      toolCascadeCount2 = 0; // reset streak when error ratio is acceptable
    }

    // ── Harness middleware hook (LangChain fallback path) ──
    if (harness) {
      const mwResult = await harness.afterToolResults(
        runtimePlanSteps,
        toolOutputs.map((o) => ({ name: o.name, result: o.result })),
        state.slice(-4).map((m) => getTextFromMessage(m)).join("\n")
      );
      for (const evt of mwResult.events) options?.onHarnessEvent?.(evt);
      if (mwResult.updatedPlanSteps) {
        runtimePlanSteps = mwResult.updatedPlanSteps;
        planCurrentStep = computeCurrentStep(runtimePlanSteps);
        emitCurrentPlan("running");
      }
      if (mwResult.injectMessages?.length) {
        state = [...state, ...mwResult.injectMessages];
      }
      if (mwResult.abort) { emitStop2("harness_abort"); break; }
    }
    if (round === maxRounds - 1) { reachedMaxRounds = true; emitStop2("max_rounds"); }
  }

  if (!lastHadContent && state.length > messages.length) {
    const summaryContent = await streamFinalOnlyWithRetryByModel(state);
    const summaryMsg = new AIMessage({ content: summaryContent || (reachedMaxRounds ? MAX_TOOL_CALL_ROUNDS_MESSAGE : NO_VISIBLE_OUTPUT_MESSAGE) });
    yield { llmCall: { messages: [summaryMsg] } };
  }
  yield { stop: { reason: stopReason2 } };
}

injectStreamAgent(streamAgentWithTokens);
