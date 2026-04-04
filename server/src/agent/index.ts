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

export type { AgentRole } from "./roles.js";
export type { ConversationMode } from "./systemPrompt.js";
export type { PlanStreamEvent, SubagentStreamEvent } from "./riskDetection.js";
export type { HarnessConfig, HarnessEvent } from "./harness/types.js";
export type { HarnessDriverConfig, HarnessDriverEvent } from "./harness/harnessDriver.js";
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

export async function* streamAgentWithTokens(
  messages: BaseMessage[],
  onToken: (token: string) => void,
  modelId?: string,
  onReasoningToken?: (token: string) => void,
  skillContext?: string,
  options?: StreamAgentOptions
): AsyncGenerator<Record<string, { messages?: BaseMessage[]; reasoning?: string } | { prompt_tokens: number; completion_tokens: number; total_tokens: number }>, void, unknown> {
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

    // Circular dependency detection: build a graph of subagentId references
    // Since dependsOn uses subagentIds (not tc.ids), we detect cycles among
    // the declared dependency values. If a cycle is detected, fall back to sequential.
    if (hasDependencies) {
      const allDepIds = new Set<string>();
      for (const deps of taskDeps.values()) {
        for (const d of deps) allDepIds.add(d);
      }
      // Simple: if any depId is referenced by multiple tasks as mutual dependency, warn
      // Full cycle detection would require knowing subagentId→tc.id mapping which we don't have yet.
      // Sequential execution inherently prevents deadlocks anyway.
    }

    const outputs: Array<{ id: string; name: string; result: string }> = [];
    if (hasDependencies) {
      // Sequential execution: run all tool calls in order so dependsOn results
      // are available in subagentResults by the time dependent tasks run.
      for (const tc of toolCalls) {
        outputs.push(await executeToolCall(tc, toolMap));
      }
    } else {
      // Parallel execution: start all tasks concurrently, run non-tasks inline
      const taskPromiseMap = new Map<string, Promise<{ id: string; name: string; result: string }>>();
      for (const tc of toolCalls) {
        if (tc.name === "task") {
          taskPromiseMap.set(tc.id, executeToolCall(tc, toolMap));
        }
      }
      for (const tc of toolCalls) {
        if (tc.name === "task") {
          const taskResult = await taskPromiseMap.get(tc.id);
          outputs.push(taskResult ?? { id: tc.id, name: tc.name, result: "[error] Unknown task execution failure" });
        } else {
          outputs.push(await executeToolCall(tc, toolMap));
        }
      }
    }
    return outputs;
  };

  if (useReasoningStream) {
    try {
      const tools = buildRuntimeTools(options, { modelId, skillContext, options });
      const openAITools = tools.map((t) => convertToOpenAITool(t) as unknown as Record<string, unknown>);
      const toolMap = new Map<string, StructuredToolInterface>(tools.map((t) => [t.name, t]));
      let conversationMessages: BaseMessage[] = [systemMessage, ...stateMessages];
      const maxRounds = 500;

      let lastHadContent = false;
      let reachedMaxRounds = false;
      for (let round = 0; round < maxRounds; round++) {
        // Check abort signal at the start of each round
        if (options?.abortSignal?.aborted) {
          serverLogger.info("[stream] Aborted by signal, stopping execution");
          return;
        }
        const bgMessage = buildBackgroundResultMessage();
        if (bgMessage) conversationMessages = [...conversationMessages, bgMessage];
        // Prune old tool results to stay within context window
        conversationMessages = pruneConversationIfNeeded(conversationMessages, conversationTokenCap);
        const { content, reasoningContent, toolCalls, usage: turnUsage } = await adapter.streamSingleTurn(
          conversationMessages, onToken, onReasoningToken!, openAITools, options?.abortSignal
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
          if (mwResult.abort) break;
        }
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
  for (let round = 0; round < maxRounds; round++) {
    // Check abort signal at the start of each round
    if (options?.abortSignal?.aborted) {
      serverLogger.info("[stream] Aborted by signal, stopping execution");
      return;
    }
    const bgMessage = buildBackgroundResultMessage();
    if (bgMessage) state = [...state, bgMessage];
    // Prune old tool results to stay within context window
    state = pruneConversationIfNeeded(state, conversationTokenCap);
    // Wrap LangChain stream with abort signal and per-chunk timeout
    const streamSignal = options?.abortSignal;
    const stream = await model.stream([systemMessage, ...state], streamSignal ? { signal: streamSignal } : undefined);
    let fullChunk: BaseMessage | null = null;
    let accumulatedContent = "";
    let accumulatedReasoning = "";
    let lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    for await (const chunk of stream) {
      // Check abort between chunks
      if (streamSignal?.aborted) {
        serverLogger.info("[stream] Aborted by signal during LangChain stream");
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
      if (mwResult.abort) break;
    }
    if (round === maxRounds - 1) reachedMaxRounds = true;
  }

  if (!lastHadContent && state.length > messages.length) {
    const summaryContent = await streamFinalOnlyWithRetryByModel(state);
    const summaryMsg = new AIMessage({ content: summaryContent || (reachedMaxRounds ? MAX_TOOL_CALL_ROUNDS_MESSAGE : NO_VISIBLE_OUTPUT_MESSAGE) });
    yield { llmCall: { messages: [summaryMsg] } };
  }
}

injectStreamAgent(streamAgentWithTokens);
