import type { Request, Response } from "express";
import {
  getGuild, updateGuild,
  createGroup, getGroup, listGroups, updateGroup, archiveGroup,
  createAgent, getAgent, listAgents, updateAgent, deleteAgent,
  assignAgentToGroup, removeAgentFromGroup, getGroupAgents, getUnassignedAgents,
  addAsset, removeAsset,
} from "./guildManager.js";
import {
  createTask, getTask, getGroupTasks, updateTask, cancelTask, assignTask, getExecutionLog,
} from "./taskBoard.js";
import { getMemories } from "./memoryManager.js";
import { executeAgentTask } from "./agentExecutor.js";
import { autoBid } from "./bidding.js";
import { guildEventBus } from "./eventBus.js";
import type { GuildEvent } from "./types.js";
import { serverLogger } from "../lib/logger.js";

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
    const { name, description, sharedContext } = req.body;
    if (!name || !description) {
      res.status(400).json({ error: "name and description are required" });
      return;
    }
    const group = createGroup({ name, description, sharedContext });
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
    const ok = archiveGroup(p(req.params.id));
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
    const task = createTask(groupId, req.body);

    // Auto-dispatch: bid + execute asynchronously
    setTimeout(() => {
      try {
        const winner = autoBid(groupId, task);
        if (winner) {
          executeAgentTask(winner.agentId, groupId, task.id).catch((err) => {
            serverLogger.error(`[guild] Auto-dispatch execution failed`, { error: String(err) });
          });
        }
      } catch (err) {
        serverLogger.error(`[guild] Auto-dispatch bidding failed`, { error: String(err) });
      }
    }, 0);

    res.status(201).json(task);
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
    const task = updateTask(groupId, taskId, req.body);
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deleteTask(req: Request, res: Response): void {
  try {
    const groupId = req.query.groupId as string;
    if (!groupId) { res.status(400).json({ error: "groupId query param required" }); return; }
    const task = cancelTask(groupId, p(req.params.id));
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }
    res.json({ success: true });
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

export function postAutoBid(req: Request, res: Response): void {
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
    const winner = autoBid(groupId, task);
    if (!winner) {
      res.json({ assigned: false, message: "No agent met the confidence threshold" });
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
    send("initial_state", { tasks, agents });
  } catch {
    // ignore
  }

  // Listen for events related to this group
  const handler = (event: GuildEvent) => {
    try {
      switch (event.type) {
        case "task_created":
          if (event.task.groupId === groupId) send("task_created", event.task);
          break;
        case "task_assigned": {
          // Re-read the task to send full object
          const task = getTask(event.taskId, event.taskId);
          send("task_assigned", task ?? { taskId: event.taskId, agentId: event.agentId });
          break;
        }
        case "task_completed": {
          send("task_completed", { taskId: event.taskId, agentId: event.agentId, result: event.result });
          break;
        }
        case "task_failed": {
          send("task_failed", { taskId: event.taskId, agentId: event.agentId, error: event.error });
          break;
        }
        case "task_cancelled":
          send("task_cancelled", { taskId: event.taskId });
          break;
        case "agent_status_changed":
          send("agent_status", { agentId: event.agentId, status: event.status });
          break;
        case "agent_output":
          send("agent_token", { agentId: event.agentId, taskId: event.taskId, token: event.content });
          break;
        case "agent_reasoning":
          send("agent_reasoning", { agentId: event.agentId, taskId: event.taskId, token: event.content });
          break;
        case "agent_tool_call":
          send("agent_tool_call", { agentId: event.agentId, taskId: event.taskId, tool: event.tool, input: event.input });
          break;
        case "agent_tool_result":
          send("agent_tool_result", { agentId: event.agentId, taskId: event.taskId, tool: event.tool, output: event.output });
          break;
        case "group_updated":
          if (event.groupId === groupId) send("group_updated", { groupId });
          break;
        case "agent_updated": {
          const agent = getAgent(event.agentId);
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
