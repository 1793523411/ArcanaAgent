import { useEffect, useState, useMemo } from "react";
import type { GuildTask, GuildAgent } from "../../types/guild";
import TaskCard from "./TaskCard";
import InstructionInput from "./InstructionInput";

interface Props {
  tasks: GuildTask[];
  agents: GuildAgent[];
  groupAgentIds: string[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onCreateTask: (text: string, priority: GuildTask["priority"], kind: NonNullable<GuildTask["kind"]>) => void;
  onAutoBid: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onAssignTask: (taskId: string, agentId: string) => void;
  creating?: boolean;
}

const COLUMNS: { key: GuildTask["status"][]; label: string }[] = [
  { key: ["open", "bidding", "planning", "blocked"], label: "待处理" },
  { key: ["in_progress"], label: "进行中" },
  { key: ["completed", "failed", "cancelled"], label: "已完成" },
];

export default function TaskBoard({
  tasks, agents, groupAgentIds, selectedTaskId,
  onSelectTask, onCreateTask, onAutoBid, onDeleteTask, onAssignTask, creating,
}: Props) {
  const [assigningTask, setAssigningTask] = useState<string | null>(null);
  const [confirmingDeleteTask, setConfirmingDeleteTask] = useState<string | null>(null);
  const [collapsedReqs, setCollapsedReqs] = useState<Set<string>>(new Set());

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
                confirmingDeleteTask={confirmingDeleteTask}
                handleDeleteClick={handleDeleteClick}
                idleGroupAgents={idleGroupAgents}
                collapsedReqs={collapsedReqs}
                setCollapsedReqs={setCollapsedReqs}
              />
            </div>
          );
        })}
      </div>
      <InstructionInput onSubmit={onCreateTask} loading={creating} showPriority />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────

function DeleteButton({ confirming, onClick }: { taskId?: string; confirming: boolean; onClick: () => void }) {
  return (
    <button
      className="px-1 py-0.5 rounded text-[11px] transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: confirming ? "#dc2626" : "var(--color-text-muted)" }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={confirming ? "再次点击确认删除" : "删除任务"}
    >
      {confirming ? "确认" : "🗑"}
    </button>
  );
}

function ActionButtons({
  task, idleGroupAgents, assigningTask, setAssigningTask, onAutoBid, onAssignTask,
  confirmingDeleteTask, handleDeleteClick,
}: {
  task: GuildTask; idleGroupAgents: GuildAgent[];
  assigningTask: string | null; setAssigningTask: (id: string | null) => void;
  onAutoBid: (id: string) => void; onAssignTask: (id: string, agentId: string) => void;
  confirmingDeleteTask: string | null; handleDeleteClick: (id: string) => void;
}) {
  if (task.status !== "open" && task.status !== "bidding") return null;
  return (
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
          <button className="text-[10px] px-2" style={{ color: "var(--color-text-muted)" }} onClick={() => setAssigningTask(null)}>取消</button>
        </div>
      ) : (
        <>
          <button className="text-[10px] px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]" style={{ color: "var(--color-accent)" }} onClick={() => onAutoBid(task.id)}>⚡ 竞标</button>
          <button className="text-[10px] px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]" style={{ color: "var(--color-text-muted)" }} onClick={() => setAssigningTask(task.id)}>👤 指派</button>
          <button
            className="w-6 h-6 ml-auto rounded-md border transition-colors flex items-center justify-center text-[11px]"
            style={{
              color: confirmingDeleteTask === task.id ? "#dc2626" : "var(--color-text-muted)",
              borderColor: confirmingDeleteTask === task.id ? "#ef4444" : "var(--color-border)",
              background: confirmingDeleteTask === task.id ? "rgba(239,68,68,0.1)" : "var(--color-surface)",
            }}
            onClick={() => handleDeleteClick(task.id)}
            title={confirmingDeleteTask === task.id ? "再次点击确认删除" : "删除任务"}
          >
            {confirmingDeleteTask === task.id ? "!" : "🗑"}
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
  confirmingDeleteTask: string | null;
  handleDeleteClick: (id: string) => void;
  idleGroupAgents: GuildAgent[];
  collapsedReqs: Set<string>;
  setCollapsedReqs: React.Dispatch<React.SetStateAction<Set<string>>>;
}

type GroupedItem =
  | { type: "req"; task: GuildTask; children: GuildTask[]; ghost: false }
  | { type: "ghost-req"; parentTitle: string; parentId: string; children: GuildTask[] }
  | { type: "task"; task: GuildTask };

function CompletedColumn({
  colTasks, col, tasks, agents, selectedTaskId, onSelectTask,
  onAutoBid, onAssignTask, blockedByDepsSet, assigningTask, setAssigningTask,
  confirmingDeleteTask, handleDeleteClick, idleGroupAgents,
  collapsedReqs, setCollapsedReqs,
}: CompletedColumnProps) {
  const isTerminalCol = col.label === "已完成";

  const grouped = useMemo(() => {
    // Identify requirement tasks in this column
    // Subtasks grouped by parent
    const childMap = new Map<string, GuildTask[]>();
    const standalone: GuildTask[] = [];
    for (const t of colTasks) {
      if (t.kind === "requirement") continue;
      if (t.parentTaskId) {
        const arr = childMap.get(t.parentTaskId) ?? [];
        arr.push(t);
        childMap.set(t.parentTaskId, arr);
      } else {
        standalone.push(t);
      }
    }
    const items: GroupedItem[] = [];
    // Requirements present in this column
    for (const t of colTasks) {
      if (t.kind === "requirement") {
        items.push({ type: "req", task: t, children: childMap.get(t.id) ?? [], ghost: false });
        childMap.delete(t.id);
      }
    }
    // Ghost headers for subtasks whose parent requirement is in a different column
    for (const [parentId, children] of childMap) {
      const parent = tasks.find((t) => t.id === parentId);
      items.push({ type: "ghost-req", parentTitle: parent?.title ?? parentId.slice(0, 12), parentId, children });
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

  const renderSideAction = (task: GuildTask) =>
    (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
      ? <DeleteButton taskId={task.id} confirming={confirmingDeleteTask === task.id} onClick={() => handleDeleteClick(task.id)} />
      : undefined;

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
        confirmingDeleteTask={confirmingDeleteTask}
        handleDeleteClick={handleDeleteClick}
      />
    </div>
  );

  const renderReqGroup = (
    reqId: string,
    title: string,
    children: GuildTask[],
    opts: { clickable?: boolean; selected?: boolean; ghost?: boolean; deleteBtn?: boolean },
  ) => {
    const collapsed = collapsedReqs.has(reqId);
    const childCount = children.length;
    const borderColor = opts.ghost ? "var(--color-border)" : "#8b5cf633";
    const bgColor = opts.ghost ? "var(--color-surface)" : "rgba(139,92,246,0.06)";
    const leftBorder = opts.ghost ? "3px solid var(--color-border)" : "3px solid #8b5cf6";
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
                  background: opts.ghost ? "var(--color-border)" : "#8b5cf622",
                  color: opts.ghost ? "var(--color-text-muted)" : "#8b5cf6",
                }}
              >
                {opts.ghost ? "来自需求" : "需求"}
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
                <DeleteButton taskId={reqId} confirming={confirmingDeleteTask === reqId} onClick={() => handleDeleteClick(reqId)} />
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
          });
        }
        if (item.type === "ghost-req") {
          return renderReqGroup(item.parentId, item.parentTitle, item.children, { ghost: true });
        }
        return renderTaskWithActions(item.task);
      })}
      {grouped.length === 0 && (
        <div className="text-xs text-center py-4" style={{ color: "var(--color-text-muted)" }}>无</div>
      )}
    </div>
  );
}
