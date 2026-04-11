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

interface Props {
  task: GuildTask;
  agents: GuildAgent[];
  onClick?: () => void;
  selected?: boolean;
  sideAction?: ReactNode;
}

export default function TaskCard({ task, agents, onClick, selected, sideAction }: Props) {
  const assignedAgent = agents.find((a) => a.id === task.assignedAgentId);

  return (
    <div
      onClick={onClick}
      className="px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
      style={{
        background: selected ? "var(--color-accent-alpha)" : "var(--color-bg)",
        border: `1px solid ${selected ? "var(--color-accent)" : "var(--color-border)"}`,
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium leading-snug" style={{ color: "var(--color-text)" }}>
            {task.title}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-medium"
              style={{ background: PRIORITY_COLOR[task.priority] + "22", color: PRIORITY_COLOR[task.priority] }}
            >
              {PRIORITY_LABEL[task.priority]}
            </span>
            {sideAction}
          </div>
        </div>
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
