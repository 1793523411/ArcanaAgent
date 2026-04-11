import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GuildAgent, GuildTask, TaskResult, GuildEvent } from "./types.js";
import { getAgent, updateAgent, updateAgentStats } from "./guildManager.js";
import { completeTask, failTask, getTask, initExecutionLog, appendExecutionLog, finalizeExecutionLog } from "./taskBoard.js";
import { searchRelevant, settleExperience } from "./memoryManager.js";
import { resolveAssetContext } from "./assetResolver.js";
import { guildEventBus } from "./eventBus.js";
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

/** Build a system prompt that includes agent identity, assets, and memories */
function buildGuildAgentPrompt(agent: GuildAgent, task: GuildTask, memories: Array<{ title: string; content: string }>): string {
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

  sections.push(`\n## Instructions`);
  sections.push(`Complete the task described above. When done, provide a clear summary of what you accomplished.`);

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

    // Build system prompt
    const systemPrompt = buildGuildAgentPrompt(agent, task, memoryContext);

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

    // Build result
    const result: TaskResult = {
      summary: accumulatedContent || "Task completed (no output)",
    };

    // Complete task
    completeTask(groupId, taskId, agentId, result);
    finalizeExecutionLog(groupId, taskId, "completed");

    // Settle memory
    const memory = settleExperience(agentId, task, result);
    result.memoryCreated = [memory.id];

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
