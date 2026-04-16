import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { GuildTask, TaskStatus, TaskPriority, CreateTaskParams, TaskResult } from "./types.js";
import { guildEventBus } from "./eventBus.js";
import { atomicWriteFileSync } from "./atomicFs.js";

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
  atomicWriteFileSync(tasksPath(groupId), JSON.stringify(tasks, null, 2));
}

// ─── CRUD ───────────────────────────────────────────────────────

export function createTask(groupId: string, params: CreateTaskParams): GuildTask {
  const tasks = loadTasks(groupId);
  const now = new Date().toISOString();
  const task: GuildTask = {
    id: genId("task"),
    groupId,
    kind: params.kind ?? "adhoc",
    title: params.title,
    description: params.description,
    status: "open",
    priority: params.priority ?? "medium",
    dependsOn: params.dependsOn,
    createdBy: params.createdBy ?? "user",
    createdAt: now,
    parentTaskId: params.parentTaskId,
    suggestedSkills: params.suggestedSkills,
    suggestedAgentId: params.suggestedAgentId,
    acceptanceCriteria: params.acceptanceCriteria,
    workspaceRef: params.workspaceRef,
    pipelineId: params.pipelineId,
    pipelineInputs: params.pipelineInputs,
    retryPolicy: params.retryPolicy,
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
  updates: Partial<Pick<GuildTask,
    | "title" | "description" | "status" | "priority" | "assignedAgentId"
    | "result" | "startedAt" | "completedAt" | "bids" | "blockedBy"
    | "kind" | "parentTaskId" | "subtaskIds" | "suggestedSkills"
    | "suggestedAgentId" | "acceptanceCriteria" | "workspaceRef" | "handoff"
    | "retryCount" | "retryAt" | "skippedReason" | "_rejectedBy" | "dependsOn"
  >>
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
    rollupParentRequirement(groupId, task);
  }
  return task;
}

/**
 * After a subtask completes, check if its parent requirement has all subtasks
 * in terminal state. If so, roll the parent up to "completed" with a summary
 * aggregating the children. Failed subtasks roll the parent up to "failed".
 */
function rollupParentRequirement(groupId: string, child: GuildTask): void {
  const parentId = child.parentTaskId;
  if (!parentId) return;
  const parent = getTask(groupId, parentId);
  if (!parent || (parent.kind !== "requirement" && parent.kind !== "pipeline")) return;
  if (isTerminalStatus(parent.status)) return;
  const siblings = getSubtasks(groupId, parentId);
  if (siblings.length === 0) return;
  if (!siblings.every((s) => isTerminalStatus(s.status))) return;
  const failed = siblings.filter((s) => s.status === "failed");
  const completedCount = siblings.filter((s) => s.status === "completed").length;
  const now = new Date().toISOString();
  const lines = siblings.map((s, i) => {
    const mark = s.status === "completed" ? "✓" : s.status === "failed" ? "✗" : "·";
    return `${mark} ${i + 1}. ${s.title}`;
  });
  const summary =
    failed.length > 0
      ? `需求拆解的 ${siblings.length} 个子任务已全部结束（${completedCount} 完成 / ${failed.length} 失败）：\n${lines.join("\n")}`
      : `需求拆解的 ${siblings.length} 个子任务已全部完成：\n${lines.join("\n")}`;
  const result: TaskResult = { summary };
  const finalStatus = failed.length > 0 ? "failed" : "completed";
  const updated = updateTask(groupId, parentId, {
    status: finalStatus,
    completedAt: now,
    result,
  });
  if (updated) {
    if (finalStatus === "completed") {
      guildEventBus.emit({ type: "task_completed", taskId: parentId, agentId: parent.assignedAgentId ?? "lead", result });
    } else {
      guildEventBus.emit({ type: "task_failed", taskId: parentId, agentId: parent.assignedAgentId ?? "lead", error: `${failed.length} 个子任务失败` });
    }
  }
}

export function failTask(groupId: string, taskId: string, agentId: string, error: string): GuildTask | null {
  const existing = getTask(groupId, taskId);
  if (existing && isTerminalStatus(existing.status)) return existing;

  // Retry handling: if the task has a retry policy and has budget left,
  // reopen it instead of finalizing. Honors backoffMs via retryAt gate and
  // clears _rejectedBy unless the policy pins the same agent.
  if (existing?.retryPolicy) {
    const policy = existing.retryPolicy;
    const tries = existing.retryCount ?? 0;
    if (tries < policy.max) {
      const retryAt = policy.backoffMs && policy.backoffMs > 0
        ? new Date(Date.now() + policy.backoffMs).toISOString()
        : undefined;
      const task = updateTask(groupId, taskId, {
        status: "open",
        retryCount: tries + 1,
        retryAt,
        assignedAgentId: undefined,
        startedAt: undefined,
        result: undefined,
        _rejectedBy: policy.preferSameAgent ? existing._rejectedBy ?? [] : [],
      });
      if (task) {
        guildEventBus.emit({ type: "task_updated", task });
      }
      return task;
    }
    // Budget exhausted: branch on onExhausted.
    const mode = policy.onExhausted ?? "fail";
    if (mode === "skip") {
      const now = new Date().toISOString();
      const task = updateTask(groupId, taskId, {
        status: "cancelled",
        completedAt: now,
        skippedReason: `retry exhausted (${policy.max}) — skipped: ${error}`,
      });
      if (task) {
        guildEventBus.emit({ type: "task_cancelled", taskId });
        cascadeFailureToDependents(groupId, taskId, `依赖任务已跳过（${task.title}）`);
        rollupParentRequirement(groupId, task);
      }
      return task;
    }
    if (mode === "fallback" && policy.fallback) {
      const fb = policy.fallback;
      const fallback = createTask(groupId, {
        title: fb.title,
        description: fb.description,
        kind: "subtask",
        priority: existing.priority,
        parentTaskId: existing.parentTaskId,
        suggestedSkills: fb.suggestedSkills,
        suggestedAgentId: fb.suggestedAgentId,
        acceptanceCriteria: fb.acceptanceCriteria,
        workspaceRef: existing.workspaceRef,
        dependsOn: existing.dependsOn,
        createdBy: `retry-fallback:${taskId}`,
      });
      // Rewire anyone who depended on the failed task to depend on the fallback.
      const siblings = loadTasks(groupId);
      for (const sib of siblings) {
        if (sib.id === taskId) continue;
        if (sib.dependsOn?.includes(taskId)) {
          const newDeps = sib.dependsOn.map((d) => (d === taskId ? fallback.id : d));
          updateTask(groupId, sib.id, { dependsOn: newDeps });
        }
      }
      const now = new Date().toISOString();
      const task = updateTask(groupId, taskId, {
        status: "cancelled",
        completedAt: now,
        skippedReason: `retry exhausted (${policy.max}) — fallback=${fallback.id}: ${error}`,
      });
      if (task) {
        guildEventBus.emit({ type: "task_cancelled", taskId });
        rollupParentRequirement(groupId, task);
      }
      return task;
    }
    // mode === "fail" → fall through to standard failure.
  }

  const now = new Date().toISOString();
  const task = updateTask(groupId, taskId, {
    status: "failed",
    completedAt: now,
    result: { summary: `Failed: ${error}` },
  });
  if (task) {
    guildEventBus.emit({ type: "task_failed", taskId, agentId, error });
    cascadeFailureToDependents(groupId, taskId, `依赖任务失败（${task.title}）`);
    rollupParentRequirement(groupId, task);
  }
  return task;
}

export function cancelTask(groupId: string, taskId: string): GuildTask | null {
  const task = updateTask(groupId, taskId, { status: "cancelled", completedAt: new Date().toISOString() });
  if (task) {
    guildEventBus.emit({ type: "task_cancelled", taskId });
    cascadeFailureToDependents(groupId, taskId, `依赖任务已取消（${task.title}）`);
    rollupParentRequirement(groupId, task);
  }
  return task;
}

/**
 * When a task ends in a terminal non-completed state (failed/cancelled), any
 * downstream task that depends on it will never have deps-ready. Rather than
 * leaving the pipeline deadlocked with open children and an un-rolled-up
 * parent, recursively cancel the dependents so the parent can finalize.
 */
function cascadeFailureToDependents(groupId: string, failedTaskId: string, reason: string): void {
  const queue: string[] = [failedTaskId];
  const visited = new Set<string>();     // sources already dequeued
  const cancelled = new Set<string>();   // tasks already cascade-cancelled (avoid duplicates)
  while (queue.length) {
    const src = queue.shift()!;
    if (visited.has(src)) continue;
    visited.add(src);
    // Reload tasks each iteration so we see the latest status on disk and
    // don't attempt to cancel an already-terminal task a second time (e.g.
    // when a task depends on multiple failed ancestors).
    const tasks = loadTasks(groupId);
    for (const t of tasks) {
      if (cancelled.has(t.id)) continue;
      if (isTerminalStatus(t.status)) continue;
      if (!t.dependsOn?.includes(src)) continue;
      const now = new Date().toISOString();
      const updated = updateTask(groupId, t.id, {
        status: "cancelled",
        completedAt: now,
        skippedReason: `级联取消：${reason}`,
      });
      if (updated) {
        guildEventBus.emit({ type: "task_cancelled", taskId: t.id });
        cancelled.add(t.id);
        queue.push(t.id);
        rollupParentRequirement(groupId, updated);
      }
    }
  }
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

// ─── Subtask / Dependency helpers ───────────────────────────

/** Return the immediate subtasks of a parent requirement (order of creation). */
export function getSubtasks(groupId: string, parentTaskId: string): GuildTask[] {
  return loadTasks(groupId).filter((t) => t.parentTaskId === parentTaskId);
}

/**
 * All dependencies of a task must be `completed` for the task to be eligible.
 * Unknown deps (task id not in the group) are treated as completed so stale
 * references don't indefinitely block the DAG.
 */
export function areDepsReady(groupId: string, task: GuildTask): boolean {
  if (!task.dependsOn || task.dependsOn.length === 0) return true;
  const tasks = loadTasks(groupId);
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  for (const depId of task.dependsOn) {
    const dep = byId.get(depId);
    if (!dep) continue;
    if (dep.status !== "completed") return false;
  }
  return true;
}

/**
 * Scan a group for requirement tasks whose subtasks are all in terminal state
 * but the parent itself was never rolled up (e.g. data created before the
 * rollup logic existed). Roll them up now.
 */
export function reconcileRequirementRollups(groupId: string): number {
  const tasks = loadTasks(groupId);
  const subtasksByParent = new Map<string, GuildTask[]>();
  for (const t of tasks) {
    if (!t.parentTaskId) continue;
    const arr = subtasksByParent.get(t.parentTaskId) ?? [];
    arr.push(t);
    subtasksByParent.set(t.parentTaskId, arr);
  }
  let rolled = 0;
  for (const t of tasks) {
    if (t.kind !== "requirement" && t.kind !== "pipeline") continue;
    if (isTerminalStatus(t.status)) continue;
    const subs = subtasksByParent.get(t.id) ?? [];
    if (subs.length === 0) continue;
    if (!subs.every((s) => isTerminalStatus(s.status))) continue;
    rollupParentRequirement(groupId, subs[0]);
    rolled += 1;
  }
  return rolled;
}

/** Return requirement-kind tasks that have not yet been decomposed. */
export function getUnplannedRequirements(groupId: string): GuildTask[] {
  return loadTasks(groupId).filter((t) =>
    t.kind === "requirement" &&
    (t.status === "open" || t.status === "planning") &&
    (!t.subtaskIds || t.subtaskIds.length === 0),
  );
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
  atomicWriteFileSync(logPath(groupId, taskId), JSON.stringify(log, null, 2));
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
    atomicWriteFileSync(p, JSON.stringify(log, null, 2));
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
    atomicWriteFileSync(p, JSON.stringify(log, null, 2));
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
