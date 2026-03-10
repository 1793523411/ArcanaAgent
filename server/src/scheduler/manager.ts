/**
 * 定时任务调度管理器
 */

import cron from "node-cron";
import type { ScheduledTask, TaskExecution } from "./types.js";
import { executeTask } from "./executor.js";
import {
  loadTasks,
  saveExecution,
  updateTaskLastRun,
  updateTask,
  deleteTask as deleteTaskFromStorage,
} from "./storage.js";
import { serverLogger } from "../lib/logger.js";

class SchedulerManager {
  // Cron 任务实例
  private cronJobs = new Map<string, cron.ScheduledTask>();

  // 一次性任务定时器
  private oneTimeTimers = new Map<string, NodeJS.Timeout>();

  // 任务依赖关系图（taskId -> 依赖它的任务列表）
  private dependencyGraph = new Map<string, Set<string>>();

  // 最近完成的任务（用于依赖检查）
  private recentCompletions = new Map<string, string>(); // taskId -> 完成时间

  /**
   * 启动调度器
   */
  async start() {
    serverLogger.info("Starting scheduler manager...");

    const tasks = loadTasks();

    // 构建依赖图
    this.buildDependencyGraph(tasks);

    // 注册所有启用的任务
    for (const task of tasks) {
      if (task.enabled) {
        this.registerTask(task);
      }
    }

    serverLogger.info(`Scheduler started with ${tasks.length} tasks (${this.cronJobs.size} cron, ${this.oneTimeTimers.size} one-time)`);
  }

  /**
   * 构建依赖关系图
   */
  private buildDependencyGraph(tasks: ScheduledTask[]) {
    this.dependencyGraph.clear();

    for (const task of tasks) {
      if (task.dependsOn && task.dependsOn.length > 0) {
        for (const depId of task.dependsOn) {
          if (!this.dependencyGraph.has(depId)) {
            this.dependencyGraph.set(depId, new Set());
          }
          this.dependencyGraph.get(depId)!.add(task.id);
        }
      }
    }
  }

  /**
   * 注册任务
   */
  registerTask(task: ScheduledTask) {
    // 先取消已存在的任务
    this.unregisterTask(task.id);

    // 一次性任务
    if (task.executeAt) {
      this.registerOneTimeTask(task);
      return;
    }

    // 周期任务
    if (task.schedule) {
      this.registerCronTask(task);
      return;
    }

    serverLogger.warn(`Task ${task.id} has no schedule or executeAt, skipping registration`);
  }

  /**
   * 注册 Cron 周期任务
   */
  private registerCronTask(task: ScheduledTask) {
    if (!task.schedule || !cron.validate(task.schedule)) {
      serverLogger.error(`Invalid cron schedule for task ${task.id}: ${task.schedule}`);
      return;
    }

    try {
      const job = cron.schedule(
        task.schedule,
        async () => {
          await this.executeTaskWithDependencies(task.id, "scheduled");
        },
        {
          timezone: "Asia/Shanghai", // 使用中国时区
        }
      );

      this.cronJobs.set(task.id, job);

      // 计算下次执行时间（使用第三方库或简单估算）
      // 这里简单设置为当前时间，实际应该计算 cron 的下次触发时间
      updateTask(task.id, {
        nextRunAt: new Date(Date.now() + 60000).toISOString(), // 简化：1分钟后
      });

      serverLogger.info(`Registered cron task: ${task.name} (${task.schedule})`);
    } catch (error) {
      serverLogger.error(`Failed to register cron task ${task.id}:`, error);
    }
  }

  /**
   * 注册一次性任务
   */
  private registerOneTimeTask(task: ScheduledTask) {
    if (!task.executeAt) return;

    const executeTime = new Date(task.executeAt);
    const now = new Date();
    const delay = executeTime.getTime() - now.getTime();

    if (delay <= 0) {
      serverLogger.warn(`Task ${task.id} executeAt is in the past, executing immediately`);
      this.executeTaskWithDependencies(task.id, "scheduled");
      return;
    }

    const timer = setTimeout(async () => {
      await this.executeTaskWithDependencies(task.id, "scheduled");

      // 执行完后禁用任务
      updateTask(task.id, { enabled: false });
      this.unregisterTask(task.id);
    }, delay);

    this.oneTimeTimers.set(task.id, timer);

    serverLogger.info(`Registered one-time task: ${task.name} at ${task.executeAt} (in ${Math.round(delay / 1000)}s)`);
  }

  /**
   * 取消注册任务
   */
  unregisterTask(taskId: string) {
    // 停止 cron 任务
    const cronJob = this.cronJobs.get(taskId);
    if (cronJob) {
      cronJob.stop();
      this.cronJobs.delete(taskId);
    }

    // 清除一次性任务定时器
    const timer = this.oneTimeTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.oneTimeTimers.delete(taskId);
    }
  }

  /**
   * 执行任务（带依赖检查）
   */
  async executeTaskWithDependencies(
    taskId: string,
    trigger: "scheduled" | "manual" | "dependency"
  ): Promise<TaskExecution> {
    const task = loadTasks().find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // 检查依赖
    if (task.dependsOn && task.dependsOn.length > 0) {
      const missingDeps = this.checkDependencies(task);
      if (missingDeps.length > 0) {
        const execution: TaskExecution = {
          id: `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          taskId: task.id,
          taskName: task.name,
          executedAt: new Date().toISOString(),
          status: "skipped",
          duration: 0,
          error: `等待依赖任务完成: ${missingDeps.join(", ")}`,
          trigger,
        };
        saveExecution(execution);
        serverLogger.warn(`Task ${task.name} skipped due to unmet dependencies`, {
          missingDeps,
        });
        return execution;
      }
    }

    // 执行任务
    return await this.executeTaskCore(task, trigger);
  }

  /**
   * 核心执行逻辑
   */
  private async executeTaskCore(
    task: ScheduledTask,
    trigger: "scheduled" | "manual" | "dependency"
  ): Promise<TaskExecution> {
    const start = Date.now();
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    serverLogger.info(`Executing task: ${task.name}`, {
      taskId: task.id,
      trigger,
    });

    try {
      const result = await executeTask(task);
      const duration = Date.now() - start;

      const execution: TaskExecution = {
        id: executionId,
        taskId: task.id,
        taskName: task.name,
        executedAt: new Date().toISOString(),
        status: "success",
        duration,
        output: result.output.slice(0, 500), // 限制长度
        trigger,
        conversationId: result.conversationId, // 保存会话ID
      };

      saveExecution(execution);
      updateTaskLastRun(task.id, execution.executedAt);

      // 记录完成时间（用于依赖检查）
      this.recentCompletions.set(task.id, execution.executedAt);

      serverLogger.info(`Task completed: ${task.name}`, {
        taskId: task.id,
        duration,
        conversationId: result.conversationId,
      });

      // 触发依赖此任务的其他任务
      this.triggerDependentTasks(task.id);

      return execution;
    } catch (error) {
      const duration = Date.now() - start;
      const execution: TaskExecution = {
        id: executionId,
        taskId: task.id,
        taskName: task.name,
        executedAt: new Date().toISOString(),
        status: "failed",
        duration,
        error: error instanceof Error ? error.message : String(error),
        trigger,
      };

      saveExecution(execution);

      serverLogger.error(`Task failed: ${task.name}`, {
        taskId: task.id,
        error: execution.error,
      });

      return execution;
    }
  }

  /**
   * 检查任务依赖是否满足
   */
  private checkDependencies(task: ScheduledTask): string[] {
    if (!task.dependsOn || task.dependsOn.length === 0) {
      return [];
    }

    const missing: string[] = [];
    const recentWindow = 5 * 60 * 1000; // 5分钟窗口

    for (const depId of task.dependsOn) {
      const completionTime = this.recentCompletions.get(depId);
      if (!completionTime) {
        missing.push(depId);
        continue;
      }

      // 检查完成时间是否在窗口内
      const elapsed = Date.now() - new Date(completionTime).getTime();
      if (elapsed > recentWindow) {
        missing.push(depId);
      }
    }

    return missing;
  }

  /**
   * 触发依赖此任务的其他任务
   */
  private triggerDependentTasks(taskId: string) {
    const dependents = this.dependencyGraph.get(taskId);
    if (!dependents || dependents.size === 0) {
      return;
    }

    serverLogger.info(`Triggering ${dependents.size} dependent tasks for ${taskId}`);

    for (const depTaskId of dependents) {
      // 异步执行，不阻塞当前任务
      this.executeTaskWithDependencies(depTaskId, "dependency").catch((err) => {
        serverLogger.error(`Failed to trigger dependent task ${depTaskId}:`, err);
      });
    }
  }

  /**
   * 手动执行任务
   */
  async executeTaskManually(taskId: string): Promise<TaskExecution> {
    return await this.executeTaskWithDependencies(taskId, "manual");
  }

  /**
   * 手动执行任务（使用提供的task对象，可能包含预创建的conversationId）
   */
  async executeTaskManuallyWithTask(task: ScheduledTask, trigger: "manual" | "scheduled"): Promise<TaskExecution> {
    return await this.executeTaskCore(task, trigger);
  }

  /**
   * 添加新任务
   */
  addTask(task: ScheduledTask) {
    if (task.enabled) {
      this.registerTask(task);
    }
    // 重新构建依赖图
    this.buildDependencyGraph(loadTasks());
  }

  /**
   * 更新任务
   */
  updateTaskSchedule(task: ScheduledTask) {
    this.unregisterTask(task.id);
    if (task.enabled) {
      this.registerTask(task);
    }
    // 重新构建依赖图
    this.buildDependencyGraph(loadTasks());
  }

  /**
   * 删除任务
   */
  removeTask(taskId: string) {
    this.unregisterTask(taskId);
    deleteTaskFromStorage(taskId);
    // 重新构建依赖图
    this.buildDependencyGraph(loadTasks());
  }

  /**
   * 获取状态信息
   */
  getStatus() {
    return {
      cronTasks: this.cronJobs.size,
      oneTimeTasks: this.oneTimeTimers.size,
      dependencies: this.dependencyGraph.size,
      recentCompletions: this.recentCompletions.size,
    };
  }
}

export const schedulerManager = new SchedulerManager();
