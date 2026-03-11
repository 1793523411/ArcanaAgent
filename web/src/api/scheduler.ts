/**
 * 定时任务 API 调用
 */

import type {
  ScheduledTask,
  TaskExecution,
  CreateTaskRequest,
  UpdateTaskRequest,
} from "../types/scheduler";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const BASE = API_BASE ? `${API_BASE.replace(/\/$/, "")}/api` : "/api";

// ─── 任务 CRUD ─────────────────────────────────────────────

export async function getScheduledTasks(): Promise<{
  tasks: ScheduledTask[];
  total: number;
  status: Record<string, number>;
}> {
  const res = await fetch(`${BASE}/scheduled-tasks`);
  if (!res.ok) throw new Error("Failed to fetch tasks");
  return res.json();
}

export async function getScheduledTask(id: string): Promise<ScheduledTask> {
  const res = await fetch(`${BASE}/scheduled-tasks/${id}`);
  if (!res.ok) throw new Error("Failed to fetch task");
  return res.json();
}

export async function createScheduledTask(data: CreateTaskRequest): Promise<ScheduledTask> {
  const res = await fetch(`${BASE}/scheduled-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to create task");
  return res.json();
}

export async function updateScheduledTask(id: string, data: UpdateTaskRequest): Promise<ScheduledTask> {
  const res = await fetch(`${BASE}/scheduled-tasks/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update task");
  return res.json();
}

export async function deleteScheduledTask(id: string): Promise<void> {
  const res = await fetch(`${BASE}/scheduled-tasks/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete task");
}

export async function toggleScheduledTask(id: string, enabled: boolean): Promise<ScheduledTask> {
  const res = await fetch(`${BASE}/scheduled-tasks/${id}/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error("Failed to toggle task");
  return res.json();
}

export async function executeScheduledTask(id: string): Promise<TaskExecution> {
  const res = await fetch(`${BASE}/scheduled-tasks/${id}/execute`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to execute task");
  return res.json();
}

// ─── 执行历史 ─────────────────────────────────────────────

export async function getTaskExecutions(id: string, limit = 20): Promise<{
  executions: TaskExecution[];
  total: number;
}> {
  const res = await fetch(`${BASE}/scheduled-tasks/${id}/executions?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch executions");
  return res.json();
}

export async function getAllExecutions(limit = 50): Promise<{
  executions: TaskExecution[];
  total: number;
}> {
  const res = await fetch(`${BASE}/scheduled-executions?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch executions");
  return res.json();
}
