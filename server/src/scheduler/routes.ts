/**
 * 定时任务 HTTP API 路由
 */

import type { Request, Response } from "express";
import type {
  ScheduledTask,
  CreateTaskRequest,
  UpdateTaskRequest,
} from "./types.js";
import {
  loadTasks,
  createTask as createTaskInStorage,
  updateTask as updateTaskInStorage,
  deleteTask,
  getTaskById,
  getTaskHistory,
  getRecentHistory,
} from "./storage.js";
import { schedulerManager } from "./manager.js";
import { serverLogger } from "../lib/logger.js";

function validateWebhookConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") {
    return "Webhook 配置缺失";
  }
  const webhookConfig = config as { url?: unknown };
  if (typeof webhookConfig.url !== "string" || !webhookConfig.url.trim()) {
    return "Webhook URL 不能为空";
  }
  const url = webhookConfig.url.trim();
  if (/\s/.test(url)) {
    return "Webhook URL 格式错误：不能包含空格或多个 URL";
  }
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) {
      return "Webhook URL 仅支持 http/https";
    }
  } catch {
    return "Webhook URL 非法";
  }
  return null;
}

// ─── 获取所有任务 ─────────────────────────────────────────

export function getTasks(_req: Request, res: Response): void {
  try {
    const tasks = loadTasks();
    const status = schedulerManager.getStatus();

    res.json({
      tasks,
      total: tasks.length,
      status,
    });
  } catch (error) {
    serverLogger.error("Failed to get tasks:", error);
    res.status(500).json({ error: String(error) });
  }
}

// ─── 获取单个任务 ─────────────────────────────────────────

export function getTask(req: Request, res: Response): void {
  try {
    const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const task = getTaskById(taskId);

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.json(task);
  } catch (error) {
    serverLogger.error("Failed to get task:", error);
    res.status(500).json({ error: String(error) });
  }
}

// ─── 创建任务 ─────────────────────────────────────────────

export function createTask(req: Request, res: Response): void {
  try {
    const body = req.body as CreateTaskRequest;

    // 验证必填字段
    if (!body.name || !body.type || !body.config) {
      res.status(400).json({ error: "Missing required fields: name, type, config" });
      return;
    }

    // 验证调度配置
    if (!body.schedule && !body.executeAt) {
      res.status(400).json({ error: "Must provide either schedule or executeAt" });
      return;
    }
    if (body.type === "webhook") {
      const validationError = validateWebhookConfig(body.config);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
    }

    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name: body.name,
      description: body.description,
      enabled: body.enabled ?? true,
      type: body.type,
      config: body.config,
      schedule: body.schedule,
      executeAt: body.executeAt,
      dependsOn: body.dependsOn || [],
      createdAt: now,
      updatedAt: now,
      executionCount: 0,
      timeoutMs: body.timeoutMs,
      retries: body.retries,
    };

    createTaskInStorage(task);
    schedulerManager.addTask(task);

    serverLogger.info(`Created task: ${task.name}`, { taskId: task.id });

    res.status(201).json(task);
  } catch (error) {
    serverLogger.error("Failed to create task:", error);
    res.status(500).json({ error: String(error) });
  }
}

// ─── 更新任务 ─────────────────────────────────────────────

export function updateTask(req: Request, res: Response): void {
  try {
    const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const body = req.body as UpdateTaskRequest;

    const existing = getTaskById(taskId);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (existing.type === "webhook") {
      const validationError = validateWebhookConfig(body.config ?? existing.config);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
    }

    // 更新任务
    const success = updateTaskInStorage(taskId, body);
    if (!success) {
      res.status(500).json({ error: "Failed to update task" });
      return;
    }

    // 重新加载任务并更新调度
    const updatedTask = getTaskById(taskId);
    if (updatedTask) {
      schedulerManager.updateTaskSchedule(updatedTask);
    }

    serverLogger.info(`Updated task: ${taskId}`);

    res.json(updatedTask);
  } catch (error) {
    serverLogger.error("Failed to update task:", error);
    res.status(500).json({ error: String(error) });
  }
}

// ─── 删除任务 ─────────────────────────────────────────────

export function removeTask(req: Request, res: Response): void {
  try {
    const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const existing = getTaskById(taskId);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    schedulerManager.removeTask(taskId);

    serverLogger.info(`Deleted task: ${taskId}`);

    res.status(204).send();
  } catch (error) {
    serverLogger.error("Failed to delete task:", error);
    res.status(500).json({ error: String(error) });
  }
}

// ─── 启用/禁用任务 ─────────────────────────────────────────

export function toggleTask(req: Request, res: Response): void {
  try {
    const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { enabled } = req.body as { enabled: boolean };

    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }

    const existing = getTaskById(taskId);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    updateTaskInStorage(taskId, { enabled });

    const updatedTask = getTaskById(taskId);
    if (updatedTask) {
      schedulerManager.updateTaskSchedule(updatedTask);
    }

    serverLogger.info(`Toggled task ${taskId}: enabled=${enabled}`);

    res.json(updatedTask);
  } catch (error) {
    serverLogger.error("Failed to toggle task:", error);
    res.status(500).json({ error: String(error) });
  }
}

// ─── 手动执行任务 ─────────────────────────────────────────

export async function executeTaskNow(req: Request, res: Response): Promise<void> {
  try {
    const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const existing = getTaskById(taskId);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    serverLogger.info(`Manually executing task: ${taskId}`);

    // 先获取会话ID（如果任务会创建对话）
    const conversationId = await getConversationIdForTask(existing);

    // 如果预创建了对话，将ID注入到task config中
    let taskToExecute = existing;
    if (conversationId) {
      taskToExecute = {
        ...existing,
        config: {
          ...existing.config,
          _preCreatedConversationId: conversationId,
        },
      };
    }

    // 立即返回响应，包含conversationId（如果有）
    res.json({
      id: `exec_pending_${Date.now()}`,
      taskId: existing.id,
      taskName: existing.name,
      executedAt: new Date().toISOString(),
      status: "success" as const,
      duration: 0,
      trigger: "manual" as const,
      conversationId,
      output: conversationId ? "任务正在执行中..." : undefined,
    });

    // 后台继续执行任务（使用注入了conversationId的task）
    const executionPromise = schedulerManager.executeTaskManuallyWithTask(taskToExecute, "manual");
    executionPromise.catch((error) => {
      serverLogger.error(`Background task execution failed: ${taskId}`, error);
    });
  } catch (error) {
    serverLogger.error("Failed to execute task:", error);
    res.status(500).json({ error: String(error) });
  }
}

// 辅助函数：为任务预创建对话
async function getConversationIdForTask(task: ScheduledTask): Promise<string | undefined> {
  const { createConversation, setConversationTitle, appendMessages } = await import("../storage/index.js");
  const { HumanMessage } = await import("@langchain/core/messages");
  const { langChainToStored } = await import("../lib/messages.js");

  try {
    if (task.type === "conversation") {
      const config = task.config as { message: string };
      const { id } = createConversation();
      setConversationTitle(id, `定时任务：${config.message.slice(0, 30)}`);
      // 保存用户消息
      const humanMsg = new HumanMessage(config.message);
      appendMessages(id, [langChainToStored(humanMsg)]);
      return id;
    } else if (task.type === "webhook") {
      const config = task.config as { useModelOutput?: boolean; prompt?: string };
      if (config.useModelOutput && config.prompt) {
        const { id } = createConversation();
        setConversationTitle(id, `定时任务：${config.prompt.slice(0, 30)}`);
        // 保存用户消息
        const humanMsg = new HumanMessage(config.prompt);
        appendMessages(id, [langChainToStored(humanMsg)]);
        return id;
      }
    } else if (task.type === "skill") {
      const config = task.config as { skillName: string; params?: Record<string, unknown> };
      const { id } = createConversation();
      const message = `执行 Skill: ${config.skillName}，参数: ${JSON.stringify(config.params || {})}`;
      setConversationTitle(id, `定时任务：${config.skillName}`);
      // 保存用户消息
      const humanMsg = new HumanMessage(message);
      appendMessages(id, [langChainToStored(humanMsg)]);
      return id;
    }
  } catch (error) {
    serverLogger.error("Failed to pre-create conversation for task:", error);
  }
  return undefined;
}

// ─── 获取任务执行历史 ─────────────────────────────────────

export function getTaskExecutions(req: Request, res: Response): void {
  try {
    const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const limit = Number(req.query.limit) || 20;

    const executions = getTaskHistory(taskId, limit);

    res.json({
      executions,
      total: executions.length,
    });
  } catch (error) {
    serverLogger.error("Failed to get task executions:", error);
    res.status(500).json({ error: String(error) });
  }
}

// ─── 获取所有执行历史 ─────────────────────────────────────

export function getAllExecutions(req: Request, res: Response): void {
  try {
    const limit = Number(req.query.limit) || 50;
    const executions = getRecentHistory(limit);

    res.json({
      executions,
      total: executions.length,
    });
  } catch (error) {
    serverLogger.error("Failed to get executions:", error);
    res.status(500).json({ error: String(error) });
  }
}
