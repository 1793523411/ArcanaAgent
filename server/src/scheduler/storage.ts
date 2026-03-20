/**
 * 定时任务存储层
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import type {
  ScheduledTask,
  TaskExecution,
  TasksStorage,
  TaskHistoryStorage,
} from "./types.js";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const SCHEDULER_DIR = join(DATA_DIR, "scheduler");
const TASKS_FILE = join(SCHEDULER_DIR, "tasks.json");
const HISTORY_FILE = join(SCHEDULER_DIR, "history.json");
const STORAGE_VERSION = 1;

// 确保目录存在
function ensureDir() {
  if (!existsSync(SCHEDULER_DIR)) {
    mkdirSync(SCHEDULER_DIR, { recursive: true });
  }
}

// ─── 任务 CRUD ─────────────────────────────────────────────

export function loadTasks(): ScheduledTask[] {
  ensureDir();
  if (!existsSync(TASKS_FILE)) {
    const initial: TasksStorage = { tasks: [], version: STORAGE_VERSION };
    writeFileSync(TASKS_FILE, JSON.stringify(initial, null, 2));
    return [];
  }
  const data = JSON.parse(readFileSync(TASKS_FILE, "utf-8")) as TasksStorage;
  return data.tasks || [];
}

export function saveTasks(tasks: ScheduledTask[]): void {
  ensureDir();
  const data: TasksStorage = { tasks, version: STORAGE_VERSION };
  writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}

export function getTaskById(id: string): ScheduledTask | null {
  const tasks = loadTasks();
  return tasks.find((t) => t.id === id) || null;
}

export function createTask(task: ScheduledTask): void {
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
}

export function updateTask(id: string, updates: Partial<ScheduledTask>): boolean {
  const tasks = loadTasks();
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) return false;

  tasks[index] = {
    ...tasks[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  saveTasks(tasks);
  return true;
}

export function deleteTask(id: string): boolean {
  const tasks = loadTasks();
  const filtered = tasks.filter((t) => t.id !== id);
  if (filtered.length === tasks.length) return false;
  saveTasks(filtered);
  return true;
}

export function updateTaskLastRun(id: string, timestamp: string): void {
  const tasks = loadTasks();
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) return;

  tasks[index].lastRunAt = timestamp;
  tasks[index].executionCount = (tasks[index].executionCount || 0) + 1;
  saveTasks(tasks);
}

// ─── 执行历史 ─────────────────────────────────────────────

export function loadHistory(limit = 100): TaskExecution[] {
  ensureDir();
  if (!existsSync(HISTORY_FILE)) {
    const initial: TaskHistoryStorage = { executions: [], version: STORAGE_VERSION };
    writeFileSync(HISTORY_FILE, JSON.stringify(initial, null, 2));
    return [];
  }
  const data = JSON.parse(readFileSync(HISTORY_FILE, "utf-8")) as TaskHistoryStorage;
  const executions = data.executions || [];
  // 返回最近的 N 条记录
  return executions.slice(-limit);
}

export function saveExecution(execution: TaskExecution): void {
  ensureDir();
  const executions = loadHistory(500); // 保留最近 500 条
  executions.push(execution);

  const data: TaskHistoryStorage = {
    executions: executions.slice(-500), // 只保留最近 500 条
    version: STORAGE_VERSION,
  };
  writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

export function getTaskHistory(taskId: string, limit = 20): TaskExecution[] {
  const executions = loadHistory(200);
  return executions
    .filter((e) => e.taskId === taskId)
    .slice(-limit);
}

export function getRecentHistory(limit = 50): TaskExecution[] {
  const executions = loadHistory(100);
  return executions.slice(-limit).reverse();
}

// ─── 清理历史 ─────────────────────────────────────────────

export function cleanupOldHistory(daysToKeep = 30): number {
  const executions = loadHistory(1000);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);

  const filtered = executions.filter((e) => {
    const execDate = new Date(e.executedAt);
    return execDate >= cutoff;
  });

  const removed = executions.length - filtered.length;
  if (removed > 0) {
    const data: TaskHistoryStorage = {
      executions: filtered,
      version: STORAGE_VERSION,
    };
    writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
  }

  return removed;
}
