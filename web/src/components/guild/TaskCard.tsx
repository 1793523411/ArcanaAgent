import type { GuildTask, GuildAgent, TaskBid } from "../../types/guild";
import type { ReactNode } from "react";
import { useState } from "react";

/** Pick the weakest-contribution dimension of the highest-scoring
 *  below-threshold bid. Lets the TaskCard show *why* an open task sits
 *  there with bids but no assignment — "瓶颈：资产匹配" is more actionable
 *  than "X 个未达门槛" alone. Mirrors the server-side findBottleneck logic. */
function computeBottleneck(bids: TaskBid[]): string | null {
  const below = bids.filter((b) => b.via === "below_threshold");
  if (below.length === 0) return null;
  const top = below.slice().sort((a, b) => b.confidence - a.confidence)[0];
  const sb = top.scoreBreakdown;
  if (!sb) return null;
  const dims: Array<{ name: string; contribution: number }> = [];
  if (sb.llmScore != null) dims.push({ name: "LLM 评分", contribution: (sb.llmScore / 10) * 0.55 });
  else if (sb.embedding != null) dims.push({ name: "语义匹配", contribution: sb.embedding * 0.55 });
  else {
    dims.push({ name: "资产匹配", contribution: sb.asset * 0.35 });
    dims.push({ name: "技能匹配", contribution: sb.skill * 0.20 });
  }
  dims.push({ name: "记忆匹配", contribution: sb.memory * 0.30 });
  dims.push({ name: "历史胜率", contribution: sb.success * 0.15 });
  dims.sort((a, b) => a.contribution - b.contribution);
  return dims[0]?.name ?? null;
}

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

/** Color accent per status. The "已完成" board column actually contains
 *  three terminal states (completed / failed / cancelled) — without a per-card
 *  visual distinction users couldn't tell apart "this finished cleanly" from
 *  "this was cascade-cancelled because a sibling failed". Green / red / gray
 *  borders + a tiny status pill in the header solve this without splitting
 *  the column itself (which would shuffle existing UI muscle-memory). */
const STATUS_ACCENT: Partial<Record<GuildTask["status"], { border: string; bg: string; label: string }>> = {
  planning: { border: "#8b5cf6", bg: "rgba(139,92,246,0.08)", label: "规划中" },
  blocked: { border: "#f59e0b", bg: "rgba(245,158,11,0.08)", label: "阻塞中" },
  completed: { border: "#22c55e", bg: "rgba(34,197,94,0.06)", label: "已完成" },
  failed: { border: "#ef4444", bg: "rgba(239,68,68,0.08)", label: "失败" },
  cancelled: { border: "#9ca3af", bg: "rgba(156,163,175,0.08)", label: "已取消" },
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
  // Tap-to-expand for the bottleneck badge — native title only fires on
  // hover, so on touch devices the truncated dimension name was unrecoverable.
  const [bottleneckExpanded, setBottleneckExpanded] = useState(false);

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
          <span
            className="inline-block text-[10px] mt-1 px-1.5 py-0.5 rounded-full font-medium"
            style={{ background: statusAccent.bg, color: statusAccent.border, border: `1px solid ${statusAccent.border}40` }}
          >
            {statusAccent.label}
          </span>
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
        {!assignedAgent && task.bids && task.bids.length > 0 && (() => {
          const belowCount = task.bids.filter((b) => b.via === "below_threshold").length;
          const bottleneck = belowCount > 0 ? computeBottleneck(task.bids) : null;
          return (
            <div className="text-xs mt-1 flex items-center gap-1.5 flex-wrap" style={{ color: "var(--color-text-muted)" }}>
              <span>{task.bids.length} 个投标</span>
              {belowCount > 0 && (
                <span
                  role="button"
                  tabIndex={0}
                  className={`text-[10px] px-1.5 py-0.5 rounded cursor-help ${bottleneckExpanded ? "whitespace-normal break-words" : "max-w-[16rem] truncate"}`}
                  style={{ background: "#fee2e2", color: "#991b1b" }}
                  title={`${belowCount} 个候选未达竞标门槛${bottleneck ? `，其中最接近的一位瓶颈在「${bottleneck}」` : ""}（点击展开/收起）`}
                  onClick={(e) => { e.stopPropagation(); setBottleneckExpanded((v) => !v); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setBottleneckExpanded((v) => !v);
                    }
                  }}
                >
                  {belowCount} 未达门槛{bottleneck ? ` · 瓶颈：${bottleneck}` : ""}
                </span>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
