import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  getTextFromChunk,
  getTextFromMessage,
  getReasoningFromChunk,
  truncateToolResult,
  safeParseArgs,
  isReadOnlyTool,
  MAX_SINGLE_TOOL_RESULT_CHARS,
  NO_VISIBLE_OUTPUT_MESSAGE,
  FINAL_ONLY_PROMPT,
  MAX_TOOL_CALL_ROUNDS_MESSAGE,
  buildPlanningPrelude,
  createRuntimePlanSteps,
  applyEvidenceToPlan,
  summarizeToolEvidence,
  computeCurrentStep,
  forceCompletePlan,
  HarnessMiddleware,
  DEFAULT_HARNESS_CONFIG,
  buildEnhancementsPrompt,
  pruneConversationIfNeeded,
  buildBackgroundResultMessage,
  resolveConversationTokenCap,
} from "@arcana-agent/core";
import type { RuntimePlanStep, HarnessConfig, HarnessEvent, EvalResult, LoopDetectionResult, ModelAdapter as CoreModelAdapter } from "@arcana-agent/core";
import { createModelAdapter } from "./model.js";
import type { ModelAdapter, StreamReasoningResult } from "./model.js";
import type { ToolCallResult } from "@arcana-agent/core";
import { buildToolSet } from "./tools.js";
import { loadSkillsFromDirs, loadSkillsFromMetas, buildSkillCatalog, createLoadSkillTool } from "./skills.js";
import type { SkillFull } from "./skills.js";
import { McpManager } from "./mcp.js";
import type {
  AgentConfig,
  AgentEvent,
  AgentRunResult,
  StopReason,
  PlanUpdateEvent,
  HarnessDriverAgentEvent,
} from "./types.js";

const DEFAULT_SYSTEM_PROMPT = `You are a versatile, highly capable AI assistant with access to tools. You help users effectively with any task.

## Communication
- **Match the user's language**: respond in Chinese if they write in Chinese, English for English, etc. Never mix languages unnecessarily.
- **Be concise**: avoid filler, preambles like "Sure!" or "Of course!", and unnecessary verbosity. Get straight to the point.
- **Format clearly**: use Markdown — code blocks with language tags, headers for structure, bullet points for lists, tables for comparisons.
- **Show results**: after tool execution, summarize what happened and present outputs clearly. Don't just say "done" — show the key results.

## Tool Usage Strategy
**CRITICAL: Never output your internal reasoning or planning as text.** Do NOT write things like "I need to call tool X" or "Let me think about which tool to use" — just call the tool directly. Your visible output should only contain information meant for the user, never your own thought process about tool selection or task decomposition.

**When to use tools vs. direct response:**
- Answer from knowledge when no system interaction is needed
- Use tools when you need to: execute code, read/write files, run commands, fetch data, or perform any system operation
- When encountering unfamiliar APIs, libraries, or uncertain technical details, proactively use web_search to find accurate, up-to-date information
- For complex tasks, plan the steps first, then execute tools sequentially, checking results between each step
- **IMPORTANT — File search: ALWAYS use built-in tools first, avoid raw shell commands for file discovery:**
  - Search file contents → use \`search_code\` tool (NOT \`run_command\` + \`grep\`/\`find ... -exec grep\`).
  - List/find files by name → use \`list_files\` tool (NOT \`run_command\` + \`find\` or \`ls\`)

**Background tasks for long-running commands:**
- Use \`background_run\` for commands that likely take multiple seconds to complete. Judge by these criteria:
  - **Network I/O**: Downloads, uploads, API calls, git clone, package installation
  - **Heavy computation**: Compilation, builds, compression, video/image processing
  - **Batch operations**: Full test suites, database migrations, batch file processing
  - **Script execution**: Any shell/Python/Node/etc. script where runtime is unpredictable — prefer background by default
  - **Dev servers / long-lived processes**: \`npm run dev\`, \`npm start\`, etc. — these NEVER exit on their own; always use \`background_run\`
- **Judgment principle**: When uncertain, prefer \`background_run\`. Cost of false positive (quick command in background) is low; cost of false negative (slow command blocking) is high.
- After spawning, continue immediately with other work
- Use \`background_check\` for full output, \`background_cancel\` to terminate

**CRITICAL — Always provide a final text response:**
- After ALL tool calls are complete, you MUST generate a clear text response summarizing the results, findings, or output for the user.
- NEVER end your turn with only tool calls and no text — the user needs to see a human-readable summary.

## Error handling
- If a tool fails, read the error carefully, diagnose the issue, and retry with a fix
- Common fixes: install missing dependencies, correct file paths, adjust permissions, fix syntax
- If repeated failures occur, explain the issue to the user and suggest alternatives
- Never silently ignore errors — always report what happened

## Auto-Verification Protocol
After editing or writing code files, the system automatically runs diagnostics (typecheck/lint).
- If errors appear in the tool result, try to fix them in the next step before proceeding to other tasks
- Continue the edit → verify → fix cycle, up to a maximum of 5 attempts
- **Escape conditions** — stop the fix loop and report to the user if ANY of these apply:
  - You have already attempted 5 fix iterations for the same diagnostic errors
  - The errors appear to be pre-existing (not caused by your edits)
  - The errors are environmental rather than code errors
  - The same error persists after 2 consecutive identical fix attempts

## Skills
Skills are specialized capabilities defined in SKILL.md files. When a user's request matches a listed skill:
1. Call load_skill with the exact skill name first
2. Follow the loaded instructions precisely
3. Execute scripts with their full absolute paths via run_command, and ALWAYS set working_directory to the skill directory (shown in <skill_directory> tag after loading)
4. Install dependencies automatically if needed (pip install, npm install, etc.) — also run these with working_directory set to the skill directory
5. Use read_file to check reference docs or saved outputs when mentioned
6. Handle setup steps proactively without asking the user
7. Present skill outputs clearly and completely

## Safety
- **NEVER** execute destructive system commands (rm -rf /, mkfs, dd to disk, shutdown, reboot, etc.)
- **NEVER** read or expose credentials, private keys, API keys, or sensitive environment variables
- **NEVER** modify system-critical files (/etc/passwd, /etc/shadow, boot configs, etc.)
- For potentially risky operations, briefly state what you plan to do before executing
- When uncertain about safety, ask the user for confirmation

## Context Awareness
- Earlier parts of this conversation may have been summarized to save context space. Treat summaries as reliable context.
- If the user references something not in your available context, acknowledge this honestly and ask for clarification rather than guessing.`;

interface PlanContext {
  steps: RuntimePlanStep[];
  currentStep: number;
  harness: HarnessMiddleware | null;
  hasPlan(): boolean;
  buildPlanEvent(): PlanUpdateEvent;
  applyEvidence(toolName: string | undefined, result: string): void;
  forceComplete(): void;
}

function createPlanContext(
  initialSteps: RuntimePlanStep[],
  harness: HarnessMiddleware | null,
): PlanContext {
  const ctx: PlanContext = {
    steps: initialSteps,
    currentStep: computeCurrentStep(initialSteps),
    harness,
    hasPlan() {
      return ctx.steps.length > 0;
    },
    buildPlanEvent(): PlanUpdateEvent {
      const current = computeCurrentStep(ctx.steps);
      return {
        type: "plan_update",
        steps: ctx.steps.map((s, i) => ({
          title: s.title,
          status: s.completed ? "completed" as const : (i === current ? "in_progress" as const : "pending" as const),
        })),
        currentStepIndex: current,
      };
    },
    applyEvidence(toolName: string | undefined, result: string) {
      if (!ctx.hasPlan()) return;
      ctx.steps = applyEvidenceToPlan(ctx.steps, summarizeToolEvidence(toolName, result));
      ctx.currentStep = computeCurrentStep(ctx.steps);
    },
    forceComplete() {
      if (!ctx.hasPlan()) return;
      ctx.steps = forceCompletePlan(ctx.steps);
      ctx.currentStep = computeCurrentStep(ctx.steps);
    },
  };
  return ctx;
}

export class ArcanaAgent {
  private readonly config: AgentConfig;
  private readonly adapter: ModelAdapter;
  private tools: StructuredToolInterface[];
  private systemMessage: SystemMessage;
  private mcpManager: McpManager | null = null;
  private initialized = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this.adapter = createModelAdapter(config.model);

    let systemPromptText = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const skillDirPaths: string[] = [];
    let loadSkillTool: StructuredToolInterface | null = null;

    if (config.skills) {
      let skills: SkillFull[] = [];
      if (config.skills.dirs?.length) {
        skills = loadSkillsFromDirs(config.skills.dirs);
      } else if (config.skills.skills?.length) {
        skills = loadSkillsFromMetas(config.skills.skills);
      }
      if (skills.length > 0) {
        loadSkillTool = createLoadSkillTool(skills);
        systemPromptText += buildSkillCatalog(skills);
        for (const s of skills) skillDirPaths.push(s.dirPath);
      }
    }

    this.tools = buildToolSet(config.tools, config.workspacePath, skillDirPaths);
    if (loadSkillTool) {
      this.tools.push(loadSkillTool);
    }

    const now = new Date();
    const weekdaysEn = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const weekdaysZh = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dateStr = now.toLocaleDateString("en-CA");
    const timeStr = now.toLocaleTimeString("en-US", { hour12: false });
    const wd = now.getDay();
    systemPromptText += `\n\n## Environment\n- Current time: ${dateStr} ${timeStr} (${tz}, ${weekdaysEn[wd]} ${weekdaysZh[wd]})\n- Platform: ${process.platform}`;

    if (config.workspacePath) {
      systemPromptText += `\n\n## Current Workspace\nYour workspace absolute path is: \`${config.workspacePath}\`\nAll file operations (read, write, output) MUST use this directory. Use absolute paths like \`${config.workspacePath}/filename.ext\`. Never write files to any other location.`;
    }

    if (config.harnessConfig) {
      const enhancementsPrompt = buildEnhancementsPrompt({
        evalGuard: config.harnessConfig.evalEnabled,
        evalSkipReadOnly: config.harnessConfig.evalSkipReadOnly,
        loopDetection: config.harnessConfig.loopDetectionEnabled,
        replan: config.harnessConfig.replanEnabled,
        autoApproveReplan: config.harnessConfig.autoApproveReplan,
        replanMaxAttempts: config.harnessConfig.maxReplanAttempts,
        loopWindowSize: config.harnessConfig.loopWindowSize,
        loopSimilarityThreshold: config.harnessConfig.loopSimilarityThreshold,
        agentTimeoutMs: config.agentTimeoutMs ?? 0,
      });
      if (enhancementsPrompt) {
        systemPromptText += enhancementsPrompt;
      }
    }

    this.systemMessage = new SystemMessage(systemPromptText);

    if (config.mcpServers?.length) {
      this.mcpManager = new McpManager();
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (this.mcpManager && this.config.mcpServers?.length) {
      await this.mcpManager.connect(this.config.mcpServers);
      const mcpTools = this.mcpManager.getTools();
      if (mcpTools.length > 0) {
        this.tools = [...this.tools, ...mcpTools];
        const lines = mcpTools.map((t) => `- \`${t.name}\`: ${t.description ?? t.name}`);
        const mcpSection = `\n\n## Available MCP Tools\nThe following tools are provided by external MCP servers. Use them when relevant:\n${lines.join("\n")}`;
        const existingContent = typeof this.systemMessage.content === "string"
          ? this.systemMessage.content
          : Array.isArray(this.systemMessage.content)
            ? this.systemMessage.content.map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? "")).join("")
            : String(this.systemMessage.content);
        this.systemMessage = new SystemMessage(existingContent + mcpSection);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.mcpManager) {
      await this.mcpManager.disconnectAll();
    }
  }

  async run(input: string | BaseMessage[]): Promise<AgentRunResult> {
    const messages = typeof input === "string" ? [new HumanMessage(input)] : input;
    let content = "";
    let stopReason: StopReason = "completed";
    let toolCallCount = 0;
    let usage: AgentRunResult["usage"] | undefined;
    const allMessages = [...messages];
    // Accumulate tool calls/results to reconstruct full message history
    const pendingToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const pendingToolResults: Array<{ id: string; name: string; result: string }> = [];

    for await (const event of this.stream(input)) {
      switch (event.type) {
        case "token":
          content += event.content;
          break;
        case "tool_call":
          toolCallCount++;
          pendingToolCalls.push({ id: event.id, name: event.name, args: event.arguments });
          break;
        case "tool_result":
          pendingToolResults.push({ id: event.id, name: event.name, result: event.result });
          // Once we have results for all pending calls, flush as AI + Tool messages
          if (pendingToolResults.length === pendingToolCalls.length && pendingToolCalls.length > 0) {
            allMessages.push(new AIMessage({
              content: "",
              tool_calls: pendingToolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
            }));
            for (const tr of pendingToolResults) {
              allMessages.push(new ToolMessage({ content: tr.result, tool_call_id: tr.id, name: tr.name }));
            }
            pendingToolCalls.length = 0;
            pendingToolResults.length = 0;
          }
          break;
        case "usage":
          usage = {
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
          };
          break;
        case "stop":
          stopReason = event.reason;
          break;
      }
    }

    // Append final AI response with accumulated text content
    if (content) {
      allMessages.push(new AIMessage({ content }));
    }

    return { content, stopReason, toolCallCount, usage, messages: allMessages };
  }

  async *stream(input: string | BaseMessage[]): AsyncGenerator<AgentEvent, void, unknown> {
    if (this.config.outerRetry && this.config.harnessConfig) {
      yield* this.streamWithOuterRetry(input);
      return;
    }
    yield* this.streamSingleExecution(input);
  }

  private async *streamWithOuterRetry(input: string | BaseMessage[]): AsyncGenerator<AgentEvent, void, unknown> {
    await this.init();
    const maxRetries = this.config.outerRetry?.maxOuterRetries ?? 2;

    if (this.config.outerRetry?.autoApproveReplan !== undefined && this.config.harnessConfig) {
      this.config.harnessConfig = {
        ...this.config.harnessConfig,
        autoApproveReplan: this.config.outerRetry.autoApproveReplan,
      };
    }

    const baseMessages = typeof input === "string" ? [new HumanMessage(input)] : input;
    const iterationSummaries: string[] = [];

    const emitDriver = (phase: HarnessDriverAgentEvent["phase"], iteration: number): AgentEvent => ({
      type: "harness_driver",
      phase,
      iteration,
      maxRetries,
    });

    yield emitDriver("started", 0);

    for (let iteration = 0; iteration <= maxRetries; iteration++) {
      if (this.config.abortSignal?.aborted) {
        yield { type: "stop", reason: "aborted" };
        return;
      }

      yield emitDriver("iteration_start", iteration);

      const iterationMessages: BaseMessage[] = iterationSummaries.length > 0
        ? [
            ...baseMessages,
            new HumanMessage(
              `[Harness Driver] Previous iteration(s) failed. Review to avoid repeating the same mistakes:\n\n${iterationSummaries.join("\n\n")}\n\nDo NOT repeat the same approaches. Try fundamentally different strategies.`
            ),
          ]
        : baseMessages;

      const harnessEvents: HarnessEvent[] = [];
      let lastStopReason: StopReason = "completed";

      for await (const event of this.streamSingleExecution(iterationMessages)) {
        if (event.type === "harness") {
          harnessEvents.push(event.event);
        }
        if (event.type === "stop") {
          lastStopReason = event.reason;
        }
        yield event;
      }

      yield emitDriver("iteration_end", iteration);

      const hasUnresolvedFailure = harnessEvents.some((e) => {
        if (e.kind === "eval" && "verdict" in e.data) {
          return (e.data as EvalResult).verdict === "fail";
        }
        if (e.kind === "loop_detection" && "detected" in e.data) {
          return (e.data as LoopDetectionResult).detected === true;
        }
        return false;
      });

      const lastReplanIdx = harnessEvents
        .map((e, i) => [e, i] as const)
        .filter(([e]) => e.kind === "replan" && "shouldReplan" in e.data && (e.data as { shouldReplan: boolean }).shouldReplan)
        .pop()?.[1] ?? -1;
      const eventsAfterReplan = lastReplanIdx >= 0
        ? harnessEvents.slice(lastReplanIdx + 1)
        : [];
      const replanResolved = lastReplanIdx >= 0
        && eventsAfterReplan.length > 0
        && !eventsAfterReplan.some((e) => {
          if (e.kind === "eval" && "verdict" in e.data) return (e.data as EvalResult).verdict === "fail";
          if (e.kind === "loop_detection" && "detected" in e.data) return (e.data as LoopDetectionResult).detected === true;
          return false;
        });

      if (!hasUnresolvedFailure || replanResolved) {
        yield emitDriver("completed", iteration);
        return;
      }

      if (iteration === maxRetries) {
        yield emitDriver("max_retries_reached", iteration);
        return;
      }

      const summaryParts: string[] = [`### Iteration ${iteration + 1} Summary (FAILED)`];
      const evalFailures = harnessEvents.filter(
        (e) => e.kind === "eval" && "verdict" in e.data && (e.data as EvalResult).verdict === "fail"
      );
      if (evalFailures.length > 0) {
        summaryParts.push(`Eval failures (${evalFailures.length}):`);
        for (const ef of evalFailures.slice(0, 10)) {
          const data = ef.data as EvalResult;
          summaryParts.push(`  - Step ${data.stepIndex + 1}: ${data.reason}`);
        }
      }
      const loops = harnessEvents.filter(
        (e) => e.kind === "loop_detection" && "detected" in e.data && (e.data as LoopDetectionResult).detected
      );
      if (loops.length > 0) {
        summaryParts.push(`Loop detections (${loops.length}):`);
        for (const l of loops.slice(0, 3)) {
          summaryParts.push(`  - ${(l.data as LoopDetectionResult).description ?? "repeated tool pattern"}`);
        }
      }
      iterationSummaries.push(summaryParts.join("\n"));
    }
  }

  private async *streamSingleExecution(input: string | BaseMessage[]): AsyncGenerator<AgentEvent, void, unknown> {
    await this.init();
    const messages = typeof input === "string" ? [new HumanMessage(input)] : input;
    const maxRounds = this.config.maxRounds ?? 200;
    const useReasoningStream = this.adapter.supportsReasoningStream();
    const coreAdapter = this.adapter as unknown as CoreModelAdapter;

    const planningPrelude = await buildPlanningPrelude(
      coreAdapter,
      this.systemMessage,
      messages,
      this.config.planningEnabled ?? false
    );

    const harness = this.config.harnessConfig
      ? new HarnessMiddleware(this.config.harnessConfig, coreAdapter)
      : null;

    const planCtx = createPlanContext(
      createRuntimePlanSteps(planningPrelude.planSteps ?? []),
      harness,
    );

    const stateMessages: BaseMessage[] = [
      ...messages,
      ...(planningPrelude.executionConstraint ? [planningPrelude.executionConstraint] : []),
    ];

    if (planCtx.hasPlan()) {
      yield planCtx.buildPlanEvent();
    }

    if (useReasoningStream) {
      try {
        yield* this.streamReasoningPath(stateMessages, maxRounds, planCtx);
        return;
      } catch {
        // fallback to LangChain stream
      }
    }

    yield* this.streamLangChainPath(stateMessages, maxRounds, planCtx);
  }

  private async *streamReasoningPath(
    messages: BaseMessage[],
    maxRounds: number,
    planCtx: PlanContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const openAITools = this.tools.map((t) => convertToOpenAITool(t) as unknown as Record<string, unknown>);
    const toolMap = new Map<string, StructuredToolInterface>(this.tools.map((t) => [t.name, t]));
    let conversationMessages: BaseMessage[] = [this.systemMessage, ...messages];
    let modelErrorCount = 0;
    let toolCascadeCount = 0;
    let lastHadContent = false;
    const tokenCap = resolveConversationTokenCap(this.config.model.modelId);

    for (let round = 0; round < maxRounds; round++) {
      if (this.config.abortSignal?.aborted) {
        yield { type: "stop", reason: "aborted" };
        return;
      }

      conversationMessages = pruneConversationIfNeeded(conversationMessages, tokenCap);

      const bgMsg = buildBackgroundResultMessage();
      if (bgMsg) conversationMessages = [...conversationMessages, bgMsg];

      const queue: AgentEvent[] = [];
      let resolve: (() => void) | null = null;
      let streamDone = false;
      let streamError: unknown = null;

      const notify = () => { if (resolve) { const r = resolve; resolve = null; r(); } };

      const turnPromise = this.adapter.streamSingleTurn(
        conversationMessages,
        (token) => { queue.push({ type: "token", content: token }); notify(); },
        (token) => { queue.push({ type: "reasoning_token", content: token }); notify(); },
        openAITools,
        this.config.abortSignal
      ).then((r) => { streamDone = true; notify(); return r; })
       .catch((e) => { streamError = e; streamDone = true; notify(); return null; });

      while (!streamDone || queue.length > 0) {
        if (queue.length > 0) {
          const batch = queue.splice(0, queue.length);
          for (const evt of batch) yield evt;
        } else if (!streamDone) {
          await new Promise<void>((r) => { resolve = r; });
        }
      }

      if (streamError) {
        modelErrorCount++;
        if (modelErrorCount >= 3) {
          yield { type: "error", message: `Model error after 3 retries: ${streamError instanceof Error ? streamError.message : String(streamError)}`, recoverable: false };
          yield { type: "stop", reason: "model_error" };
          return;
        }
        if (modelErrorCount >= 2) {
          conversationMessages = pruneConversationIfNeeded(conversationMessages, Math.floor(tokenCap * 0.7));
        }
        await new Promise((r) => setTimeout(r, modelErrorCount * 1000));
        continue;
      }

      const turnResult = await turnPromise;
      if (!turnResult) continue;
      modelErrorCount = 0;

      const { content, reasoningContent, toolCalls, usage } = turnResult;
      lastHadContent = !!(content && content.trim());
      if (usage) {
        yield { type: "usage", promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens };
      }

      const aiMsg = new AIMessage({
        content: content || " ",
        ...(toolCalls.length > 0 ? {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id, name: tc.name, args: safeParseArgs(tc.arguments),
          })),
        } : {}),
      });
      conversationMessages = [...conversationMessages, aiMsg];

      if (toolCalls.length === 0) {
        if (planCtx.hasPlan()) {
          planCtx.forceComplete();
          yield planCtx.buildPlanEvent();
        }
        yield { type: "stop", reason: "completed" };
        return;
      }

      const toolOutputs = await this.executeToolCalls(toolCalls, toolMap);
      for (const out of toolOutputs) {
        yield { type: "tool_call", id: out.id, name: out.name, arguments: safeParseArgs(toolCalls.find(tc => tc.id === out.id)?.arguments ?? "{}") };
        yield { type: "tool_result", id: out.id, name: out.name, result: out.result };
        conversationMessages = [...conversationMessages, new ToolMessage({ content: out.result, tool_call_id: out.id, name: out.name })];
        planCtx.applyEvidence(out.name, out.result);
      }

      const errCount = toolOutputs.filter((o) => o.result.startsWith("Error:") || o.result.startsWith("[error]")).length;
      if (errCount > 0 && errCount >= toolOutputs.length * 0.5) {
        toolCascadeCount++;
        if (toolCascadeCount >= 3) {
          conversationMessages = [...conversationMessages, new HumanMessage(
            "Multiple consecutive tool failures detected. Please stop retrying the same approach, analyze what went wrong, and either try a completely different strategy or explain the issue to the user."
          )];
          yield { type: "error", message: "Tool error cascade: multiple consecutive rounds of tool failures", recoverable: false };
          yield { type: "stop", reason: "tool_error_cascade" };
          return;
        }
      } else {
        toolCascadeCount = 0;
      }

      if (planCtx.hasPlan()) {
        yield planCtx.buildPlanEvent();
      }

      if (planCtx.harness) {
        const mwResult = await planCtx.harness.afterToolResults(
          planCtx.steps,
          toolOutputs.map((o) => ({ name: o.name, result: o.result })),
          conversationMessages.slice(-4).map((m) => getTextFromMessage(m)).join("\n")
        );
        for (const evt of mwResult.events) {
          yield { type: "harness", event: evt } as AgentEvent;
        }
        if (mwResult.abort) {
          yield { type: "stop", reason: "harness_abort" };
          return;
        }
        if (mwResult.updatedPlanSteps) {
          planCtx.steps = mwResult.updatedPlanSteps;
          planCtx.currentStep = computeCurrentStep(planCtx.steps);
          yield planCtx.buildPlanEvent();
        }
        if (mwResult.injectMessages?.length) {
          conversationMessages = [...conversationMessages, ...mwResult.injectMessages];
        }
      }
    }

    if (!lastHadContent) {
      yield* this.streamFinalSummary(conversationMessages);
    }
    yield { type: "stop", reason: "max_rounds" };
  }

  private async *streamLangChainPath(
    messages: BaseMessage[],
    maxRounds: number,
    planCtx: PlanContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const toolMap = new Map<string, StructuredToolInterface>(this.tools.map((t) => [t.name, t]));
    const model = this.adapter.getLLM().bindTools(this.tools);
    let state: BaseMessage[] = [...messages];
    let lastHadContent = false;
    let modelErrorCount = 0;
    let toolCascadeCount = 0;
    const tokenCap = resolveConversationTokenCap(this.config.model.modelId);

    for (let round = 0; round < maxRounds; round++) {
      if (this.config.abortSignal?.aborted) {
        yield { type: "stop", reason: "aborted" };
        return;
      }

      state = pruneConversationIfNeeded([this.systemMessage, ...state], tokenCap).slice(1);

      const bgMsg = buildBackgroundResultMessage();
      if (bgMsg) state = [...state, bgMsg];

      let fullChunk: BaseMessage | null = null;
      let accumulatedContent = "";
      let accumulatedReasoning = "";

      try {
        const stream = await model.stream(
          [this.systemMessage, ...state],
          this.config.abortSignal ? { signal: this.config.abortSignal } : undefined
        );

        for await (const chunk of stream) {
          if (this.config.abortSignal?.aborted) {
            yield { type: "stop", reason: "aborted" };
            return;
          }

          const text = getTextFromChunk(chunk as { content?: unknown });
          if (text) {
            yield { type: "token", content: text };
            accumulatedContent += text;
          }

          const reasoning = getReasoningFromChunk(chunk as { content?: unknown; additional_kwargs?: Record<string, unknown> });
          if (reasoning) {
            yield { type: "reasoning_token", content: reasoning };
            accumulatedReasoning += reasoning;
          }

          const meta = (chunk as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
          if (meta && typeof meta.input_tokens === "number") {
            yield {
              type: "usage",
              promptTokens: meta.input_tokens,
              completionTokens: meta.output_tokens ?? 0,
              totalTokens: (meta.input_tokens) + (meta.output_tokens ?? 0),
            };
          }

          if (fullChunk && "concat" in fullChunk && typeof (fullChunk as { concat: (o: BaseMessage) => BaseMessage }).concat === "function") {
            fullChunk = (fullChunk as { concat: (o: BaseMessage) => BaseMessage }).concat(chunk as BaseMessage);
          } else {
            fullChunk = chunk as BaseMessage;
          }
        }
        modelErrorCount = 0;
      } catch (e) {
        modelErrorCount++;
        if (modelErrorCount >= 3) {
          yield { type: "error", message: `Model error after 3 retries: ${e instanceof Error ? e.message : String(e)}`, recoverable: false };
          yield { type: "stop", reason: "model_error" };
          return;
        }
        if (modelErrorCount >= 2) {
          state = pruneConversationIfNeeded([this.systemMessage, ...state], Math.floor(tokenCap * 0.7)).slice(1);
        }
        await new Promise((r) => setTimeout(r, modelErrorCount * 1000));
        continue;
      }

      if (!fullChunk) break;

      const content = accumulatedContent || getTextFromMessage(fullChunk);
      lastHadContent = !!(content && content.trim());

      const finalMessage = content || (fullChunk as AIMessage).tool_calls?.length
        ? new AIMessage({ content: content || " ", tool_calls: (fullChunk as AIMessage).tool_calls ?? [] })
        : fullChunk;

      state = [...state, finalMessage];

      const toolCalls = (fullChunk as AIMessage).tool_calls ?? [];
      if (!toolCalls.length) {
        if (planCtx.hasPlan()) {
          planCtx.forceComplete();
          yield planCtx.buildPlanEvent();
        }
        yield { type: "stop", reason: "completed" };
        return;
      }

      const toolCallResults: ToolCallResult[] = toolCalls.map((tc) => ({
        id: tc.id ?? "",
        name: tc.name,
        arguments: JSON.stringify(tc.args ?? {}),
      }));

      const toolOutputs = await this.executeToolCalls(toolCallResults, toolMap);
      for (const out of toolOutputs) {
        const origArgs = toolCalls.find(tc => (tc.id ?? "") === out.id)?.args ?? {};
        yield { type: "tool_call", id: out.id, name: out.name, arguments: origArgs as Record<string, unknown> };
        yield { type: "tool_result", id: out.id, name: out.name, result: out.result };
        planCtx.applyEvidence(out.name, out.result);
      }

      const errCount = toolOutputs.filter((o) => o.result.startsWith("Error:") || o.result.startsWith("[error]")).length;
      if (errCount > 0 && errCount >= toolOutputs.length * 0.5) {
        toolCascadeCount++;
        if (toolCascadeCount >= 3) {
          state = [...state, new HumanMessage(
            "Multiple consecutive tool failures detected. Please stop retrying the same approach, analyze what went wrong, and either try a completely different strategy or explain the issue to the user."
          )];
          yield { type: "error", message: "Tool error cascade: multiple consecutive rounds of tool failures", recoverable: false };
          yield { type: "stop", reason: "tool_error_cascade" };
          return;
        }
      } else {
        toolCascadeCount = 0;
      }

      if (planCtx.hasPlan()) {
        yield planCtx.buildPlanEvent();
      }

      const toolMessages: BaseMessage[] = toolOutputs.map((out) =>
        new ToolMessage({ content: out.result, tool_call_id: out.id, name: out.name })
      );
      state = [...state, ...toolMessages];

      if (planCtx.harness) {
        const mwResult = await planCtx.harness.afterToolResults(
          planCtx.steps,
          toolOutputs.map((o) => ({ name: o.name, result: o.result })),
          state.slice(-4).map((m) => getTextFromMessage(m)).join("\n")
        );
        for (const evt of mwResult.events) {
          yield { type: "harness", event: evt } as AgentEvent;
        }
        if (mwResult.abort) {
          yield { type: "stop", reason: "harness_abort" };
          return;
        }
        if (mwResult.updatedPlanSteps) {
          planCtx.steps = mwResult.updatedPlanSteps;
          planCtx.currentStep = computeCurrentStep(planCtx.steps);
          yield planCtx.buildPlanEvent();
        }
        if (mwResult.injectMessages?.length) {
          state = [...state, ...mwResult.injectMessages];
        }
      }
    }

    if (!lastHadContent) {
      yield* this.streamFinalSummary([this.systemMessage, ...state]);
    }
    yield { type: "stop", reason: "max_rounds" };
  }

  private async *streamFinalSummary(
    conversationMessages: BaseMessage[],
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const finalMessages = [...conversationMessages, new HumanMessage(FINAL_ONLY_PROMPT)];
    try {
      if (this.adapter.supportsReasoningStream()) {
        const queue: AgentEvent[] = [];
        let resolve: (() => void) | null = null;
        let streamDone = false;
        const notify = () => { if (resolve) { const r = resolve; resolve = null; r(); } };

        this.adapter.streamSingleTurn(
          finalMessages,
          (token) => { queue.push({ type: "token", content: token }); notify(); },
          () => {},
          [],
          this.config.abortSignal
        ).then(() => { streamDone = true; notify(); })
         .catch(() => { streamDone = true; notify(); });

        while (!streamDone || queue.length > 0) {
          if (queue.length > 0) {
            const batch = queue.splice(0, queue.length);
            for (const evt of batch) yield evt;
          } else if (!streamDone) {
            await new Promise<void>((r) => { resolve = r; });
          }
        }
      } else {
        const model = this.adapter.getLLM();
        const stream = await model.stream(finalMessages);
        for await (const chunk of stream) {
          const text = getTextFromChunk(chunk as { content?: unknown });
          if (text) yield { type: "token", content: text };
        }
      }
    } catch {
      yield { type: "token", content: NO_VISIBLE_OUTPUT_MESSAGE };
    }
  }

  private async executeToolCalls(
    toolCalls: ToolCallResult[],
    toolMap: Map<string, StructuredToolInterface>
  ): Promise<Array<{ id: string; name: string; result: string }>> {
    const reads: ToolCallResult[] = [];
    const writes: ToolCallResult[] = [];

    for (const tc of toolCalls) {
      if (isReadOnlyTool(tc.name)) reads.push(tc);
      else writes.push(tc);
    }

    const resultMap = new Map<string, { id: string; name: string; result: string }>();

    if (reads.length > 0) {
      const parallelResults = await Promise.all(
        reads.map((tc) => this.executeSingleTool(tc, toolMap))
      );
      for (const r of parallelResults) resultMap.set(r.id, r);
    }

    for (const tc of writes) {
      const result = await this.executeSingleTool(tc, toolMap);
      resultMap.set(result.id, result);
    }

    return toolCalls.map((tc) =>
      resultMap.get(tc.id) ?? { id: tc.id, name: tc.name, result: "[error] Unknown execution failure" }
    );
  }

  private async executeSingleTool(
    tc: ToolCallResult,
    toolMap: Map<string, StructuredToolInterface>
  ): Promise<{ id: string; name: string; result: string }> {
    if (this.config.abortSignal?.aborted) {
      return { id: tc.id, name: tc.name, result: "[aborted] Execution cancelled" };
    }
    const toolInst = toolMap.get(tc.name);
    if (!toolInst) {
      return { id: tc.id, name: tc.name, result: `[error] Unknown tool: ${tc.name}` };
    }
    try {
      const args = safeParseArgs(tc.arguments);
      const result = String(await toolInst.invoke(args));
      return { id: tc.id, name: tc.name, result: truncateToolResult(result) };
    } catch (e) {
      return { id: tc.id, name: tc.name, result: `[error] ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

export function createAgent(config: AgentConfig): ArcanaAgent {
  return new ArcanaAgent(config);
}
