import { useEffect, useState } from "react";
import type { GuildTask, GuildAgent } from "../../types/guild";
import TaskCard from "./TaskCard";
import InstructionInput from "./InstructionInput";

interface Props {
  tasks: GuildTask[];
  agents: GuildAgent[];
  groupAgentIds: string[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onCreateTask: (text: string, priority: GuildTask["priority"]) => void;
  onAutoBid: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onAssignTask: (taskId: string, agentId: string) => void;
  creating?: boolean;
}

const COLUMNS: { key: GuildTask["status"][]; label: string }[] = [
  { key: ["open", "bidding"], label: "待处理" },
  { key: ["in_progress"], label: "进行中" },
  { key: ["completed", "failed", "cancelled"], label: "已完成" },
];

export default function TaskBoard({
  tasks, agents, groupAgentIds, selectedTaskId,
  onSelectTask, onCreateTask, onAutoBid, onDeleteTask, onAssignTask, creating,
}: Props) {
  const [assigningTask, setAssigningTask] = useState<string | null>(null);
  const [confirmingDeleteTask, setConfirmingDeleteTask] = useState<string | null>(null);

  const groupAgents = agents.filter((a) => groupAgentIds.includes(a.id));
  const idleGroupAgents = groupAgents.filter((a) => a.status === "idle" && !a.currentTaskId);

  const handleDeleteClick = (taskId: string) => {
    if (confirmingDeleteTask === taskId) {
      onDeleteTask(taskId);
      setConfirmingDeleteTask(null);
      return;
    }
    setConfirmingDeleteTask(taskId);
  };

  useEffect(() => {
    if (!confirmingDeleteTask) return;
    const timer = window.setTimeout(() => setConfirmingDeleteTask(null), 2500);
    return () => window.clearTimeout(timer);
  }, [confirmingDeleteTask]);

  const taskSortTime = (task: GuildTask): number => {
    const t = task.status === "completed" || task.status === "failed" || task.status === "cancelled"
      ? task.completedAt ?? task.startedAt ?? task.createdAt
      : task.status === "in_progress" || task.status === "bidding"
        ? task.startedAt ?? task.createdAt
        : task.createdAt;
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? 0 : ms;
  };

  if (tasks.length === 0 && !creating) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-3xl mb-2">📋</div>
            <div className="text-sm mb-1" style={{ color: "var(--color-text)" }}>暂无任务</div>
            <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>在下方输入指令创建任务</div>
            {groupAgents.length === 0 && (
              <div className="text-xs mt-3 px-4 py-2 rounded-lg" style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}>
                提示：请先在左侧小组中添加 Agent 成员
              </div>
            )}
          </div>
        </div>
        <InstructionInput onSubmit={onCreateTask} loading={creating} showPriority />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 grid grid-cols-3 gap-3 p-3 overflow-y-auto min-h-0">
        {COLUMNS.map((col) => {
          const colTasks = tasks
            .filter((t) => (col.key as string[]).includes(t.status))
            .sort((a, b) => taskSortTime(b) - taskSortTime(a));
          return (
            <div key={col.label} className="flex flex-col min-h-0">
              <div
                className="text-xs font-semibold px-2 py-1.5 rounded-t-lg shrink-0"
                style={{ background: "var(--color-surface)", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)" }}
              >
                {col.label}
                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--color-border)", color: "var(--color-text-muted)" }}>
                  {colTasks.length}
                </span>
              </div>
              <div
                className="flex-1 overflow-y-auto p-2 space-y-2 rounded-b-lg"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderTop: "none", minHeight: 80 }}
              >
                {colTasks.map((task) => (
                  <div key={task.id}>
                    <TaskCard
                      task={task}
                      agents={agents}
                      selected={task.id === selectedTaskId}
                      onClick={() => onSelectTask(task.id)}
                      sideAction={(task.status === "completed" || task.status === "failed" || task.status === "cancelled")
                        ? (
                            <button
                              className="px-1 py-0.5 rounded text-[11px] transition-colors hover:bg-[var(--color-surface-hover)]"
                              style={{
                                color: confirmingDeleteTask === task.id ? "#dc2626" : "var(--color-text-muted)",
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteClick(task.id);
                              }}
                              title={confirmingDeleteTask === task.id ? "再次点击确认删除" : "删除任务"}
                              aria-label={confirmingDeleteTask === task.id ? "确认删除任务" : "删除任务"}
                            >
                              {confirmingDeleteTask === task.id ? "确认" : "🗑"}
                            </button>
                          )
                        : undefined}
                    />
                    {/* Action buttons for open tasks */}
                    {(task.status === "open" || task.status === "bidding") && (
                      <div className="flex gap-1 mt-1 px-1">
                        {assigningTask === task.id ? (
                          <div className="w-full space-y-1 p-1 rounded" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
                            <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>选择 Agent:</div>
                            {idleGroupAgents.length === 0 ? (
                              <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>无空闲 Agent</div>
                            ) : (
                              idleGroupAgents.map((a) => (
                                <button
                                  key={a.id}
                                  className="w-full flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-[var(--color-surface-hover)] text-left"
                                  onClick={() => { onAssignTask(task.id, a.id); setAssigningTask(null); }}
                                >
                                  <span>{a.icon}</span>
                                  <span style={{ color: a.color }}>{a.name}</span>
                                </button>
                              ))
                            )}
                            <button
                              className="text-[10px] px-2"
                              style={{ color: "var(--color-text-muted)" }}
                              onClick={() => setAssigningTask(null)}
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              className="text-[10px] px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]"
                              style={{ color: "var(--color-accent)" }}
                              onClick={() => onAutoBid(task.id)}
                              title="让 Agent 自动竞标"
                            >
                              ⚡ 竞标
                            </button>
                            <button
                              className="text-[10px] px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]"
                              style={{ color: "var(--color-text-muted)" }}
                              onClick={() => setAssigningTask(task.id)}
                              title="手动指派"
                            >
                              👤 指派
                            </button>
                            <button
                              className="w-6 h-6 ml-auto rounded-md border transition-colors flex items-center justify-center text-[11px]"
                              style={{
                                color: confirmingDeleteTask === task.id ? "#dc2626" : "var(--color-text-muted)",
                                borderColor: confirmingDeleteTask === task.id ? "#ef4444" : "var(--color-border)",
                                background: confirmingDeleteTask === task.id ? "rgba(239,68,68,0.1)" : "var(--color-surface)",
                              }}
                              onClick={() => handleDeleteClick(task.id)}
                              title={confirmingDeleteTask === task.id ? "再次点击确认删除" : "删除任务"}
                              aria-label={confirmingDeleteTask === task.id ? "确认删除任务" : "删除任务"}
                            >
                              {confirmingDeleteTask === task.id ? "!" : "🗑"}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {colTasks.length === 0 && (
                  <div className="text-xs text-center py-4" style={{ color: "var(--color-text-muted)" }}>无</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <InstructionInput onSubmit={onCreateTask} loading={creating} showPriority />
    </div>
  );
}
