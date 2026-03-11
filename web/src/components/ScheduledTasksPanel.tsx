import { useState, useEffect } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { ScheduledTask, TaskExecution, CreateTaskRequest } from "../types/scheduler";
import {
  getScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  toggleScheduledTask,
  executeScheduledTask,
  getAllExecutions,
} from "../api/scheduler";
import { TaskFormModal } from "./TaskFormModal";
import { TaskExecutionHistory } from "./TaskExecutionHistory";
import { useToast } from "./Toast";

interface Props {
  onClose: () => void;
  onConversationListRefresh?: () => void;
  onNavigateToConversation?: (conversationId: string) => void;
  currentConversationId?: string;
  onRefreshCurrentConversation?: (conversationId: string) => void;
  onTaskExecutionStart?: (conversationId: string) => void;
}

export default function ScheduledTasksPanel({
  onClose,
  onConversationListRefresh,
  onNavigateToConversation,
  currentConversationId,
  onRefreshCurrentConversation,
  onTaskExecutionStart,
}: Props) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [selectedView, setSelectedView] = useState<"tasks" | "history">("tasks");
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [executeTargetId, setExecuteTargetId] = useState<string | null>(null);
  const [lastExecutionIds, setLastExecutionIds] = useState<Set<string>>(new Set());
  const [hasNavigatedToScheduled, setHasNavigatedToScheduled] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadTasks();
    loadExecutions();
  }, []);

  // 自动刷新执行历史（轮询）
  useEffect(() => {
    // 只在执行历史视图时轮询
    if (selectedView !== "history") return;

    // 初始加载
    loadExecutions();

    // 每5秒刷新一次
    const interval = setInterval(() => {
      loadExecutions();
      // 同时刷新会话列表，因为定时任务可能更新了会话
      onConversationListRefresh?.();
      // 如果用户正在查看某个会话，也刷新该会话的消息
      if (currentConversationId && onRefreshCurrentConversation) {
        onRefreshCurrentConversation(currentConversationId);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [selectedView, onConversationListRefresh, currentConversationId, onRefreshCurrentConversation]);

  // 自动刷新任务列表（轮询）- 更新任务的执行计数和最后执行时间
  useEffect(() => {
    // 只在任务列表视图时轮询
    if (selectedView !== "tasks") return;

    // 每10秒刷新一次任务列表
    const interval = setInterval(() => {
      loadTasks();
    }, 10000);

    return () => clearInterval(interval);
  }, [selectedView]);

  const loadTasks = async () => {
    try {
      setLoading(true);
      const data = await getScheduledTasks();
      setTasks(data.tasks);
    } catch (error) {
      console.error("Failed to load tasks:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadExecutions = async () => {
    try {
      const data = await getAllExecutions(50);
      const newExecutions = data.executions;

      // 检测新的执行记录
      const newIds = new Set(newExecutions.map(e => e.id));
      const addedExecutions = newExecutions.filter(e => !lastExecutionIds.has(e.id));
      const isInitialLoad = lastExecutionIds.size === 0;

      // 如果有新的执行记录，处理会话刷新和跳转（跳过首次加载，避免把已有记录当“新增”导致一打开就关弹窗）
      if (addedExecutions.length > 0 && !isInitialLoad) {
        // 按时间排序，最新的在最后
        addedExecutions.sort((a, b) =>
          new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime()
        );

        for (const exec of addedExecutions) {
          if (exec.conversationId) {
            // 刷新会话列表
            onConversationListRefresh?.();

            // 如果是定时触发（scheduled）的任务，且未曾跳转过，自动跳转到新创建的会话
            if (exec.trigger === 'scheduled' && !hasNavigatedToScheduled.has(exec.conversationId)) {
              // 标记为任务执行中
              onTaskExecutionStart?.(exec.conversationId);

              toast(`定时任务「${exec.taskName}」已触发`, "success");
              onNavigateToConversation?.(exec.conversationId);
              onClose(); // 关闭定时任务面板
              setHasNavigatedToScheduled(prev => new Set(prev).add(exec.conversationId!));
              break; // 只跳转一次
            }
            // 如果用户正在查看这个会话，刷新消息
            else if (currentConversationId === exec.conversationId && onRefreshCurrentConversation) {
              onRefreshCurrentConversation(exec.conversationId);
            }
          }
        }
      }

      setExecutions(newExecutions);
      setLastExecutionIds(newIds);
    } catch (error) {
      console.error("Failed to load executions:", error);
    }
  };

  const handleCreate = async (data: CreateTaskRequest) => {
    try {
      await createScheduledTask(data);
      await loadTasks();
      setShowCreateModal(false);
      toast("任务创建成功", "success");
    } catch (error) {
      console.error("Failed to create task:", error);
      toast("创建任务失败: " + String(error), "error");
    }
  };

  const handleUpdate = async (task: ScheduledTask) => {
    try {
      const { id, createdAt, updatedAt, lastRunAt, nextRunAt, executionCount, ...updates } = task;
      await updateScheduledTask(id, updates);
      await loadTasks();
      setEditingTask(null);
      toast("任务更新成功", "success");
    } catch (error) {
      console.error("Failed to update task:", error);
      toast("更新任务失败: " + String(error), "error");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteScheduledTask(id);
      await loadTasks();
      setDeleteTargetId(null);
      toast("任务已删除", "success");
    } catch (error) {
      console.error("Failed to delete task:", error);
      toast("删除任务失败: " + String(error), "error");
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await toggleScheduledTask(id, !enabled);
      await loadTasks();
      toast(enabled ? "任务已禁用" : "任务已启用", "success");
    } catch (error) {
      console.error("Failed to toggle task:", error);
      toast("切换任务状态失败: " + String(error), "error");
    }
  };

  const handleExecute = async (id: string) => {
    try {
      setExecuteTargetId(null);

      // 执行任务（后端会预创建对话并立即返回）
      const execution = await executeScheduledTask(id);

      // 如果任务创建了新对话，立即跳转
      if (execution.conversationId) {
        // 标记为任务执行中
        onTaskExecutionStart?.(execution.conversationId);

        toast("正在执行任务...", "success");
        onNavigateToConversation?.(execution.conversationId);
        onClose(); // 关闭定时任务面板

        // 异步刷新列表（不阻塞跳转）
        Promise.all([loadExecutions(), loadTasks()]).then(() => {
          onConversationListRefresh?.();
        });
      } else {
        toast("任务已触发执行", "success");
        await Promise.all([loadExecutions(), loadTasks()]);
        onConversationListRefresh?.();
      }
    } catch (error) {
      console.error("Failed to execute task:", error);
      toast("执行任务失败: " + String(error), "error");
    }
  };

  const handleRefresh = () => {
    loadTasks();
    loadExecutions();
    onConversationListRefresh?.();
  };

  return (
    <div className="flex flex-col h-full border-l border-[var(--color-border)] bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-[var(--color-text)]">定时任务</span>
          <div className="flex gap-1">
            <button
              onClick={() => setSelectedView("tasks")}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                selectedView === "tasks"
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              任务列表
            </button>
            <button
              onClick={() => setSelectedView("history")}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                selectedView === "history"
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              执行历史
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="text-xs px-2 py-1 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="刷新"
          >
            ↻
          </button>
          <button
            onClick={onClose}
            className="text-xs px-2 py-1 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            ✕ 关闭
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        {selectedView === "tasks" ? (
          <TasksList
            tasks={tasks}
            loading={loading}
            onCreateNew={() => setShowCreateModal(true)}
            onEdit={setEditingTask}
            onDelete={setDeleteTargetId}
            onToggle={handleToggle}
            onExecute={setExecuteTargetId}
          />
        ) : (
          <TaskExecutionHistory
            executions={executions}
            onNavigateToConversation={(conversationId) => {
              onNavigateToConversation?.(conversationId);
              onClose();
            }}
          />
        )}
      </div>

      {/* Modals */}
      {showCreateModal && (
        <TaskFormModal
          onSubmit={handleCreate}
          onClose={() => setShowCreateModal(false)}
          allTasks={tasks}
        />
      )}
      {editingTask && (
        <TaskFormModal
          task={editingTask}
          onSubmit={(data) => handleUpdate({ ...editingTask, ...data } as ScheduledTask)}
          onClose={() => setEditingTask(null)}
          allTasks={tasks}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog.Root open={deleteTargetId !== null} onOpenChange={(open) => !open && setDeleteTargetId(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/60 z-[100] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <AlertDialog.Content className="fixed left-[50%] top-[50%] z-[101] max-h-[85vh] w-full max-w-md translate-x-[-50%] translate-y-[-50%] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            <AlertDialog.Title className="text-lg font-semibold text-[var(--color-text)]">
              删除任务
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-[var(--color-text-muted)]">
              确定要删除这个任务吗？此操作无法撤销。
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <button className="px-4 py-2 rounded border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors">
                  取消
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  onClick={() => deleteTargetId && handleDelete(deleteTargetId)}
                  className="px-4 py-2 rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
                >
                  删除
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* Execute Confirmation Dialog */}
      <AlertDialog.Root open={executeTargetId !== null} onOpenChange={(open) => !open && setExecuteTargetId(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/60 z-[100] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <AlertDialog.Content className="fixed left-[50%] top-[50%] z-[101] max-h-[85vh] w-full max-w-md translate-x-[-50%] translate-y-[-50%] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            <AlertDialog.Title className="text-lg font-semibold text-[var(--color-text)]">
              立即执行任务
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-[var(--color-text-muted)]">
              确定要立即执行这个任务吗？任务将不等待定时触发，马上开始执行。
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <button className="px-4 py-2 rounded border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors">
                  取消
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  onClick={() => executeTargetId && handleExecute(executeTargetId)}
                  className="px-4 py-2 rounded bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
                >
                  执行
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

// ─── 任务列表 ─────────────────────────────────────────────

interface TasksListProps {
  tasks: ScheduledTask[];
  loading: boolean;
  onCreateNew: () => void;
  onEdit: (task: ScheduledTask) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onExecute: (id: string) => void;
}

function TasksList({
  tasks,
  loading,
  onCreateNew,
  onEdit,
  onDelete,
  onToggle,
  onExecute,
}: TasksListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">
        加载中...
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-muted)] gap-4">
        <span className="text-4xl">⏰</span>
        <span className="text-sm">暂无定时任务</span>
        <button
          onClick={onCreateNew}
          className="px-4 py-2 bg-[var(--color-accent)] text-white rounded hover:opacity-90 transition-opacity"
        >
          + 创建第一个任务
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button
        onClick={onCreateNew}
        className="w-full px-4 py-2 bg-[var(--color-accent)] text-white rounded hover:opacity-90 transition-opacity"
      >
        + 创建新任务
      </button>

      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggle={onToggle}
          onExecute={onExecute}
        />
      ))}
    </div>
  );
}

// ─── 任务卡片 ─────────────────────────────────────────────

interface TaskCardProps {
  task: ScheduledTask;
  onEdit: (task: ScheduledTask) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onExecute: (id: string) => void;
}

function TaskCard({ task, onEdit, onDelete, onToggle, onExecute }: TaskCardProps) {
  const typeLabels: Record<string, string> = {
    conversation: "💬 对话",
    webhook: "🔗 Webhook",
    system: "⚙️ 系统",
    skill: "🎯 Skill",
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] transition-colors">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <input
              type="checkbox"
              checked={task.enabled}
              onChange={() => onToggle(task.id, task.enabled)}
              className="cursor-pointer"
            />
            <span className="font-medium text-[var(--color-text)]">{task.name}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]">
              {typeLabels[task.type] || task.type}
            </span>
            {task.dependsOn && task.dependsOn.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400">
                ⛓️ 有依赖
              </span>
            )}
          </div>
          {task.description && (
            <p className="text-sm text-[var(--color-text-muted)] mb-2">{task.description}</p>
          )}
          <div className="text-xs text-[var(--color-text-muted)] space-y-1">
            {task.schedule && (
              <div>📅 Cron: <code className="px-1 py-0.5 rounded bg-[var(--color-bg)] font-mono">{task.schedule}</code></div>
            )}
            {task.executeAt && (
              <div>⏱️ 执行时间: {new Date(task.executeAt).toLocaleString("zh-CN")}</div>
            )}
            {task.lastRunAt && (
              <div>✅ 上次执行: {new Date(task.lastRunAt).toLocaleString("zh-CN")} ({task.executionCount}次)</div>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => onExecute(task.id)}
            className="text-xs px-2 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
            title="立即执行"
          >
            ▶️
          </button>
          <button
            onClick={() => onEdit(task)}
            className="text-xs px-2 py-1 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            编辑
          </button>
          <button
            onClick={() => onDelete(task.id)}
            className="text-xs px-2 py-1 rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
