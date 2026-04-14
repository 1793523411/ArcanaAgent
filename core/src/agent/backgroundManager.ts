import { execFile, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { isDangerous } from "../lib/commandSafety.js";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "timeout" | "canceled";

export interface BackgroundTaskSnapshot {
  id: string;
  command: string;
  cwd: string;
  status: BackgroundTaskStatus;
  timeoutMs: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: string;
  outputPreview: string;
}

export interface BackgroundTaskNotification {
  taskId: string;
  status: BackgroundTaskStatus;
  result: string;
}

export type OutputPriority = "top" | "bottom" | "split";

export interface OutputViewOptions {
  priority?: OutputPriority;
  count?: number;
  skip?: number;
}

export interface OutputView {
  content: string;
  totalChars: number;
  returnedChars: number;
  hasMore: boolean;
}

interface BackgroundTaskRecord extends Omit<BackgroundTaskSnapshot, "outputPreview"> {
  output: string;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
}

interface StartTaskInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

interface StartTaskResult {
  ok: boolean;
  taskId?: string;
  error?: string;
  /** 命令去重命中，返回已有 task */
  deduplicated?: boolean;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
const MAX_OUTPUT_CHARS = 50_000;
const NOTIFICATION_OUTPUT_CHARS = 500;
const MAX_CONCURRENT_TASKS = 4;
const DEFAULT_OUTPUT_VIEW_CHARS = 1_200;
const MAX_OUTPUT_VIEW_CHARS = 20_000;
// DANGEROUS_PATTERNS moved to lib/commandSafety.ts for single source of truth

function limitChars(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated]...`;
}

function toOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isTerminalStatus(status: BackgroundTaskStatus): boolean {
  return status !== "running";
}

function clampOutputCount(count?: number): number {
  if (typeof count !== "number" || Number.isNaN(count)) return DEFAULT_OUTPUT_VIEW_CHARS;
  return Math.min(Math.max(Math.floor(count), 1), MAX_OUTPUT_VIEW_CHARS);
}

function clampOutputSkip(skip?: number): number {
  if (typeof skip !== "number" || Number.isNaN(skip)) return 0;
  return Math.max(0, Math.floor(skip));
}

// isDangerous imported from lib/commandSafety.ts

class BackgroundManager {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();

  private readonly notifications: BackgroundTaskNotification[] = [];

  private static readonly STALE_TASK_AGE_MS = 10 * 60 * 1000;

  /** 查找正在运行的相同命令（同一命令 + 同一工作目录才视为重复） */
  private findRunningByCommand(command: string, cwd: string): BackgroundTaskRecord | null {
    const normalized = command.replace(/\s+/g, " ").trim();
    for (const task of this.tasks.values()) {
      if (task.status === "running"
        && task.command.replace(/\s+/g, " ").trim() === normalized
        && task.cwd === cwd) {
        return task;
      }
    }
    return null;
  }

  /** 从命令字符串中提取端口号 */
  private extractPort(command: string): number | null {
    // 显式端口参数：--port 3000, -p 3000, PORT=3000
    const explicitMatch = command.match(/(?:--port\s+|-p\s+|PORT=)(\d{2,5})\b/i);
    if (explicitMatch) {
      const port = parseInt(explicitMatch[1], 10);
      if (port > 0 && port < 65536) return port;
    }
    // URL 形式：localhost:3000, 127.0.0.1:8080, 0.0.0.0:5173
    const urlMatch = command.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})\b/);
    if (urlMatch) {
      const port = parseInt(urlMatch[1], 10);
      if (port > 0 && port < 65536) return port;
    }
    return null;
  }

  /** 清理已终止超过 10 分钟的 task 记录，防止内存泄漏 */
  private cleanupStaleTasks(): void {
    const now = Date.now();
    for (const [id, task] of this.tasks.entries()) {
      if (isTerminalStatus(task.status) && task.finishedAt
        && now - task.finishedAt > BackgroundManager.STALE_TASK_AGE_MS) {
        this.tasks.delete(id);
      }
    }
  }

  start(input: StartTaskInput): StartTaskResult {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) {
      return { ok: false, error: "command is required." };
    }
    const blocked = isDangerous(command);
    if (blocked) {
      return { ok: false, error: blocked };
    }

    // 清理过期 task
    this.cleanupStaleTasks();

    // 命令去重：相同命令 + 同一目录已在运行，复用
    const effectiveCwd = input.cwd && input.cwd.trim() && existsSync(input.cwd) ? input.cwd : process.cwd();
    const existing = this.findRunningByCommand(command, effectiveCwd);
    if (existing) {
      return { ok: true, taskId: existing.id, deduplicated: true };
    }

    // 端口冲突检测
    const port = this.extractPort(command);
    if (port !== null) {
      for (const task of this.tasks.values()) {
        if (task.status === "running" && this.extractPort(task.command) === port) {
          return {
            ok: false,
            error: `Port ${port} already in use by task ${task.id} ("${task.command.slice(0, 80)}"). Cancel it first with background_cancel or use a different port.`,
          };
        }
      }
    }

    if (this.countRunningTasks() >= MAX_CONCURRENT_TASKS) {
      return { ok: false, error: `Too many running tasks. Limit is ${MAX_CONCURRENT_TASKS}.` };
    }

    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
    const cwd = input.cwd && input.cwd.trim() && existsSync(input.cwd) ? input.cwd : process.cwd();
    const now = Date.now();
    const taskId = randomUUID().slice(0, 8);
    const record: BackgroundTaskRecord = {
      id: taskId,
      command,
      cwd,
      status: "running",
      timeoutMs,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      output: "",
    };
    this.tasks.set(taskId, record);

    const child = execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd,
        env: { ...process.env, LANG: "en_US.UTF-8" },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        this.finalizeTask(taskId, {
          error,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      }
    );
    child.stdin?.end();
    record.child = child;
    record.timer = setTimeout(() => {
      const t = this.tasks.get(taskId);
      if (!t || t.status !== "running") return;
      t.status = "timeout";
      t.updatedAt = Date.now();
      t.finishedAt = Date.now();
      t.signal = "SIGTERM";
      t.output = limitChars("Error: Timeout exceeded.", MAX_OUTPUT_CHARS);
      t.child?.kill("SIGTERM");
      this.enqueueNotification(t);
    }, timeoutMs);

    return { ok: true, taskId };
  }

  getTask(taskId: string): BackgroundTaskSnapshot | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return this.toSnapshot(task);
  }

  getTaskOutputView(taskId: string, options?: OutputViewOptions): OutputView | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const text = task.output || "(no output)";
    const totalChars = text.length;
    const count = clampOutputCount(options?.count);
    const skip = clampOutputSkip(options?.skip);
    const priority = options?.priority ?? "bottom";
    if (priority === "top") {
      if (skip >= totalChars) {
        return { content: "", totalChars, returnedChars: 0, hasMore: false };
      }
      const start = skip;
      const end = Math.min(totalChars, start + count);
      const content = text.slice(start, end);
      return {
        content,
        totalChars,
        returnedChars: content.length,
        hasMore: end < totalChars,
      };
    }
    if (priority === "split") {
      if (skip * 2 >= totalChars) {
        return { content: "", totalChars, returnedChars: 0, hasMore: false };
      }
      const half = Math.max(1, Math.floor(count / 2));
      const topStart = skip;
      const topEnd = Math.min(totalChars, topStart + half);
      const bottomEnd = Math.max(0, totalChars - skip);
      const bottomStart = Math.max(topEnd, bottomEnd - half);
      const topPart = text.slice(topStart, topEnd);
      const bottomPart = text.slice(bottomStart, bottomEnd);
      if (topEnd >= bottomStart) {
        const merged = text.slice(topStart, bottomEnd);
        return {
          content: merged,
          totalChars,
          returnedChars: merged.length,
          hasMore: topStart > 0 || bottomEnd < totalChars,
        };
      }
      const content = `${topPart}\n...[omitted]...\n${bottomPart}`;
      return {
        content,
        totalChars,
        returnedChars: content.length,
        hasMore: topStart > 0 || bottomEnd < totalChars || topEnd < bottomStart,
      };
    }
    if (skip >= totalChars) {
      return { content: "", totalChars, returnedChars: 0, hasMore: false };
    }
    const end = totalChars - skip;
    const start = Math.max(0, end - count);
    const content = text.slice(start, end);
    return {
      content,
      totalChars,
      returnedChars: content.length,
      hasMore: start > 0,
    };
  }

  cancel(taskId: string): { ok: boolean; error?: string; task?: BackgroundTaskSnapshot } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: "Task not found." };
    if (task.status !== "running") {
      return { ok: false, error: `Task already ${task.status}.`, task: this.toSnapshot(task) };
    }
    if (task.timer) clearTimeout(task.timer);
    task.child?.kill("SIGTERM");
    task.status = "canceled";
    task.updatedAt = Date.now();
    task.finishedAt = Date.now();
    task.signal = "SIGTERM";
    if (!task.output) task.output = "Canceled by request.";
    this.enqueueNotification(task);
    return { ok: true, task: this.toSnapshot(task) };
  }

  drainNotifications(): BackgroundTaskNotification[] {
    if (this.notifications.length === 0) return [];
    const out = [...this.notifications];
    this.notifications.length = 0;
    return out;
  }

  private countRunningTasks(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running") count += 1;
    }
    return count;
  }

  private finalizeTask(
    taskId: string,
    payload: { error: Error | null; stdout: string; stderr: string }
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (isTerminalStatus(task.status)) return;
    if (task.timer) clearTimeout(task.timer);

    const combined = `${payload.stdout}\n${payload.stderr}`.trim();
    task.output = limitChars(combined, MAX_OUTPUT_CHARS);
    task.updatedAt = Date.now();
    task.finishedAt = Date.now();
    task.exitCode = task.child?.exitCode ?? undefined;
    task.signal = task.child?.signalCode ?? undefined;

    if (!payload.error) {
      task.status = "completed";
      if (!task.output) task.output = "(no output)";
      this.enqueueNotification(task);
      return;
    }
    if (task.status === "timeout" || task.signal === "SIGTERM") {
      task.status = task.status === "timeout" ? "timeout" : "failed";
      if (!task.output) {
        task.output = task.status === "timeout" ? "Error: Timeout exceeded." : payload.error.message;
      }
      this.enqueueNotification(task);
      return;
    }
    task.status = "failed";
    const reason = payload.error.message || "Command failed.";
    const merged = [task.output, reason].filter(Boolean).join("\n");
    task.output = limitChars(merged, MAX_OUTPUT_CHARS);
    this.enqueueNotification(task);
  }

  private enqueueNotification(task: BackgroundTaskRecord): void {
    const preview = limitChars(task.output || "(no output)", NOTIFICATION_OUTPUT_CHARS);
    this.notifications.push({
      taskId: task.id,
      status: task.status,
      result: preview,
    });
  }

  private toSnapshot(task: BackgroundTaskRecord): BackgroundTaskSnapshot {
    return {
      id: task.id,
      command: task.command,
      cwd: task.cwd,
      status: task.status,
      timeoutMs: task.timeoutMs,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      exitCode: task.exitCode,
      signal: task.signal,
      outputPreview: toOneLine(limitChars(task.output || "(no output)", 1_000)),
    };
  }
}

export const backgroundManager = new BackgroundManager();
