import { useState, useMemo } from "react";
import type { GuildTask, GuildAgent } from "../../types/guild";
import TaskCard from "./TaskCard";
import InstructionInput from "./InstructionInput";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  tasks: GuildTask[];
  agents: GuildAgent[];
  groupAgentIds: string[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onCreateTask: (text: string, priority: GuildTask["priority"], kind: NonNullable<GuildTask["kind"]>) => void;
  onCreateTaskFromPipeline?: (payload: {
    pipelineId: string;
    inputs: Record<string, string>;
    priority: GuildTask["priority"];
    title?: string;
  }) => void;
  onAutoBid: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onAssignTask: (taskId: string, agentId: string) => Promise<void> | void;
  onStopTask?: (taskId: string) => Promise<void> | void;
  creating?: boolean;
}

const COLUMNS: { key: GuildTask["status"][]; label: string }[] = [
  { key: ["open", "bidding", "planning", "blocked"], label: "待处理" },
  { key: ["in_progress"], label: "进行中" },
  { key: ["completed", "failed", "cancelled"], label: "已完成" },
];

export default function TaskBoard({
  tasks, agents, groupAgentIds, selectedTaskId,
  onSelectTask, onCreateTask, onCreateTaskFromPipeline, onAutoBid, onDeleteTask, onAssignTask, onStopTask, creating,
}: Props) {
  const [assigningTask, setAssigningTask] = useState<string | null>(null);
  const [deletingTask, setDeletingTask] = useState<GuildTask | null>(null);
  const [deletingInFlight, setDeletingInFlight] = useState(false);
  const [collapsedReqs, setCollapsedReqs] = useState<Set<string>>(new Set());
  const [collapseAllCompleted, setCollapseAllCompleted] = useState<boolean>(() => {
    try { return localStorage.getItem("guild_completed_collapsed_all") === "true"; } catch { return false; }
  });

  // Pre-compute which tasks are blocked by unsatisfied dependencies
  const blockedByDepsSet = useMemo(() => {
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const blocked = new Set<string>();
    for (const t of tasks) {
      if (!t.dependsOn || t.dependsOn.length === 0) continue;
      if (t.status !== "open" && t.status !== "bidding") continue;
      const unmet = t.dependsOn.some((depId) => {
        const dep = taskById.get(depId);
        return dep && dep.status !== "completed";
      });
      if (unmet) blocked.add(t.id);
    }
    return blocked;
  }, [tasks]);

  const groupAgents = agents.filter((a) => groupAgentIds.includes(a.id));
  const idleGroupAgents = groupAgents.filter((a) => a.status === "idle" && !a.currentTaskId);

  const handleDeleteClick = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId) ?? null;
    setDeletingTask(task);
  };

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
        <InstructionInput onSubmit={onCreateTask} onSubmitPipeline={onCreateTaskFromPipeline} loading={creating} showPriority />
      </div>
    );
  }

  return (
    <>
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 grid grid-cols-3 gap-3 p-3 overflow-y-auto min-h-0">
        {COLUMNS.map((col) => {
          const colTasks = tasks
            .filter((t) => (col.key as string[]).includes(t.status))
            .sort((a, b) => taskSortTime(b) - taskSortTime(a));
          const isCompletedCol = col.label === "已完成";
          return (
            <div key={col.label} className="flex flex-col min-h-0">
              <div
                className="flex items-center justify-between text-xs font-semibold px-2 py-1.5 rounded-t-lg shrink-0"
                style={{ background: "var(--color-surface)", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)" }}
              >
                <span>
                  {col.label}
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--color-border)", color: "var(--color-text-muted)" }}>
                    {colTasks.length}
                  </span>
                </span>
                {isCompletedCol && (
                  <button
                    className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--color-surface-hover)] transition-colors"
                    style={{ color: "var(--color-text-muted)" }}
                    onClick={() => {
                      const next = !collapseAllCompleted;
                      setCollapseAllCompleted(next);
                      try { localStorage.setItem("guild_completed_collapsed_all", String(next)); } catch {}
                      // Seed/clear collapsedReqs **only for IDs in this column** —
                      // previously "全部展开" cleared the whole Set and wiped
                      // individual collapses the user had set in other columns.
                      const completedReqIds = new Set<string>();
                      for (const t of colTasks) {
                        if (isParentKind(t.kind)) completedReqIds.add(t.id);
                      }
                      const inColReqIds = new Set(
                        colTasks.filter((t) => isParentKind(t.kind)).map((t) => t.id),
                      );
                      for (const t of colTasks) {
                        if (!isParentKind(t.kind) && t.parentTaskId && !inColReqIds.has(t.parentTaskId)) {
                          completedReqIds.add(t.parentTaskId);
                        }
                      }
                      setCollapsedReqs((prev) => {
                        const nextSet = new Set(prev);
                        if (next) {
                          for (const id of completedReqIds) nextSet.add(id);
                        } else {
                          for (const id of completedReqIds) nextSet.delete(id);
                        }
                        return nextSet;
                      });
                    }}
                    title={collapseAllCompleted ? "展开所有需求组" : "折叠所有需求组"}
                  >
                    {collapseAllCompleted ? "▼ 全部展开" : "▲ 全部折叠"}
                  </button>
                )}
              </div>
              <CompletedColumn
                colTasks={colTasks}
                col={col}
                tasks={tasks}
                agents={agents}
                selectedTaskId={selectedTaskId}
                onSelectTask={onSelectTask}
                onAutoBid={onAutoBid}
                onAssignTask={onAssignTask}
                blockedByDepsSet={blockedByDepsSet}
                assigningTask={assigningTask}
                setAssigningTask={setAssigningTask}
                handleDeleteClick={handleDeleteClick}
                idleGroupAgents={idleGroupAgents}
                collapsedReqs={collapsedReqs}
                setCollapsedReqs={setCollapsedReqs}
                onStopTask={onStopTask}
              />
            </div>
          );
        })}
      </div>
      <InstructionInput onSubmit={onCreateTask} onSubmitPipeline={onCreateTaskFromPipeline} loading={creating} showPriority />
    </div>
    <ConfirmDialog
      open={!!deletingTask}
      onOpenChange={(o) => { if (!o && !deletingInFlight) setDeletingTask(null); }}
      onConfirm={async () => {
        const t = deletingTask;
        if (!t) return;
        setDeletingInFlight(true);
        try {
          await onDeleteTask(t.id);
          setDeletingTask(null);
        } finally {
          setDeletingInFlight(false);
        }
      }}
      title={deletingTask ? `删除任务「${deletingTask.title}」?` : "删除任务?"}
      description={
        deletingTask?.kind === "requirement" || deletingTask?.kind === "pipeline"
          ? "这是一个父任务，其所有子任务也会被删除。此操作不可撤销。"
          : "删除后无法恢复。"
      }
      confirmLabel="删除"
      variant="danger"
      loading={deletingInFlight}
    />
    </>
  );
}

// ─── Helpers ──────────────────────────────────────────────

function DeleteButton({ onClick }: { taskId?: string; onClick: () => void }) {
  return (
    <button
      className="px-1 py-0.5 rounded text-[11px] transition-colors hover:bg-red-500/10 hover:text-red-500"
      style={{ color: "var(--color-text-muted)" }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title="删除任务"
    >
      🗑
    </button>
  );
}

function ActionButtons({
  task, idleGroupAgents, assigningTask, setAssigningTask, onAutoBid, onAssignTask,
  handleDeleteClick,
}: {
  task: GuildTask; idleGroupAgents: GuildAgent[];
  assigningTask: string | null; setAssigningTask: (id: string | null) => void;
  onAutoBid: (id: string) => void; onAssignTask: (id: string, agentId: string) => Promise<void> | void;
  handleDeleteClick: (id: string) => void;
}) {
  const [assigningAgentId, setAssigningAgentId] = useState<string | null>(null);
  if (task.status !== "open" && task.status !== "bidding") return null;
  return (
    <div className="flex gap-1 mt-1 px-1">
      {assigningTask === task.id ? (
        <div className="w-full space-y-1 p-1 rounded" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
          <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>选择 Agent:</div>
          {idleGroupAgents.length === 0 ? (
            <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>无空闲 Agent</div>
          ) : (
            idleGroupAgents.map((a) => {
              const busy = assigningAgentId === a.id;
              return (
                <button
                  key={a.id}
                  disabled={assigningAgentId !== null}
                  className="w-full flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-[var(--color-surface-hover)] text-left disabled:opacity-60"
                  onClick={async () => {
                    setAssigningAgentId(a.id);
                    try {
                      await onAssignTask(task.id, a.id);
                      setAssigningTask(null);
                    } finally {
                      setAssigningAgentId(null);
                    }
                  }}
                >
                  <span>{a.icon}</span>
                  <span style={{ color: a.color }}>{a.name}</span>
                  {busy && <span className="ml-auto text-[10px]" style={{ color: "var(--color-text-muted)" }}>分配中…</span>}
                </button>
              );
            })
          )}
          <button
            className="text-[10px] px-2 disabled:opacity-50"
            style={{ color: "var(--color-text-muted)" }}
            disabled={assigningAgentId !== null}
            onClick={() => setAssigningTask(null)}
          >取消</button>
        </div>
      ) : (
        <>
          <button className="text-[10px] px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]" style={{ color: "var(--color-accent)" }} onClick={() => onAutoBid(task.id)}>⚡ 竞标</button>
          <button className="text-[10px] px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]" style={{ color: "var(--color-text-muted)" }} onClick={() => setAssigningTask(task.id)}>👤 指派</button>
          <button
            className="w-6 h-6 ml-auto rounded-md border transition-colors flex items-center justify-center text-[11px] hover:text-red-500 hover:border-red-500"
            style={{
              color: "var(--color-text-muted)",
              borderColor: "var(--color-border)",
              background: "var(--color-surface)",
            }}
            onClick={() => handleDeleteClick(task.id)}
            title="删除任务"
          >
            🗑
          </button>
        </>
      )}
    </div>
  );
}

// ─── Column with optional requirement grouping ──────────────

interface CompletedColumnProps {
  colTasks: GuildTask[];
  col: (typeof COLUMNS)[number];
  tasks: GuildTask[];
  agents: GuildAgent[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onAutoBid: (id: string) => void;
  onAssignTask: (id: string, agentId: string) => void;
  blockedByDepsSet: Set<string>;
  assigningTask: string | null;
  setAssigningTask: (id: string | null) => void;
  handleDeleteClick: (id: string) => void;
  idleGroupAgents: GuildAgent[];
  collapsedReqs: Set<string>;
  setCollapsedReqs: React.Dispatch<React.SetStateAction<Set<string>>>;
  onStopTask?: (taskId: string) => Promise<void> | void;
}

type ParentKind = "requirement" | "pipeline";
type GroupedItem =
  | { type: "req"; task: GuildTask; children: GuildTask[]; ghost: false; parentKind: ParentKind }
  | { type: "ghost-req"; parentTitle: string; parentId: string; children: GuildTask[]; parentKind: ParentKind }
  | { type: "task"; task: GuildTask };

const isParentKind = (k?: string): k is ParentKind => k === "requirement" || k === "pipeline";

function CompletedColumn({
  colTasks, col, tasks, agents, selectedTaskId, onSelectTask,
  onAutoBid, onAssignTask, blockedByDepsSet, assigningTask, setAssigningTask,
  handleDeleteClick, idleGroupAgents,
  collapsedReqs, setCollapsedReqs, onStopTask,
}: CompletedColumnProps) {
  const isTerminalCol = col.label === "已完成";
  const [stoppingTask, setStoppingTask] = useState<string | null>(null);

  const grouped = useMemo(() => {
    // Identify requirement tasks in this column
    // Subtasks grouped by parent
    const childMap = new Map<string, GuildTask[]>();
    const standalone: GuildTask[] = [];
    for (const t of colTasks) {
      if (isParentKind(t.kind)) continue;
      if (t.parentTaskId) {
        const arr = childMap.get(t.parentTaskId) ?? [];
        arr.push(t);
        childMap.set(t.parentTaskId, arr);
      } else {
        standalone.push(t);
      }
    }
    const items: GroupedItem[] = [];
    // Parent group headers (requirement / pipeline) present in this column
    for (const t of colTasks) {
      if (isParentKind(t.kind)) {
        items.push({
          type: "req",
          task: t,
          children: childMap.get(t.id) ?? [],
          ghost: false,
          parentKind: t.kind,
        });
        childMap.delete(t.id);
      }
    }
    // Ghost headers for subtasks whose parent is in a different column
    for (const [parentId, children] of childMap) {
      const parent = tasks.find((t) => t.id === parentId);
      const parentKind: ParentKind = isParentKind(parent?.kind) ? parent!.kind : "requirement";
      items.push({
        type: "ghost-req",
        parentTitle: parent?.title ?? parentId.slice(0, 12),
        parentId,
        children,
        parentKind,
      });
    }
    for (const t of standalone) {
      items.push({ type: "task", task: t });
    }

    // Sort: groups with active (in_progress) children float to top,
    // then by the most recent activity timestamp descending.
    const groupSortKey = (item: GroupedItem): number => {
      const children =
        item.type === "req" ? item.children
        : item.type === "ghost-req" ? item.children
        : [];
      // If any child (or the req itself) is in_progress, boost to top
      const hasActive = children.some((c) => c.status === "in_progress")
        || (item.type === "req" && item.task.status === "in_progress");
      const latestTime = Math.max(
        ...[
          ...(item.type === "req" ? [item.task] : []),
          ...children,
        ].map((t) => {
          const ts = t.completedAt ?? t.startedAt ?? t.createdAt;
          const ms = Date.parse(ts);
          return Number.isNaN(ms) ? 0 : ms;
        }),
        0,
      );
      // Active groups get a huge boost so they always sort first
      return hasActive ? latestTime + 1e15 : latestTime;
    };
    items.sort((a, b) => groupSortKey(b) - groupSortKey(a));

    return items;
  }, [colTasks, tasks]);

  const toggleReq = (id: string) => {
    setCollapsedReqs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleStopClick = async (taskId: string) => {
    if (!onStopTask || stoppingTask) return;
    setStoppingTask(taskId);
    try {
      await onStopTask(taskId);
    } finally {
      setStoppingTask(null);
    }
  };

  const renderSideAction = (task: GuildTask) => {
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      return <DeleteButton taskId={task.id} onClick={() => handleDeleteClick(task.id)} />;
    }
    if (onStopTask && task.status === "in_progress") {
      const isStopping = stoppingTask === task.id;
      return (
        <button
          className="text-[11px] px-2 py-0.5 rounded shrink-0"
          style={{
            background: "rgba(239,68,68,0.12)",
            color: "#ef4444",
            border: "1px solid rgba(239,68,68,0.3)",
            opacity: isStopping ? 0.6 : 1,
          }}
          disabled={isStopping}
          onClick={(e) => { e.stopPropagation(); handleStopClick(task.id); }}
          title="停止当前任务，Agent 将被释放"
        >
          {isStopping ? "停止中…" : "停止"}
        </button>
      );
    }
    return undefined;
  };

  const renderTaskWithActions = (task: GuildTask) => (
    <div key={task.id}>
      <TaskCard
        task={task}
        agents={agents}
        selected={task.id === selectedTaskId}
        onClick={() => onSelectTask(task.id)}
        sideAction={renderSideAction(task)}
        blockedByDeps={blockedByDepsSet.has(task.id)}
      />
      <ActionButtons
        task={task}
        idleGroupAgents={idleGroupAgents}
        assigningTask={assigningTask}
        setAssigningTask={setAssigningTask}
        onAutoBid={onAutoBid}
        onAssignTask={onAssignTask}
        handleDeleteClick={handleDeleteClick}
      />
    </div>
  );

  const renderReqGroup = (
    reqId: string,
    title: string,
    children: GuildTask[],
    opts: {
      clickable?: boolean;
      selected?: boolean;
      ghost?: boolean;
      deleteBtn?: boolean;
      parentKind?: ParentKind;
    },
  ) => {
    const collapsed = collapsedReqs.has(reqId);
    const childCount = children.length;
    const isPipeline = opts.parentKind === "pipeline";
    const accent = isPipeline ? "#3b82f6" : "#8b5cf6";
    const badgeLabel = isPipeline ? "流水线" : "需求";
    const ghostLabel = isPipeline ? "来自流水线" : "来自需求";
    const borderColor = opts.ghost ? "var(--color-border)" : `${accent}33`;
    const bgColor = opts.ghost ? "var(--color-surface)" : `${accent}10`;
    const leftBorder = opts.ghost ? "3px solid var(--color-border)" : `3px solid ${accent}`;
    return (
      <div key={reqId} className="rounded-lg overflow-hidden" style={{ border: `2px solid ${borderColor}` }}>
        <div
          className={`px-3 py-2 ${opts.clickable ? "cursor-pointer" : ""}`}
          style={{ background: bgColor, borderLeft: leftBorder }}
          onClick={opts.clickable ? () => onSelectTask(reqId) : undefined}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-bold"
                style={{
                  background: opts.ghost ? "var(--color-border)" : `${accent}22`,
                  color: opts.ghost ? "var(--color-text-muted)" : accent,
                }}
              >
                {opts.ghost ? ghostLabel : badgeLabel}
              </span>
              <span
                className="text-sm font-semibold truncate"
                style={{ color: opts.selected ? "var(--color-accent)" : "var(--color-text)" }}
              >
                {title}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {opts.deleteBtn && (
                <DeleteButton taskId={reqId} onClick={() => handleDeleteClick(reqId)} />
              )}
            </div>
          </div>
          {childCount > 0 && (
            <button
              className="flex items-center gap-1 mt-1 text-[10px]"
              style={{ color: "var(--color-text-muted)" }}
              onClick={(e) => { e.stopPropagation(); toggleReq(reqId); }}
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                className="transition-transform duration-150"
                style={{ transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }}
              >
                <path d="M4 2.5L7.5 6L4 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {childCount} 个子任务
            </button>
          )}
        </div>
        {!collapsed && childCount > 0 && (
          <div className="space-y-1 p-1.5" style={{ background: "var(--color-bg)" }}>
            {children.map((sub) => renderTaskWithActions(sub))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="flex-1 overflow-y-auto p-2 space-y-2 rounded-b-lg"
      style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderTop: "none", minHeight: 80 }}
    >
      {grouped.map((item) => {
        if (item.type === "req") {
          return renderReqGroup(item.task.id, item.task.title, item.children, {
            clickable: true,
            selected: item.task.id === selectedTaskId,
            deleteBtn: isTerminalCol,
            parentKind: item.parentKind,
          });
        }
        if (item.type === "ghost-req") {
          return renderReqGroup(item.parentId, item.parentTitle, item.children, {
            ghost: true,
            parentKind: item.parentKind,
          });
        }
        return renderTaskWithActions(item.task);
      })}
      {grouped.length === 0 && (
        <div className="text-xs text-center py-4" style={{ color: "var(--color-text-muted)" }}>无</div>
      )}
    </div>
  );
}
