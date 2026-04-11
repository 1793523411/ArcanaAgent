import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GuildAgent, GuildTask, TaskResult, GuildEvent } from "./types.js";
import { getAgent, updateAgent, updateAgentStats } from "./guildManager.js";
import { completeTask, failTask, initExecutionLog, appendExecutionLog, finalizeExecutionLog } from "./taskBoard.js";
import { searchRelevant, settleExperience } from "./memoryManager.js";
import { resolveAssetContext } from "./assetResolver.js";
import { guildEventBus } from "./eventBus.js";
import { streamAgentWithTokens } from "../agent/index.js";
import { serverLogger } from "../lib/logger.js";

export interface ExecutionOptions {
  timeoutMs?: number;
  onEvent?: (event: GuildEvent) => void;
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

  const { getTask } = await import("./taskBoard.js");
  const task = getTask(groupId, taskId);
  if (!task) throw new Error(`Task ${taskId} not found in group ${groupId}`);

  // Update agent status
  updateAgent(agentId, { status: "working", currentTaskId: taskId });
  guildEventBus.emit({ type: "agent_status_changed", agentId, status: "working" });

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
      }
    );

    // Consume the stream
    for await (const chunk of stream) {
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

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    serverLogger.error(`[guild] Agent ${agentId} failed on task ${taskId}`, { error: errorMsg });

    // Fail task
    failTask(groupId, taskId, agentId, errorMsg);
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

    return { summary: `Failed: ${errorMsg}` };
  }
}
