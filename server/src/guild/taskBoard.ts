import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { GuildTask, TaskStatus, TaskPriority, CreateTaskParams, TaskResult } from "./types.js";
import { guildEventBus } from "./eventBus.js";

export interface ExecutionLogEntry {
  type: "text" | "reasoning" | "tool_call" | "tool_result" | "plan" | "harness";
  content: string;
  tool?: string;
  args?: string;
  /** Structured payload for plan / harness entries (JSON-serializable) */
  payload?: unknown;
  timestamp: string;
}

export interface TaskExecutionLog {
  taskId: string;
  agentId: string;
  events: ExecutionLogEntry[];
  status: "working" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
}

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const GUILD_DIR = join(DATA_DIR, "guild");
const GROUPS_DIR = join(GUILD_DIR, "groups");

function tasksPath(groupId: string): string {
  return join(GROUPS_DIR, groupId, "tasks.json");
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function loadTasks(groupId: string): GuildTask[] {
  const p = tasksPath(groupId);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")) as GuildTask[]; } catch { return []; }
}

function saveTasks(groupId: string, tasks: GuildTask[]): void {
  ensureDir(join(GROUPS_DIR, groupId));
  writeFileSync(tasksPath(groupId), JSON.stringify(tasks, null, 2));
}

// ─── CRUD ───────────────────────────────────────────────────────

export function createTask(groupId: string, params: CreateTaskParams): GuildTask {
  const tasks = loadTasks(groupId);
  const now = new Date().toISOString();
  const task: GuildTask = {
    id: genId("task"),
    groupId,
    title: params.title,
    description: params.description,
    status: "open",
    priority: params.priority ?? "medium",
    dependsOn: params.dependsOn,
    createdBy: params.createdBy ?? "user",
    createdAt: now,
  };
  tasks.push(task);
  saveTasks(groupId, tasks);
  guildEventBus.emit({ type: "task_created", task });
  return task;
}

export function getTask(groupId: string, taskId: string): GuildTask | null {
  const tasks = loadTasks(groupId);
  return tasks.find((t) => t.id === taskId) ?? null;
}

export function getGroupTasks(groupId: string, statusFilter?: TaskStatus[]): GuildTask[] {
  const tasks = loadTasks(groupId);
  if (!statusFilter || statusFilter.length === 0) return tasks;
  return tasks.filter((t) => statusFilter.includes(t.status));
}

export function getOpenTasks(groupId: string): GuildTask[] {
  return getGroupTasks(groupId, ["open"]);
}

export function updateTask(
  groupId: string,
  taskId: string,
  updates: Partial<Pick<GuildTask, "title" | "description" | "status" | "priority" | "assignedAgentId" | "result" | "startedAt" | "completedAt" | "bids" | "blockedBy">>
): GuildTask | null {
  const tasks = loadTasks(groupId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return null;
  const prevStatus = tasks[idx].status;
  Object.assign(tasks[idx], updates);
  saveTasks(groupId, tasks);
  // Broadcast generic update so reconcile / status flips reach the SSE clients
  // even when no specific event (assigned/completed/etc) is emitted by the caller.
  if (updates.status !== undefined && updates.status !== prevStatus) {
    guildEventBus.emit({ type: "task_updated", task: tasks[idx] });
  }
  return tasks[idx];
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function assignTask(
  groupId: string,
  taskId: string,
  agentId: string,
  bid?: import("./types.js").TaskBid,
  bids?: import("./types.js").TaskBid[],
): GuildTask | null {
  const now = new Date().toISOString();
  const task = updateTask(groupId, taskId, {
    status: "in_progress",
    assignedAgentId: agentId,
    startedAt: now,
    ...(bids !== undefined ? { bids } : {}),
  });
  if (task) {
    guildEventBus.emit({ type: "task_assigned", taskId, agentId, bid });
  }
  return task;
}

export function completeTask(groupId: string, taskId: string, agentId: string, result: TaskResult): GuildTask | null {
  const existing = getTask(groupId, taskId);
  if (existing && isTerminalStatus(existing.status)) return existing;
  const now = new Date().toISOString();
  const task = updateTask(groupId, taskId, {
    status: "completed",
    completedAt: now,
    result,
  });
  if (task) {
    guildEventBus.emit({ type: "task_completed", taskId, agentId, result });
  }
  return task;
}

export function failTask(groupId: string, taskId: string, agentId: string, error: string): GuildTask | null {
  const existing = getTask(groupId, taskId);
  if (existing && isTerminalStatus(existing.status)) return existing;
  const now = new Date().toISOString();
  const task = updateTask(groupId, taskId, {
    status: "failed",
    completedAt: now,
    result: { summary: `Failed: ${error}` },
  });
  if (task) {
    guildEventBus.emit({ type: "task_failed", taskId, agentId, error });
  }
  return task;
}

export function cancelTask(groupId: string, taskId: string): GuildTask | null {
  const task = updateTask(groupId, taskId, { status: "cancelled" });
  if (task) {
    guildEventBus.emit({ type: "task_cancelled", taskId });
  }
  return task;
}

/**
 * Hard-remove a task from the group store.
 * Returns true if a task was removed. Unlike `cancelTask`, this actually
 * deletes the record so it disappears from the UI.
 */
export function removeTask(groupId: string, taskId: string): boolean {
  const tasks = loadTasks(groupId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return false;
  tasks.splice(idx, 1);
  saveTasks(groupId, tasks);
  // Use task_removed (not task_cancelled) so SSE subscribers can splice the
  // task out of their local state instead of just flipping its status.
  guildEventBus.emit({ type: "task_removed", taskId, groupId });
  return true;
}

/** Scan all groups to find which one owns a task. Slow but fine for MVP. */
export function findTaskGroup(taskId: string): string | null {
  if (!existsSync(GROUPS_DIR)) return null;
  const groupIds = readdirSync(GROUPS_DIR) as string[];
  for (const gid of groupIds) {
    if (loadTasks(gid).some((t) => t.id === taskId)) return gid;
  }
  return null;
}

export function getAgentTasks(agentId: string): GuildTask[] {
  // Search across all groups — not optimal but fine for MVP
  const groupsDir = GROUPS_DIR;
  if (!existsSync(groupsDir)) return [];
  const groupIds = readdirSync(groupsDir) as string[];
  const result: GuildTask[] = [];
  for (const gid of groupIds) {
    const tasks = loadTasks(gid);
    result.push(...tasks.filter((t) => t.assignedAgentId === agentId));
  }
  return result;
}

// ─── Execution Log Persistence ─────────────────────────────

function logDir(groupId: string): string {
  return join(GROUPS_DIR, groupId, "logs");
}

function logPath(groupId: string, taskId: string): string {
  return join(logDir(groupId), `${taskId}.json`);
}

/** Initialize a task execution log */
export function initExecutionLog(groupId: string, taskId: string, agentId: string): void {
  ensureDir(logDir(groupId));
  const log: TaskExecutionLog = {
    taskId,
    agentId,
    events: [],
    status: "working",
    startedAt: new Date().toISOString(),
  };
  writeFileSync(logPath(groupId, taskId), JSON.stringify(log, null, 2));
}

/** Append an event to a task execution log */
export function appendExecutionLog(groupId: string, taskId: string, entry: ExecutionLogEntry): void {
  const p = logPath(groupId, taskId);
  if (!existsSync(p)) return;
  try {
    const log: TaskExecutionLog = JSON.parse(readFileSync(p, "utf-8"));
    const last = log.events.length > 0 ? log.events[log.events.length - 1] : null;
    // Merge consecutive text/reasoning events
    if ((entry.type === "text" || entry.type === "reasoning") && last && last.type === entry.type) {
      last.content += entry.content;
    } else {
      log.events.push(entry);
    }
    writeFileSync(p, JSON.stringify(log, null, 2));
  } catch {
    // ignore
  }
}

/** Mark execution log as completed/failed */
export function finalizeExecutionLog(groupId: string, taskId: string, status: "completed" | "failed"): void {
  const p = logPath(groupId, taskId);
  if (!existsSync(p)) return;
  try {
    const log: TaskExecutionLog = JSON.parse(readFileSync(p, "utf-8"));
    log.status = status;
    log.completedAt = new Date().toISOString();
    writeFileSync(p, JSON.stringify(log, null, 2));
  } catch {
    // ignore
  }
}

/** Get execution log for a task */
export function getExecutionLog(groupId: string, taskId: string): TaskExecutionLog | null {
  const p = logPath(groupId, taskId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TaskExecutionLog;
  } catch {
    return null;
  }
}
