import type { GuildTask, GuildAgent } from "../../types/guild";
import type { ReactNode } from "react";

const PRIORITY_LABEL: Record<GuildTask["priority"], string> = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};

const PRIORITY_COLOR: Record<GuildTask["priority"], string> = {
  low: "var(--color-text-muted)",
  medium: "#f59e0b",
  high: "#ef4444",
  urgent: "#dc2626",
};

const KIND_LABEL: Record<NonNullable<GuildTask["kind"]>, string> = {
  requirement: "需求",
  subtask: "子任务",
  adhoc: "普通",
  pipeline: "流水线",
};

const KIND_COLOR: Record<NonNullable<GuildTask["kind"]>, string> = {
  requirement: "#8b5cf6",
  subtask: "#0ea5e9",
  adhoc: "var(--color-text-muted)",
  pipeline: "#14b8a6",
};

/** Extra decoration for the "soft" statuses that aren't really done or running. */
const STATUS_ACCENT: Partial<Record<GuildTask["status"], { border: string; bg: string; label: string }>> = {
  planning: { border: "#8b5cf6", bg: "rgba(139,92,246,0.08)", label: "规划中" },
  blocked: { border: "#f59e0b", bg: "rgba(245,158,11,0.08)", label: "阻塞中" },
};

interface Props {
  task: GuildTask;
  agents: GuildAgent[];
  onClick?: () => void;
  selected?: boolean;
  sideAction?: ReactNode;
  /** When true, task is waiting on upstream dependencies */
  blockedByDeps?: boolean;
}

export default function TaskCard({ task, agents, onClick, selected, sideAction, blockedByDeps }: Props) {
  const assignedAgent = agents.find((a) => a.id === task.assignedAgentId);
  const kind = task.kind ?? "adhoc";
  const statusAccent = STATUS_ACCENT[task.status];
  const subtaskCount = task.subtaskIds?.length ?? 0;

  const background = selected
    ? "var(--color-accent-alpha)"
    : statusAccent?.bg ?? "var(--color-bg)";
  const borderColor = selected
    ? "var(--color-accent)"
    : statusAccent?.border ?? "var(--color-border)";

  return (
    <div
      onClick={onClick}
      className="px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
      style={{
        background,
        border: `1px solid ${borderColor}`,
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium leading-snug" style={{ color: "var(--color-text)" }}>
            {task.title}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {kind !== "adhoc" && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-medium"
                style={{ background: KIND_COLOR[kind] + "22", color: KIND_COLOR[kind] }}
                title={kind === "requirement" ? "需求任务 — 由 Lead 分解为子任务" : "子任务 — 由父需求派生"}
              >
                {KIND_LABEL[kind]}
              </span>
            )}
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-medium"
              style={{ background: PRIORITY_COLOR[task.priority] + "22", color: PRIORITY_COLOR[task.priority] }}
            >
              {PRIORITY_LABEL[task.priority]}
            </span>
            {sideAction}
          </div>
        </div>

        {statusAccent && (
          <div className="text-[10px] mt-1" style={{ color: statusAccent.border }}>
            {statusAccent.label}
          </div>
        )}

        {blockedByDeps && (
          <div
            className="text-[10px] mt-1 flex items-center gap-1"
            style={{ color: "#d97706" }}
            title="等待前置子任务完成后自动分配"
          >
            <span>⏳</span> 等待依赖
          </div>
        )}

        {subtaskCount > 0 && (
          <div className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
            {subtaskCount} 个子任务
          </div>
        )}

        {task.declaredOutputs && task.declaredOutputs.length > 0 && (() => {
          const total = task.declaredOutputs.length;
          const produced = task.declaredOutputs.filter((o) => o.status === "produced").length;
          const missing = task.declaredOutputs.filter((o) => o.status === "missing").length;
          const color = missing > 0 ? "#ef4444" : produced === total ? "#10b981" : "#f59e0b";
          const icon = missing > 0 ? "❌" : produced === total ? "✅" : "🎯";
          return (
            <div
              className="text-[10px] mt-0.5 flex items-center gap-1"
              style={{ color }}
              title={`${produced}/${total} 产物已完成${missing > 0 ? `，${missing} 个缺失` : ""}`}
            >
              <span>{icon}</span>
              <span>
                {produced}/{total} 产物
                {missing > 0 && <span> · {missing} 缺失</span>}
              </span>
            </div>
          );
        })()}

        {assignedAgent && (
          <div className="flex items-center gap-1 mt-1.5">
            <span className="text-xs">{assignedAgent.icon}</span>
            <span className="text-xs" style={{ color: assignedAgent.color }}>{assignedAgent.name}</span>
          </div>
        )}
        {!assignedAgent && task.bids && task.bids.length > 0 && (
          <div className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
            {task.bids.length} 个投标
          </div>
        )}
      </div>
    </div>
  );
}
