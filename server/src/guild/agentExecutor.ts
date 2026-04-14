import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GuildAgent, GuildTask, TaskResult, GuildEvent } from "./types.js";
import { getAgent, updateAgent, updateAgentStats, getAgentWorkspaceDir, getGroupSharedDir } from "./guildManager.js";
import { completeTask, failTask, getTask, updateTask, initExecutionLog, appendExecutionLog, finalizeExecutionLog } from "./taskBoard.js";
import { searchRelevant, settleExperience } from "./memoryManager.js";
import { resolveAssetContext } from "./assetResolver.js";
import { guildEventBus } from "./eventBus.js";
import { buildTeammateRoster } from "./teammateRoster.js";
import { snapshotForPrompt, appendHandoff } from "./workspace.js";
import { parseHandoffFromSummary } from "./handoffParser.js";
import type { TaskHandoff } from "./types.js";
import { streamAgentWithTokens } from "../agent/index.js";
import { serverLogger } from "../lib/logger.js";
import { loadUserConfig, hasAnyEnhancement } from "../config/userConfig.js";
import type { HarnessConfig, HarnessEvent } from "../agent/harness/types.js";
import type { PlanStreamEvent } from "../agent/riskDetection.js";

export interface ExecutionOptions {
  timeoutMs?: number;
  onEvent?: (event: GuildEvent) => void;
}

const activeExecutions = new Set<string>();
const abortRequests = new Set<string>();
const execKey = (groupId: string, taskId: string): string => `${groupId}::${taskId}`;
export const RELEASED_ERROR_TAG = "__GUILD_AGENT_RELEASED__";

export function isExecutionActive(groupId: string, taskId: string): boolean {
  return activeExecutions.has(execKey(groupId, taskId));
}

export function getActiveExecutionCount(): number {
  return activeExecutions.size;
}

/** Mark an active execution for cooperative abort. Returns true if it was active. */
export function requestExecutionAbort(groupId: string, taskId: string): boolean {
  const k = execKey(groupId, taskId);
  if (!activeExecutions.has(k)) return false;
  abortRequests.add(k);
  return true;
}

const REJECTION_PATTERNS = [
  /无法执行/,
  /不属于.*(?:领域|范畴|职责)/,
  /无法完成.*任务/,
  /重新分配/,
  /不在.*能力范围/,
  /超出.*专业/,
];

function detectRejection(content: string, handoff?: TaskHandoff): boolean {
  if (handoff?.openQuestions?.some((q) => REJECTION_PATTERNS.some((p) => p.test(q)))) return true;
  if (handoff?.summary && REJECTION_PATTERNS.some((p) => p.test(handoff.summary))) return true;
  const tail = content.slice(-500);
  return REJECTION_PATTERNS.some((p) => p.test(tail));
}

/** Mirror of api/routes.ts buildHarnessConfigFromEnhancements — we can't import
 *  it directly without a circular graph. Keep logic in sync. */
function buildGuildHarnessConfig(): HarnessConfig | undefined {
  const cfg = loadUserConfig();
  const e = cfg.enhancements;
  if (!e || !hasAnyEnhancement(e)) return undefined;
  return {
    evalEnabled: e.evalGuard,
    evalSkipReadOnly: e.evalSkipReadOnly ?? true,
    loopDetectionEnabled: e.loopDetection,
    replanEnabled: e.replan,
    autoApproveReplan: e.autoApproveReplan,
    maxReplanAttempts: e.maxReplanAttempts,
    loopWindowSize: e.loopWindowSize,
    loopSimilarityThreshold: e.loopSimilarityThreshold,
  };
}

/** Build a system prompt that includes agent identity, assets, memories,
 *  teammate roster, and the shared workspace snapshot (for subtasks). */
function buildGuildAgentPrompt(
  agent: GuildAgent,
  task: GuildTask,
  groupId: string,
  memories: Array<{ title: string; content: string }>,
): string {
  const sections: string[] = [];

  sections.push(`## You are "${agent.name}"`);
  sections.push(agent.systemPrompt);

  if (agent.assets.length > 0) {
    const resolved = resolveAssetContext(agent.assets);
    sections.push(`\n## Your Assets`);
    for (const ctx of resolved) {
      sections.push(ctx.contextSnippet);
    }
  }

  // Teammate roster — who your colleagues are, what they own, collaboration rules.
  const roster = buildTeammateRoster(groupId, agent.id);
  if (roster) {
    sections.push(`\n${roster}`);
  }

  // Workspace snapshot — shared blackboard for the parent requirement, if any.
  const wsParent = task.parentTaskId ?? (task.kind === "requirement" ? task.id : undefined);
  if (wsParent) {
    const snapshot = snapshotForPrompt(groupId, wsParent);
    if (snapshot) {
      sections.push(`\n## Shared Workspace (living blackboard — read before you start)`);
      sections.push(snapshot);
    }
  }

  if (memories.length > 0) {
    sections.push(`\n## Relevant Experience & Knowledge`);
    for (const mem of memories) {
      sections.push(`### ${mem.title}\n${mem.content}`);
    }
  }

  sections.push(`\n## Current Task`);
  sections.push(`Title: ${task.title}`);
  sections.push(`Description: ${task.description}`);
  sections.push(`Priority: ${task.priority}`);
  if (task.acceptanceCriteria) {
    sections.push(`Acceptance: ${task.acceptanceCriteria}`);
  }

  // Workspace paths — tell the agent where to write files
  const wsPath = getAgentWorkspaceDir(agent.id);
  const sharedPath = join(getGroupSharedDir(groupId), agent.id);
  sections.push(`\n## Your Workspace`);
  sections.push(`- 你的私有工作空间: \`${wsPath}\` — 在这里创建和编辑工作文件`);
  sections.push(`- 小组共享目录: \`${sharedPath}\` — 希望小组成员看到的产物放在这里`);
  sections.push(`- 写入共享目录的文件会自动对小组可见`);

  sections.push(`\n## Instructions`);
  sections.push(`完成上面的任务。如果任务包含不属于你领域的工作，**不要硬做** — 在 Handoff 中说明"哪部分需要谁"，Lead 会补发新子任务。`);
  sections.push(``);
  sections.push(`完成后，在回复的最后追加一个结构化 Handoff 块，严格使用以下格式（字面 fence，中间是 JSON）：`);
  sections.push("```handoff");
  sections.push(`{`);
  sections.push(`  "summary": "一句话说明你做了什么",`);
  sections.push(`  "artifacts": [`);
  sections.push(`    { "kind": "commit|file|url|note", "ref": "具体引用", "description": "可选说明" }`);
  sections.push(`  ],`);
  sections.push(`  "memories": [`);
  sections.push(`    { "type": "knowledge|preference", "title": "短标题", "content": "具体内容", "tags": ["标签"] }`);
  sections.push(`  ],`);
  sections.push(`  "inputsConsumed": ["上游 handoff/文件/决策"],`);
  sections.push(`  "openQuestions": ["留给下游的问题"]`);
  sections.push(`}`);
  sections.push("```");
  sections.push(`memories 用于记录你在本次任务中学到的重要信息：`);
  sections.push(`- knowledge: 领域知识、技术要点、API 用法、架构细节等可复用的事实`);
  sections.push(`- preference: 你发现的有效工作方式、工具偏好、代码风格等行为偏好`);
  sections.push(`不需要每次都写 memories，只在确实学到新东西时添加。experience 类型会自动从任务结果生成。`);
  sections.push(``);
  sections.push(`Handoff 块之外的内容仍可以自由书写（解释、思考、代码片段），但 JSON 必须是有效的。`);

  return sections.join("\n");
}

/** Execute a task with a guild agent, streaming output via events */
export async function executeAgentTask(
  agentId: string,
  groupId: string,
  taskId: string,
  options?: ExecutionOptions
): Promise<TaskResult> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const task = getTask(groupId, taskId);
  if (!task) throw new Error(`Task ${taskId} not found in group ${groupId}`);

  // Ensure workspace directories exist before execution
  const wsDir = getAgentWorkspaceDir(agentId);
  const sharedDir = join(getGroupSharedDir(groupId), agentId);
  if (!existsSync(wsDir)) mkdirSync(wsDir, { recursive: true });
  if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });

  const key = execKey(groupId, taskId);
  activeExecutions.add(key);

  // Update agent status
  updateAgent(agentId, { status: "working", currentTaskId: taskId });
  guildEventBus.emit({ type: "agent_status_changed", agentId, status: "working" });
  guildEventBus.emit({ type: "agent_updated", agentId });

  // Initialize execution log
  initExecutionLog(groupId, taskId, agentId);

  const startTime = Date.now();

  try {
    // Search relevant memories
    const relevantMemories = searchRelevant(agentId, `${task.title} ${task.description}`, 5);
    const memoryContext = relevantMemories.map((m) => ({ title: m.title, content: m.content }));

    // Build system prompt (includes teammate roster + workspace snapshot)
    const systemPrompt = buildGuildAgentPrompt(agent, task, groupId, memoryContext);

    // Build initial messages
    const messages = [new HumanMessage(task.description)];

    let accumulatedContent = "";

    const userConfig = loadUserConfig();
    const harnessConfig = buildGuildHarnessConfig();

    // Run agent using existing streamAgentWithTokens
    const stream = streamAgentWithTokens(
      messages,
      (token) => {
        accumulatedContent += token;
        guildEventBus.emit({ type: "agent_output", agentId, taskId, content: token });
        appendExecutionLog(groupId, taskId, { type: "text", content: token, timestamp: new Date().toISOString() });
      },
      agent.modelId,
      (reasoningToken) => {
        guildEventBus.emit({ type: "agent_reasoning", agentId, taskId, content: reasoningToken });
        appendExecutionLog(groupId, taskId, { type: "reasoning", content: reasoningToken, timestamp: new Date().toISOString() });
      },
      undefined, // skillContext
      {
        subagentSystemPromptOverride: systemPrompt,
        conversationMode: "default",
        planningEnabled: userConfig.planning?.enabled ?? true,
        planProgressEnabled: userConfig.planning?.streamProgress ?? true,
        enhancements: userConfig.enhancements,
        ...(harnessConfig ? { harnessConfig } : {}),
        onPlanEvent: (event: PlanStreamEvent) => {
          // Skip the terminal "completed" phase — the plan card was already
          // rendered on "created" and it would otherwise re-render with
          // currentStep past the last step (e.g. "3 步 · 当前 4").
          if (event.phase === "completed") return;
          guildEventBus.emit({ type: "agent_plan", agentId, taskId, phase: event.phase, payload: event });
          appendExecutionLog(groupId, taskId, {
            type: "plan",
            content: event.phase,
            payload: event,
            timestamp: new Date().toISOString(),
          });
        },
        onHarnessEvent: (event: HarnessEvent) => {
          guildEventBus.emit({ type: "agent_harness", agentId, taskId, kind: event.kind, payload: event });
          appendExecutionLog(groupId, taskId, {
            type: "harness",
            content: event.kind,
            payload: event,
            timestamp: new Date().toISOString(),
          });
        },
      }
    );

    // Consume the stream
    for await (const chunk of stream) {
      if (abortRequests.has(key)) {
        throw new Error(RELEASED_ERROR_TAG);
      }
      // Extract tool calls from LLM response (AIMessage with tool_calls)
      if (chunk.llmCall && "messages" in chunk.llmCall) {
        for (const msg of chunk.llmCall.messages ?? []) {
          const toolCalls = (msg as { tool_calls?: Array<{ name: string; args: unknown }> }).tool_calls;
          if (toolCalls && toolCalls.length > 0) {
            for (const tc of toolCalls) {
              guildEventBus.emit({ type: "agent_tool_call", agentId, taskId, tool: tc.name, input: tc.args });
              appendExecutionLog(groupId, taskId, {
                type: "tool_call", content: tc.name, tool: tc.name,
                args: JSON.stringify(tc.args, null, 2), timestamp: new Date().toISOString(),
              });
            }
          }
        }
      }
      // Extract tool results
      if (chunk.toolNode && "messages" in chunk.toolNode) {
        for (const msg of chunk.toolNode.messages ?? []) {
          const content = typeof msg.content === "string" ? msg.content : "";
          const name = (msg as { name?: string }).name ?? "unknown";
          guildEventBus.emit({ type: "agent_tool_result", agentId, taskId, tool: name, output: content.slice(0, 4000) });
          appendExecutionLog(groupId, taskId, {
            type: "tool_result", content, tool: name, timestamp: new Date().toISOString(),
          });
        }
      }
    }

    const durationMs = Date.now() - startTime;

    // Parse structured handoff block out of the final output. We keep the
    // full accumulatedContent as the summary so nothing is lost, but the
    // parsed handoff is what gets written back to the workspace + task.
    const parsedHandoff = parseHandoffFromSummary(accumulatedContent);
    let handoff: TaskHandoff | undefined;
    if (parsedHandoff) {
      handoff = {
        fromAgentId: agentId,
        summary: parsedHandoff.summary,
        artifacts: parsedHandoff.artifacts ?? [],
        inputsConsumed: parsedHandoff.inputsConsumed,
        openQuestions: parsedHandoff.openQuestions,
        memories: parsedHandoff.memories,
        createdAt: new Date().toISOString(),
      };
    }

    // Build result
    const result: TaskResult = {
      summary: accumulatedContent || "Task completed (no output)",
      handoff,
    };

    // Detect agent rejection: the agent says it can't do this task and asks
    // for reassignment. Reset to open so the scheduler can re-dispatch.
    const isRejection = detectRejection(accumulatedContent, handoff);
    if (isRejection) {
      serverLogger.info("[guild] Agent rejected task, resetting for re-dispatch", { agentId, taskId });
      updateTask(groupId, taskId, {
        status: "open",
        assignedAgentId: undefined,
        result: undefined,
        startedAt: undefined,
        completedAt: undefined,
        bids: [],
        // Blacklist this agent so the scheduler doesn't assign it again
        _rejectedBy: [...(task._rejectedBy ?? []), agentId],
      } as Partial<GuildTask>);
      finalizeExecutionLog(groupId, taskId, "failed");
      guildEventBus.emit({ type: "task_updated", task: { ...task, status: "open" } });

      updateAgent(agentId, { status: "idle", currentTaskId: undefined });
      guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
      guildEventBus.emit({ type: "agent_updated", agentId });
      return result;
    }

    // Complete task
    completeTask(groupId, taskId, agentId, result);
    finalizeExecutionLog(groupId, taskId, "completed");

    // Persist handoff to the shared workspace so downstream teammates can see it.
    if (handoff && task.parentTaskId) {
      try {
        appendHandoff(groupId, task.parentTaskId, taskId, handoff);
      } catch (e) {
        serverLogger.warn("[guild] failed to append handoff to workspace", {
          groupId,
          parentTaskId: task.parentTaskId,
          taskId,
          error: String(e),
        });
      }
    }

    // Settle memory
    const memories = settleExperience(agentId, task, result);
    result.memoryCreated = memories.map((m) => m.id);

    // Update agent stats
    const stats = agent.stats;
    stats.tasksCompleted++;
    stats.totalWorkTimeMs += durationMs;
    stats.successRate = stats.tasksCompleted > 0
      ? (stats.successRate * (stats.tasksCompleted - 1) + 1) / stats.tasksCompleted
      : 1;
    stats.lastActiveAt = new Date().toISOString();
    updateAgentStats(agentId, stats);

    // Reset agent status
    updateAgent(agentId, { status: "idle", currentTaskId: undefined });
    guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
    guildEventBus.emit({ type: "agent_updated", agentId });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    const wasReleased = errorMsg === RELEASED_ERROR_TAG || abortRequests.has(key);
    if (wasReleased) {
      serverLogger.warn(`[guild] Agent ${agentId} released mid-execution on task ${taskId}`);
    } else {
      serverLogger.error(`[guild] Agent ${agentId} failed on task ${taskId}`, { error: errorMsg });
    }

    // Fail task — completeTask/failTask are no-ops if the task was already finalized
    // (e.g. user-initiated release marked it cancelled before this returned).
    failTask(groupId, taskId, agentId, wasReleased ? "Released by user" : errorMsg);
    finalizeExecutionLog(groupId, taskId, "failed");

    // Update stats
    const stats = agent.stats;
    stats.totalWorkTimeMs += durationMs;
    stats.lastActiveAt = new Date().toISOString();
    if (stats.tasksCompleted > 0) {
      stats.successRate = (stats.successRate * stats.tasksCompleted) / (stats.tasksCompleted + 1);
    }
    updateAgentStats(agentId, stats);

    // Reset agent status
    updateAgent(agentId, { status: "idle", currentTaskId: undefined });
    guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
    guildEventBus.emit({ type: "agent_updated", agentId });

    return { summary: `Failed: ${errorMsg}` };
  } finally {
    activeExecutions.delete(key);
    abortRequests.delete(key);
  }
}
