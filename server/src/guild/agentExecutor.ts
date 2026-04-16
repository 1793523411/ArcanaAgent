import { mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GuildAgent, GuildTask, TaskResult, GuildEvent } from "./types.js";
import { getAgent, updateAgent, updateAgentStats, getAgentWorkspaceDir, getGroupSharedDir } from "./guildManager.js";
import { completeTask, failTask, getTask, updateTask, initExecutionLog, appendExecutionLog, finalizeExecutionLog } from "./taskBoard.js";
import { searchRelevant, settleExperience } from "./memoryManager.js";
import { resolveAssetContext } from "./assetResolver.js";
import { guildEventBus } from "./eventBus.js";
import { buildTeammateRoster } from "./teammateRoster.js";
import { snapshotForPrompt, appendHandoff } from "./workspace.js";
import { parseHandoffFromSummary, parseStructuredOutput } from "./handoffParser.js";
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

/** Walk a directory up to maxDepth and emit files as `{relPath, size, ownerDir}`.
 *  Skips the usual noise (hidden files, node_modules) and caps total entries. */
function listArtifacts(rootDir: string, maxDepth = 3, cap = 40): Array<{ path: string; size: number }> {
  if (!existsSync(rootDir)) return [];
  const out: Array<{ path: string; size: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= cap) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (out.length >= cap) return;
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) {
        out.push({ path: relative(rootDir, full), size: st.size });
      }
    }
  };
  walk(rootDir, 0);
  return out;
}

function formatSizeHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Produce a compact inventory of existing artifacts so the agent knows what
 *  already exists before it writes — the todo item was "agent 应该彼此知道对方
 *  工作产出 ... 不能随便做错误的覆盖". Kept concise (per-bucket cap + dir-aware)
 *  to avoid bloating the system prompt. */
function buildArtifactInventory(agent: GuildAgent, groupId: string): string | null {
  const ownWorkspace = listArtifacts(getAgentWorkspaceDir(agent.id));
  const sharedRoot = getGroupSharedDir(groupId);

  // Group shared dir is organized as `{sharedRoot}/{agentId}/...` — split by top-level
  // agent subfolder so the prompt clearly attributes each file to its producer.
  const sharedByOwner = new Map<string, Array<{ path: string; size: number }>>();
  if (existsSync(sharedRoot)) {
    let ownerDirs: string[] = [];
    try { ownerDirs = readdirSync(sharedRoot); } catch { ownerDirs = []; }
    for (const owner of ownerDirs) {
      if (owner.startsWith(".")) continue;
      const ownerPath = join(sharedRoot, owner);
      let st;
      try { st = statSync(ownerPath); } catch { continue; }
      if (!st.isDirectory()) continue;
      const files = listArtifacts(ownerPath, 3, 15);
      if (files.length > 0) sharedByOwner.set(owner, files);
    }
  }

  if (ownWorkspace.length === 0 && sharedByOwner.size === 0) return null;

  const lines: string[] = [];
  lines.push(`## Existing Artifacts (read before writing!)`);
  lines.push(`下面是当前已存在的产物清单。**在创建或覆盖文件前**请先对照此清单：`);
  lines.push(`- 若你要修改他人产物，必须在 Handoff 的 \`inputsConsumed\` 中声明，并在 \`summary\` 里写明变更原因；`);
  lines.push(`- 若你要覆盖自己之前的产物，需在 Handoff 中明确指出"覆盖了 X 文件、因为 Y"；`);
  lines.push(`- 未声明直接覆盖会被视为错误操作。`);

  if (ownWorkspace.length > 0) {
    lines.push(``);
    lines.push(`### 你自己的产物 (workspace)`);
    for (const f of ownWorkspace.slice(0, 25)) {
      lines.push(`- \`${f.path}\` (${formatSizeHuman(f.size)})`);
    }
    if (ownWorkspace.length > 25) lines.push(`- …还有 ${ownWorkspace.length - 25} 个文件未列出`);
  }

  if (sharedByOwner.size > 0) {
    lines.push(``);
    lines.push(`### 小组共享产物（按生产者 agent 分组）`);
    for (const [owner, files] of sharedByOwner) {
      const isSelf = owner === agent.id;
      lines.push(`- **${owner}${isSelf ? " (= you)" : ""}**`);
      for (const f of files.slice(0, 10)) {
        lines.push(`  - \`${f.path}\` (${formatSizeHuman(f.size)})`);
      }
      if (files.length > 10) lines.push(`  - …还有 ${files.length - 10} 个文件`);
    }
  }

  return lines.join("\n");
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
  if (agent.description) {
    sections.push(`**角色定位**：${agent.description}`);
  }
  sections.push(agent.systemPrompt);

  // Profile — skills and track record so the agent knows its own strengths.
  const profileLines: string[] = [];
  if (agent.skills.length > 0) {
    profileLines.push(`- **技能标签**：${agent.skills.join("、")}`);
  }
  const stats = agent.stats;
  if (stats && stats.tasksCompleted > 0) {
    const ratePct = Math.round(stats.successRate * 100);
    profileLines.push(`- **历史表现**：已完成 ${stats.tasksCompleted} 个任务，成功率 ${ratePct}%`);
  }
  if (profileLines.length > 0) {
    sections.push(`\n## Your Profile`);
    sections.push(profileLines.join("\n"));
  }

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

  // Artifact inventory — let the agent see its own + teammates' existing files
  // before it starts writing, so it doesn't silently overwrite prior output.
  const inventory = buildArtifactInventory(agent, groupId);
  if (inventory) {
    sections.push(`\n${inventory}`);
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
  sections.push(``);
  sections.push(`如果任务要求产出结构化数据（例如下游步骤需要一个数组或字段），再追加一个 \`pipeline-output\` 块：`);
  sections.push("```pipeline-output");
  sections.push(`{ "key": "value", "items": [ ... ] }`);
  sections.push("```");
  sections.push(`该块仅在任务描述明确要求时添加；对普通任务可省略。`);

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
  // Guards against double-counting stats when the success path mutates stats
  // and then an exception before the function returns forces the catch block
  // to also mutate stats. Only the first path that runs should update counts.
  let statsCounted = false;

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
        allowedTools: agent.allowedTools,
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

    const structuredOutput = parseStructuredOutput(accumulatedContent) ?? undefined;

    // Build result
    const result: TaskResult = {
      summary: accumulatedContent || "Task completed (no output)",
      handoff,
      structuredOutput,
    };

    // Detect agent rejection: the agent says it can't do this task and asks
    // for reassignment. Reset to open so the scheduler can re-dispatch.
    const isRejection = detectRejection(accumulatedContent, handoff);
    if (isRejection) {
      serverLogger.info("[guild] Agent rejected task, resetting for re-dispatch", { agentId, taskId });
      const rejectedBy = [...(task._rejectedBy ?? []), agentId];
      updateTask(groupId, taskId, {
        status: "open",
        assignedAgentId: undefined,
        result: undefined,
        startedAt: undefined,
        completedAt: undefined,
        bids: [],
        // Blacklist this agent so the scheduler doesn't assign it again
        _rejectedBy: rejectedBy,
      } as Partial<GuildTask>);
      finalizeExecutionLog(groupId, taskId, "failed");
      // Emit the post-update snapshot so subscribers see the fresh _rejectedBy
      // list — previously the pre-update `task` object was emitted.
      guildEventBus.emit({
        type: "task_updated",
        task: {
          ...task,
          status: "open",
          assignedAgentId: undefined,
          result: undefined,
          startedAt: undefined,
          completedAt: undefined,
          bids: [],
          _rejectedBy: rejectedBy,
        },
      });

      updateAgent(agentId, { status: "idle", currentTaskId: undefined });
      guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
      guildEventBus.emit({ type: "agent_updated", agentId });
      return result;
    }

    // Complete task — once this returns, the task is persisted as completed.
    completeTask(groupId, taskId, agentId, result);
    finalizeExecutionLog(groupId, taskId, "completed");

    // Apply success stats *immediately* after completion so any throw in the
    // non-critical post-complete steps below (handoff append, settleExperience)
    // still leaves a correctly-incremented tasksCompleted / successRate.
    // `statsCounted` then guards the catch block from double-mutating.
    const stats = agent.stats;
    stats.tasksCompleted++;
    stats.tasksFailed = stats.tasksFailed ?? 0;
    stats.totalWorkTimeMs += durationMs;
    const total = stats.tasksCompleted + stats.tasksFailed;
    stats.successRate = total > 0 ? stats.tasksCompleted / total : 1;
    stats.lastActiveAt = new Date().toISOString();
    updateAgentStats(agentId, stats);
    statsCounted = true;

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

    // Settle memory — non-critical, wrap so a memory-subsystem fault doesn't
    // mask the fact that the task already completed successfully.
    try {
      const memories = settleExperience(agentId, task, result);
      result.memoryCreated = memories.map((m) => m.id);
    } catch (e) {
      serverLogger.warn("[guild] settleExperience failed", {
        agentId,
        taskId,
        error: String(e),
      });
    }

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

    // Update stats — skip if the success path already counted this task
    // (rare but possible when code after completeTask throws).
    if (!statsCounted) {
      const stats = agent.stats;
      stats.tasksFailed = (stats.tasksFailed ?? 0) + 1;
      stats.totalWorkTimeMs += durationMs;
      stats.lastActiveAt = new Date().toISOString();
      const total = stats.tasksCompleted + stats.tasksFailed;
      stats.successRate = total > 0 ? stats.tasksCompleted / total : 0;
      updateAgentStats(agentId, stats);
    }

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
