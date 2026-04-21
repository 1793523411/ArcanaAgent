import type { Request, Response } from "express";
import {
  getGuild, updateGuild,
  createGroup, getGroup, listGroups, updateGroup, archiveGroup, deleteGroup,
  createAgent, getAgent, listAgents, updateAgent, deleteAgent,
  assignAgentToGroup, removeAgentFromGroup, getGroupAgents, getUnassignedAgents,
  addAsset, removeAsset, updateAsset,
  addGroupAsset, removeGroupAsset, updateGroupAsset, getGroupAssetPool, setGroupLead,
  getAggregatedGroupAssets,
  getAgentWorkspaceDir, getAgentMemoryDir, getGroupSharedDir,
} from "./guildManager.js";
import { scanDirectory, safeReadFile } from "./fileBrowser.js";
import { readManifest } from "./manifestManager.js";
import { readWorkspaceRaw, readWorkspace } from "./workspace.js";
import {
  createTask, getTask, getGroupTasks, updateTask, cancelTask, assignTask, getExecutionLog,
  removeTask, findTaskGroup, detectDependencyCycle,
} from "./taskBoard.js";
import { getMemories } from "./memoryManager.js";
import { executeAgentTask, requestExecutionAbort, isExecutionActive } from "./agentExecutor.js";
import { autoBid } from "./bidding.js";
import { warmBiddingEmbeddings, clearTaskEmbeddingCache, isEmbeddingAvailable } from "./embeddingScorer.js";
import { warmLlmScores, clearTaskLlmCache } from "./llmScorer.js";
import { guildEventBus } from "./eventBus.js";
import type { GuildEvent } from "./types.js";
import { serverLogger } from "../lib/logger.js";
import { clearSchedulerLog, getSchedulerLog } from "./schedulerLogStore.js";
import { listPipelines, getPipeline, expandPipeline, savePipeline, deletePipeline, validatePipeline, validateInputs } from "./pipelines.js";

/** Safely extract a single string from Express 5 params (string | string[]) */
function p(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val[0] ?? "";
  return val ?? "";
}

// ─── Guild ──────────────────────────────────────────────────────

export function getGuildInfo(_req: Request, res: Response): void {
  try {
    res.json(getGuild());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function putGuildInfo(req: Request, res: Response): void {
  try {
    const guild = updateGuild(req.body);
    res.json(guild);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Groups ─────────────────────────────────────────────────────

export function getGroups(_req: Request, res: Response): void {
  try {
    res.json(listGroups());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postGroup(req: Request, res: Response): void {
  try {
    const { name, description, sharedContext, artifactStrategy, leadAgentId, assets } = req.body;
    if (!name || !description) {
      res.status(400).json({ error: "name and description are required" });
      return;
    }
    const group = createGroup({ name, description, sharedContext, artifactStrategy, leadAgentId, assets });
    res.status(201).json(group);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getGroupById(req: Request, res: Response): void {
  try {
    const group = getGroup(p(req.params.id));
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    res.json(group);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function putGroupById(req: Request, res: Response): void {
  try {
    const group = updateGroup(p(req.params.id), req.body);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    res.json(group);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deleteGroupById(req: Request, res: Response): void {
  try {
    const ok = deleteGroup(p(req.params.id));
    if (!ok) { res.status(404).json({ error: "Group not found" }); return; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Group ↔ Agent binding ──────────────────────────────────────

export function postGroupAgent(req: Request, res: Response): void {
  try {
    const { agentId } = req.body;
    if (!agentId) { res.status(400).json({ error: "agentId is required" }); return; }
    const ok = assignAgentToGroup(agentId, p(req.params.id));
    if (!ok) { res.status(400).json({ error: "Failed to assign agent" }); return; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deleteGroupAgent(req: Request, res: Response): void {
  try {
    const ok = removeAgentFromGroup(p(req.params.agentId), p(req.params.id));
    if (!ok) { res.status(400).json({ error: "Failed to remove agent" }); return; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Agents ─────────────────────────────────────────────────────

export function getAgents(_req: Request, res: Response): void {
  try {
    res.json(listAgents());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postAgent(req: Request, res: Response): void {
  try {
    const { name, description, systemPrompt } = req.body;
    if (!name || !description || !systemPrompt) {
      res.status(400).json({ error: "name, description, and systemPrompt are required" });
      return;
    }
    const agent = createAgent(req.body);
    res.status(201).json(agent);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getAgentById(req: Request, res: Response): void {
  try {
    const agent = getAgent(p(req.params.id));
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    res.json(agent);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function putAgentById(req: Request, res: Response): void {
  try {
    const agent = updateAgent(p(req.params.id), req.body);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    res.json(agent);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deleteAgentById(req: Request, res: Response): void {
  try {
    const ok = deleteAgent(p(req.params.id));
    if (!ok) { res.status(404).json({ error: "Agent not found" }); return; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getAgentMemories(req: Request, res: Response): void {
  try {
    const memories = getMemories(p(req.params.id));
    res.json(memories);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getAgentStats(req: Request, res: Response): void {
  try {
    const agent = getAgent(p(req.params.id));
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    res.json(agent.stats);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postAgentAsset(req: Request, res: Response): void {
  try {
    const asset = addAsset(p(req.params.id), req.body);
    if (!asset) { res.status(404).json({ error: "Agent not found" }); return; }
    res.status(201).json(asset);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deleteAgentAsset(req: Request, res: Response): void {
  try {
    const ok = removeAsset(p(req.params.id), p(req.params.assetId));
    if (!ok) { res.status(404).json({ error: "Asset not found" }); return; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function updateAgentAsset(req: Request, res: Response): void {
  try {
    const result = updateAsset(p(req.params.id), p(req.params.assetId), req.body);
    if (!result) { res.status(404).json({ error: "Asset not found" }); return; }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function updateGroupAssetRoute(req: Request, res: Response): void {
  try {
    const result = updateGroupAsset(p(req.params.id), p(req.params.assetId), req.body);
    if (!result) { res.status(404).json({ error: "Asset not found" }); return; }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Tasks ──────────────────────────────────────────────────────

export function getGroupTaskList(req: Request, res: Response): void {
  try {
    const status = req.query.status ? String(req.query.status).split(",") as import("./types.js").TaskStatus[] : undefined;
    res.json(getGroupTasks(p(req.params.groupId), status));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postGroupTask(req: Request, res: Response): void {
  try {
    const groupId = p(req.params.groupId);
    const { title, description } = req.body;
    if (!title || !description) {
      res.status(400).json({ error: "title and description are required" });
      return;
    }
    if (req.body.kind === "pipeline") {
      res.status(400).json({
        error: "Use POST /api/guild/groups/:groupId/tasks/from-pipeline to create pipeline tasks",
      });
      return;
    }
    if (Array.isArray(req.body.dependsOn) && req.body.dependsOn.length > 0) {
      const cycle = detectDependencyCycle(groupId, null, req.body.dependsOn);
      if (cycle) {
        res.status(400).json({ error: `dependsOn 会产生循环依赖: ${cycle.join(" → ")}` });
        return;
      }
    }
    const task = createTask(groupId, req.body);
    // Dispatch is handled solely by GuildAutonomousScheduler (task_created → scheduleGroup)
    // to avoid double autoBid / race with in_progress tasks.

    res.status(201).json(task);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Pipelines ──────────────────────────────────────────────────

export function getPipelineList(_req: Request, res: Response): void {
  try {
    res.json(listPipelines());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getPipelineById(req: Request, res: Response): void {
  try {
    const tpl = getPipeline(p(req.params.id));
    if (!tpl) { res.status(404).json({ error: "Pipeline not found" }); return; }
    res.json(tpl);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postPipeline(req: Request, res: Response): void {
  try {
    const body = req.body;
    const errs = validatePipeline(body);
    if (errs.length > 0) { res.status(400).json({ errors: errs }); return; }
    const out = savePipeline(body);
    if (!out.ok) { res.status(400).json({ error: out.reason, errors: out.errors }); return; }
    res.status(201).json(out.template);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function putPipeline(req: Request, res: Response): void {
  try {
    const id = p(req.params.id);
    const out = savePipeline(req.body, { expectedId: id, allowOverwrite: true });
    if (!out.ok) { res.status(400).json({ error: out.reason, errors: out.errors }); return; }
    res.json(out.template);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deletePipelineById(req: Request, res: Response): void {
  try {
    const ok = deletePipeline(p(req.params.id));
    if (!ok) { res.status(404).json({ error: "Pipeline not found" }); return; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postGroupTaskFromPipeline(req: Request, res: Response): void {
  try {
    const groupId = p(req.params.groupId);
    const { pipelineId, inputs = {}, title, description, priority, createdBy } = req.body ?? {};
    if (!pipelineId) { res.status(400).json({ error: "pipelineId is required" }); return; }
    const tpl = getPipeline(String(pipelineId));
    if (!tpl) { res.status(404).json({ error: "Pipeline not found" }); return; }

    if (!Array.isArray(tpl.steps) || tpl.steps.length === 0) {
      res.status(400).json({ error: "Pipeline template has no steps" });
      return;
    }
    const missing = validateInputs(tpl, inputs);
    if (missing.length > 0) {
      res.status(400).json({ error: `Missing required inputs: ${missing.join(", ")}` });
      return;
    }

    const parent = createTask(groupId, {
      title: title || tpl.name,
      description: description || tpl.description || `Pipeline: ${tpl.name}`,
      kind: "pipeline",
      priority,
      createdBy,
      pipelineId: tpl.id,
      pipelineInputs: inputs,
    });

    const outcome = expandPipeline(groupId, parent, tpl, inputs);
    if (!outcome.ok) {
      res.status(400).json({ error: outcome.reason ?? "Failed to expand pipeline", task: parent });
      return;
    }
    const refreshed = getTask(groupId, parent.id);
    res.status(201).json({ task: refreshed ?? parent, subtaskIds: outcome.subtaskIds });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function putTask(req: Request, res: Response): void {
  try {
    // Find the task across groups
    const taskId = p(req.params.id);
    // We need to find which group this task belongs to — check body or search
    const groupId = req.body.groupId;
    if (!groupId) {
      res.status(400).json({ error: "groupId is required in body" });
      return;
    }
    if (Array.isArray(req.body.dependsOn)) {
      const cycle = detectDependencyCycle(groupId, taskId, req.body.dependsOn);
      if (cycle) {
        res.status(400).json({ error: `dependsOn 会产生循环依赖: ${cycle.join(" → ")}` });
        return;
      }
    }
    const task = updateTask(groupId, taskId, req.body);
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deleteTask(req: Request, res: Response): void {
  try {
    const taskId = p(req.params.id);
    // groupId query param is a hint from the UI; verify it actually contains
    // the task and fall back to a full scan. The merged task list can show
    // tasks from other groups (via the SSE stream), so the hint may be wrong.
    const hint = (req.query.groupId as string) || "";
    let groupId: string | null = hint && getTask(hint, taskId) ? hint : null;
    if (!groupId) groupId = findTaskGroup(taskId);
    if (!groupId) { res.status(404).json({ error: "Task not found" }); return; }
    // If the task is currently executing, abort the run before removing it
    // so we don't leak an execution or stomp on an in-flight agent.
    const existing = getTask(groupId, taskId);
    if (existing && existing.status === "in_progress") {
      if (isExecutionActive(groupId, taskId)) {
        requestExecutionAbort(groupId, taskId);
      }
    }
    const ok = removeTask(groupId, taskId);
    if (!ok) { res.status(404).json({ error: "Task not found" }); return; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Clear the agent rejection blacklist on a task so autobid can retry every
 *  agent, not just the ones that haven't rejected before. */
export function postClearTaskRejections(req: Request, res: Response): void {
  try {
    const taskId = p(req.params.id);
    const hint = (req.query.groupId as string) || "";
    let groupId: string | null = hint && getTask(hint, taskId) ? hint : null;
    if (!groupId) groupId = findTaskGroup(taskId);
    if (!groupId) { res.status(404).json({ error: "Task not found" }); return; }
    const task = updateTask(groupId, taskId, { _rejectedBy: [] });
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }
    guildEventBus.emit({ type: "task_updated", task });
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Task Assignment & Execution ────────────────────────────────

export function postAssignTask(req: Request, res: Response): void {
  try {
    const { taskId, agentId } = req.body;
    const groupId = p(req.params.groupId);
    if (!taskId || !agentId) {
      res.status(400).json({ error: "taskId and agentId are required" });
      return;
    }
    const task = assignTask(groupId, taskId, agentId);
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }

    // Start execution asynchronously
    executeAgentTask(agentId, groupId, taskId).catch((err) => {
      serverLogger.error(`[guild] Background execution failed`, { error: String(err) });
    });

    res.json(task);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Auto Bidding ──────────────────────────────────────────────

export async function postAutoBid(req: Request, res: Response): Promise<void> {
  try {
    const groupId = p(req.params.groupId);
    const { taskId } = req.body;
    if (!taskId) {
      res.status(400).json({ error: "taskId is required" });
      return;
    }
    const task = getTask(groupId, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    // Best-effort embedding warmup for semantic scoring (skip if model not loaded
    // to avoid blocking the HTTP request during initial model download).
    const agents = getGroupAgents(groupId);
    if (isEmbeddingAvailable()) {
      await warmBiddingEmbeddings(agents, task).catch(() => {});
    }
    // Best-effort LLM score warmup for small groups (<10 agents).
    // Runs in parallel with embeddings; falls back gracefully on timeout/error.
    await warmLlmScores(agents, task).catch(() => {});
    const winner = autoBid(groupId, task);
    clearTaskEmbeddingCache(taskId);
    clearTaskLlmCache(taskId);
    if (!winner) {
      const freshTask = getTask(groupId, taskId);
      const status = freshTask?.status ?? task.status;
      if (status === "in_progress" || status === "completed" || status === "failed" || status === "cancelled") {
        res.json({ assigned: false, message: `任务已处于「${status}」状态，无需竞标` });
        return;
      }
      const idleAgents = getGroupAgents(groupId).filter((a) => a.status === "idle" && !a.currentTaskId);
      res.json({
        assigned: false,
        message: idleAgents.length === 0
          ? "当前小组没有空闲 Agent，无法竞标"
          : "所有 Agent 均未达到竞标门槛",
      });
      return;
    }

    // Start execution asynchronously
    executeAgentTask(winner.agentId, groupId, taskId).catch((err) => {
      serverLogger.error(`[guild] Background execution failed`, { error: String(err) });
    });

    res.json({ assigned: true, bid: winner });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Execution Logs ───────────────────────────────────────

export function getTaskExecutionLog(req: Request, res: Response): void {
  try {
    const groupId = p(req.params.groupId);
    const taskId = p(req.params.taskId);
    const log = getExecutionLog(groupId, taskId);
    if (!log) { res.json({ taskId, agentId: "", events: [], status: "completed", startedAt: "" }); return; }
    res.json(log);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/**
 * Manual safety valve: force-release an agent from its current task.
 * Cancels the in-flight task (if any), signals the executor to abort, and
 * resets the agent to idle so the autonomous scheduler can hand it new work.
 */
export function postReleaseAgent(req: Request, res: Response): void {
  try {
    const agentId = p(req.params.agentId);
    const agent = getAgent(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const taskId = agent.currentTaskId;
    let releasedTaskId: string | null = null;
    let cancelledGroupId: string | null = null;

    if (taskId) {
      // Locate the task across every group the agent belongs to so we can cancel it.
      const candidateGroups = listGroups()
        .filter((g) => g.agents.includes(agentId))
        .map((g) => g.id);
      if (agent.groupId && !candidateGroups.includes(agent.groupId)) {
        candidateGroups.push(agent.groupId);
      }
      for (const groupId of candidateGroups) {
        const t = getTask(groupId, taskId);
        if (!t || t.assignedAgentId !== agentId) continue;
        if (t.status === "in_progress" || t.status === "open") {
          cancelTask(groupId, taskId);
          releasedTaskId = taskId;
          cancelledGroupId = groupId;
        }
        if (isExecutionActive(groupId, taskId)) {
          requestExecutionAbort(groupId, taskId);
        }
        break;
      }
    }

    updateAgent(agentId, { status: "idle", currentTaskId: undefined });
    guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
    guildEventBus.emit({ type: "agent_updated", agentId });

    serverLogger.warn("[guild] Agent released by user", {
      agentId,
      releasedTaskId,
      cancelledGroupId,
    });

    res.json({ success: true, releasedTaskId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Group Assets & Lead ───────────────────────────────────────

export function getGroupAssetList(req: Request, res: Response): void {
  try {
    const groupId = p(req.params.id);
    if (!getGroup(groupId)) { res.status(404).json({ error: "Group not found" }); return; }
    res.json({
      groupAssets: getGroupAssetPool(groupId),
      aggregated: getAggregatedGroupAssets(groupId),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postGroupAsset(req: Request, res: Response): void {
  try {
    const groupId = p(req.params.id);
    const asset = addGroupAsset(groupId, req.body);
    if (!asset) { res.status(404).json({ error: "Group not found" }); return; }
    res.status(201).json(asset);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deleteGroupAssetById(req: Request, res: Response): void {
  try {
    const ok = removeGroupAsset(p(req.params.id), p(req.params.assetId));
    if (!ok) { res.status(404).json({ error: "Asset not found" }); return; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function putGroupLead(req: Request, res: Response): void {
  try {
    const groupId = p(req.params.id);
    const { agentId } = req.body ?? {};
    const group = setGroupLead(groupId, agentId ?? undefined);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    res.json(group);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Workspace reader ──────────────────────────────────────────

export function getTaskWorkspace(req: Request, res: Response): void {
  try {
    const groupId = p(req.params.groupId);
    const taskId = p(req.params.taskId);
    const format = String(req.query.format ?? "raw");
    if (format === "parsed") {
      const ws = readWorkspace(groupId, taskId);
      if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
      res.json(ws);
      return;
    }
    const raw = readWorkspaceRaw(groupId, taskId);
    if (raw === null) { res.status(404).json({ error: "Workspace not found" }); return; }
    res.type("text/markdown").send(raw);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deleteGroupSchedulerLog(req: Request, res: Response): void {
  try {
    const groupId = p(req.params.groupId);
    if (!getGroup(groupId)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    clearSchedulerLog(groupId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Artifact File Reader ─────────────────────────────────────────

import { existsSync, statSync, readFileSync, realpathSync } from "fs";
import { resolve, extname } from "path";

const SAFE_TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".yaml", ".yml",
  ".css", ".scss", ".html", ".xml", ".toml", ".ini", ".cfg", ".sh",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".c", ".cpp", ".h",
  ".hpp", ".cs", ".swift", ".vue", ".svelte", ".sql", ".graphql",
  ".gitignore", ".dockerfile", ".log", ".csv",
]);

export function getGuildArtifactFile(req: Request, res: Response): void {
  try {
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }

    // Resolve to absolute and ensure it's within the project root (cwd).
    // Use realpathSync after existence check to follow symlinks and prevent
    // symlink-based path traversal attacks.
    const projectRoot = resolve(process.cwd());
    const absolute = resolve(projectRoot, filePath);
    if (!absolute.startsWith(projectRoot + "/") && absolute !== projectRoot) {
      res.status(403).json({ error: "Path outside project root" });
      return;
    }

    if (!existsSync(absolute)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // Follow symlinks and re-check containment
    const realRoot = realpathSync(projectRoot);
    const realAbsolute = realpathSync(absolute);
    if (!realAbsolute.startsWith(realRoot + "/") && realAbsolute !== realRoot) {
      res.status(403).json({ error: "Path outside project root" });
      return;
    }

    const stat = statSync(absolute);
    if (!stat.isFile()) {
      res.status(400).json({ error: "Not a file" });
      return;
    }

    // Size limit: 1MB
    if (stat.size > 1024 * 1024) {
      res.status(413).json({ error: "File too large (>1MB)" });
      return;
    }

    const ext = extname(absolute).toLowerCase();
    if (!SAFE_TEXT_EXTS.has(ext)) {
      // Return metadata only for non-text files
      res.json({ binary: true, size: stat.size, ext });
      return;
    }

    const content = readFileSync(absolute, "utf-8");
    res.json({ content, size: stat.size, ext });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── File Browser (workspace / memory / shared) ─────────────────

// Browse agent workspace tree
export function getAgentWorkspaceTree(req: Request, res: Response): void {
  const dir = getAgentWorkspaceDir(p(req.params.id));
  res.json(scanDirectory(dir));
}

// Read file from agent workspace
export function getAgentWorkspaceFile(req: Request, res: Response): void {
  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: "path required" }); return; }
  const result = safeReadFile(getAgentWorkspaceDir(p(req.params.id)), filePath);
  if (!result) { res.status(404).json({ error: "File not found" }); return; }
  res.json(result);
}

// Browse agent memory tree
export function getAgentMemoryTree(req: Request, res: Response): void {
  const dir = getAgentMemoryDir(p(req.params.id));
  res.json(scanDirectory(dir));
}

// Read file from agent memory
export function getAgentMemoryFile(req: Request, res: Response): void {
  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: "path required" }); return; }
  const result = safeReadFile(getAgentMemoryDir(p(req.params.id)), filePath);
  if (!result) { res.status(404).json({ error: "File not found" }); return; }
  res.json(result);
}

// Browse group shared tree
export function getGroupSharedTree(req: Request, res: Response): void {
  const dir = getGroupSharedDir(p(req.params.id));
  res.json(scanDirectory(dir));
}

// Read file from group shared
export function getGroupSharedFile(req: Request, res: Response): void {
  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: "path required" }); return; }
  const result = safeReadFile(getGroupSharedDir(p(req.params.id)), filePath);
  if (!result) { res.status(404).json({ error: "File not found" }); return; }
  res.json(result);
}

// Read manifest from group shared
export function getGroupSharedManifest(req: Request, res: Response): void {
  try {
    const dir = getGroupSharedDir(p(req.params.id));
    res.json(readManifest(dir));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── SSE Stream ─────────────────────────────────────────────────

export function getGroupStream(req: Request, res: Response): void {
  const groupId = p(req.params.groupId);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (eventName: string, data: unknown) => {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial state
  try {
    const tasks = getGroupTasks(groupId);
    const agents = getGroupAgents(groupId);
    const schedulerLog = getSchedulerLog(groupId);
    send("initial_state", { tasks, agents, schedulerLog });
  } catch {
    // ignore
  }

  // Listen for events related to this group
  const groupAgentIds = new Set(getGroupAgents(groupId).map((a) => a.id));
  const handler = (event: GuildEvent) => {
    try {
      switch (event.type) {
        case "task_created":
          if (event.task.groupId === groupId) send("task_created", event.task);
          break;
        case "task_assigned": {
          const task = getTask(groupId, event.taskId);
          if (!task) break;
          send("task_assigned", task);
          break;
        }
        case "task_updated": {
          if (event.task.groupId !== groupId) break;
          send("task_updated", event.task);
          break;
        }
        case "task_bidding_start": {
          const task = getTask(groupId, event.taskId);
          if (!task) break;
          send("task_bidding_start", {
            taskId: event.taskId,
            agents: event.agents,
            task,
          });
          break;
        }
        case "scheduler_task_dispatched":
          if (event.groupId === groupId) {
            send("scheduler_log", event.schedulerLogEntry);
          }
          break;
        case "scheduler_dispatch_stalled":
          if (event.groupId === groupId) {
            send("scheduler_log", event.schedulerLogEntry);
          }
          break;
        case "task_completed": {
          if (!getTask(groupId, event.taskId)) break;
          send("task_completed", { taskId: event.taskId, agentId: event.agentId, result: event.result });
          break;
        }
        case "task_failed": {
          if (!getTask(groupId, event.taskId)) break;
          send("task_failed", { taskId: event.taskId, agentId: event.agentId, error: event.error });
          break;
        }
        case "task_cancelled":
          if (!getTask(groupId, event.taskId)) break;
          send("task_cancelled", { taskId: event.taskId });
          break;
        case "task_removed":
          if (event.groupId !== groupId) break;
          send("task_removed", { taskId: event.taskId });
          break;
        case "agent_status_changed":
          if (!groupAgentIds.has(event.agentId)) break;
          send("agent_status", { agentId: event.agentId, status: event.status });
          break;
        case "agent_output":
          if (!groupAgentIds.has(event.agentId)) break;
          send("agent_token", { agentId: event.agentId, taskId: event.taskId, token: event.content });
          break;
        case "agent_reasoning":
          if (!groupAgentIds.has(event.agentId)) break;
          send("agent_reasoning", { agentId: event.agentId, taskId: event.taskId, token: event.content });
          break;
        case "agent_tool_call":
          if (!groupAgentIds.has(event.agentId)) break;
          send("agent_tool_call", { agentId: event.agentId, taskId: event.taskId, tool: event.tool, input: event.input });
          break;
        case "agent_tool_result":
          if (!groupAgentIds.has(event.agentId)) break;
          send("agent_tool_result", { agentId: event.agentId, taskId: event.taskId, tool: event.tool, output: event.output });
          break;
        case "agent_plan":
          if (!groupAgentIds.has(event.agentId)) break;
          send("agent_plan", { agentId: event.agentId, taskId: event.taskId, phase: event.phase, payload: event.payload });
          break;
        case "agent_harness":
          if (!groupAgentIds.has(event.agentId)) break;
          send("agent_harness", { agentId: event.agentId, taskId: event.taskId, kind: event.kind, payload: event.payload });
          break;
        case "group_updated":
          if (event.groupId === groupId) {
            const freshAgents = getGroupAgents(groupId);
            groupAgentIds.clear();
            for (const a of freshAgents) groupAgentIds.add(a.id);
            send("group_updated", { groupId });
          }
          break;
        case "agent_updated": {
          const agent = getAgent(event.agentId);
          // Membership may have just changed (e.g. agent joined this group); fall back to live lookup.
          if (!groupAgentIds.has(event.agentId) && agent?.groupId !== groupId) break;
          if (agent) groupAgentIds.add(agent.id);
          send("agent_updated", agent ?? { agentId: event.agentId });
          break;
        }
      }
    } catch {
      // client disconnected
    }
  };

  guildEventBus.onAll(handler);

  // Heartbeat
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 15000);

  req.on("close", () => {
    guildEventBus.offAll(handler);
    clearInterval(heartbeat);
  });
}
