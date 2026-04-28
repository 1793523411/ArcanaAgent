import type { GuildAgent, TaskBid } from "../../types/guild";

interface Props {
  bids: TaskBid[];
  agents: GuildAgent[];
  /** Id of the agent who actually got the task assigned. Used to anchor sort
   *  order and render the "胜出" badge. Undefined when the task is still open. */
  winnerId: string | undefined;
  expandedBidId: string | null;
  onToggleExpand: (agentId: string | null) => void;
}

/** Render the list of bids for a task, sorted winner → qualifying → below-
 *  threshold and with per-row badges/breakdown. Extracted out of DetailPanel
 *  so that panel doesn't need an IIFE just to do local `const` bindings. */
export default function BidList({ bids, agents, winnerId, expandedBidId, onToggleExpand }: Props) {
  if (bids.length === 0) return null;

  // Sort: winner first, then other qualifying bidders (higher conf first),
  // then below-threshold candidates last so the "why was X not picked" story
  // reads top-down.
  const sorted = [...bids].sort((a, b) => {
    if (a.agentId === winnerId) return -1;
    if (b.agentId === winnerId) return 1;
    const aBelow = a.via === "below_threshold";
    const bBelow = b.via === "below_threshold";
    if (aBelow !== bBelow) return aBelow ? 1 : -1;
    return b.confidence - a.confidence;
  });
  const belowCount = sorted.filter((b) => b.via === "below_threshold").length;

  return (
    <div>
      <div className="text-xs font-semibold mb-1.5" style={{ color: "var(--color-text-muted)" }}>
        投标（{bids.length}
        {belowCount > 0 && (
          <span style={{ color: "var(--color-text-muted)" }}>
            {" · "}{belowCount} 未达门槛
          </span>
        )}
        ）
      </div>
      <div className="space-y-1.5">
        {sorted.map((bid) => (
          <BidCard
            key={bid.agentId}
            bid={bid}
            agent={agents.find((a) => a.id === bid.agentId)}
            isWinner={bid.agentId === winnerId}
            isExpanded={expandedBidId === bid.agentId}
            onToggleExpand={() => onToggleExpand(expandedBidId === bid.agentId ? null : bid.agentId)}
          />
        ))}
      </div>
    </div>
  );
}

function BidCard({
  bid, agent, isWinner, isExpanded, onToggleExpand,
}: {
  bid: TaskBid;
  agent: GuildAgent | undefined;
  isWinner: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const sb = bid.scoreBreakdown;
  const isBelow = bid.via === "below_threshold";
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs space-y-1"
      style={{
        background: "var(--color-bg)",
        border: `1px solid ${isWinner ? "var(--color-accent)" : "var(--color-border)"}`,
      }}
    >
      {/* Don't dim the whole card for below-threshold bids — that drags
          the agent name down with it and the user can't tell apart "未达门槛"
          from "agent 离线/失效". The badge already conveys the status; opacity
          is reserved for the secondary metrics row below. */}
      <div className="flex items-center justify-between gap-2">
        <span
          className="font-medium truncate"
          style={{
            color: agent?.color ?? "var(--color-text-muted)",
            // A deleted-agent bid otherwise looks visually identical to a
            // live below-threshold one — half-opacity flags it as historical.
            opacity: agent ? 1 : 0.6,
          }}
        >
          {agent ? `${agent.icon} ${agent.name}` : bid.agentId}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {!agent && (
            <span
              className="text-[9px] px-1 py-0.5 rounded"
              style={{ background: "var(--color-border)", color: "var(--color-text-muted)" }}
              title="该 Agent 已被删除，本次投标仅作为历史记录"
            >Agent 已删除</span>
          )}
          {isWinner && (
            <span
              className="text-[9px] px-1 py-0.5 rounded"
              style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}
            >胜出</span>
          )}
          {bid.via === "fallback" && (
            <span
              className="text-[9px] px-1 py-0.5 rounded"
              style={{ background: "#f59e0b22", color: "#d97706" }}
              title="未达竞标门槛，通过兜底策略分配"
            >兜底</span>
          )}
          {bid.via === "suggested" && (
            <span
              className="text-[9px] px-1 py-0.5 rounded"
              style={{ background: "#a855f722", color: "#9333ea" }}
              title="任务显式指定了 suggestedAgentId，跳过竞标直接派发"
            >👉 指派</span>
          )}
          {isBelow && sb && (
            <span
              className="text-[9px] px-1 py-0.5 rounded"
              style={{ background: "#fee2e2", color: "#991b1b" }}
              title={`该 Agent 的最终得分 ${sb.final.toFixed(3)} 低于竞标门槛 ${sb.threshold.toFixed(3)}`}
            >未达门槛</span>
          )}
          {sb && (() => {
            // Surface which scoring path actually contributed the dominant
            // semantic signal — LLM > embedding > token (the same priority
            // bidding.ts uses when composing `core`). Lets users tell apart
            // "LLM said 8/10" from "token overlap got lucky".
            const source = sb.llmScore != null ? "LLM"
              : sb.embedding != null ? "embedding"
              : "token";
            const tone = source === "LLM" ? { bg: "#ec489922", fg: "#be185d" }
              : source === "embedding" ? { bg: "#3b82f622", fg: "#1d4ed8" }
              : { bg: "var(--color-border)", fg: "var(--color-text-muted)" };
            const label = source === "LLM" ? `LLM ${sb.llmScore!.toFixed(1)}/10`
              : source === "embedding" ? `embed ${(sb.embedding! * 100).toFixed(0)}%`
              : "token";
            const tip = source === "LLM" ? `LLM 评分 ${sb.llmScore!.toFixed(1)}/10${sb.llmReason ? "：" + sb.llmReason : ""}`
              : source === "embedding" ? `语义嵌入相似度 ${(sb.embedding! * 100).toFixed(1)}% — 已替代 token 匹配`
              : "未拿到 LLM / embedding 评分，回退到 token 重叠匹配（精度较低）";
            return (
              <span
                className="text-[9px] px-1 py-0.5 rounded"
                style={{ background: tone.bg, color: tone.fg }}
                title={tip}
              >{label}</span>
            );
          })()}
          <span style={{ color: isBelow ? "var(--color-text-muted)" : "var(--color-accent)" }}>
            置信度 {Math.round(bid.confidence * 100)}%
          </span>
        </div>
      </div>
      <div style={{ color: "var(--color-text-muted)", opacity: isBelow ? 0.65 : 1 }}>{bid.reasoning}</div>
      {sb && (
        <>
          <button
            className="text-[10px] underline"
            style={{ color: "var(--color-text-muted)" }}
            onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          >
            {isExpanded ? "收起" : "打分细节"}
          </button>
          {isExpanded && <BreakdownGrid sb={sb} />}
        </>
      )}
    </div>
  );
}

function BreakdownGrid({ sb }: { sb: NonNullable<TaskBid["scoreBreakdown"]> }) {
  // Each field is non-optional in the type, but server-side scoring evolves
  // (new model variants, missing features flagged as undefined) — so we
  // defensively null-coalesce. `.toFixed` on undefined is a hard throw that
  // would white-screen the whole bid panel for any schema drift.
  const fx = (n: number | undefined, digits = 3) => (n ?? 0).toFixed(digits);
  return (
    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]" style={{ color: "var(--color-text-muted)" }}>
      {sb.llmScore != null ? (
        <>
          <div>LLM 评分</div>
          <div className="text-right tabular-nums" style={{ color: "#ec4899" }}>{fx(sb.llmScore, 1)}/10</div>
          {sb.llmReason && <div className="col-span-2 text-[9px] italic" style={{ color: "var(--color-text-muted)" }}>{sb.llmReason}</div>}
        </>
      ) : sb.embedding != null ? (
        <>
          <div>语义匹配</div>
          <div className="text-right tabular-nums" style={{ color: "#8b5cf6" }}>{fx(sb.embedding)}</div>
        </>
      ) : (
        <>
          <div>资产匹配</div><div className="text-right tabular-nums">{fx(sb.asset)}</div>
          <div>技能匹配</div><div className="text-right tabular-nums">{fx(sb.skill)}</div>
        </>
      )}
      <div>记忆匹配</div><div className="text-right tabular-nums">{fx(sb.memory)}</div>
      <div>历史胜率</div><div className="text-right tabular-nums">{fx(sb.success)}</div>
      <div>所有者奖励</div><div className="text-right tabular-nums">{fx(sb.ownerBonus)}</div>
      {!sb.embedding && (
        <>
          <div>资产奖励</div><div className="text-right tabular-nums">{fx(sb.assetBonus)}</div>
        </>
      )}
      <div>负载惩罚</div><div className="text-right tabular-nums">-{fx(sb.loadPenalty)}</div>
      {/* Top border on the threshold/final pair separates the rollup from
          the per-dimension contributors so the eye lands on "got/needed"
          immediately, not on whatever row happened to be last in the grid. */}
      <div className="pt-1 border-t" style={{ borderColor: "var(--color-border)" }}>门槛</div>
      <div className="pt-1 border-t text-right tabular-nums" style={{ borderColor: "var(--color-border)" }}>{fx(sb.threshold)}</div>
      <div className="font-semibold text-xs" style={{ color: "var(--color-text)" }}>最终得分</div>
      <div
        className="text-right tabular-nums font-semibold text-xs"
        style={{ color: sb.final >= sb.threshold ? "var(--color-accent)" : "var(--color-error-text)" }}
      >
        {fx(sb.final)}
        {sb.final < sb.threshold && (
          // Match the red final-score weight so the delta — the most
          // actionable number on the card — doesn't read as decoration.
          <span className="ml-1 text-[10px] font-medium" style={{ color: "var(--color-error-text)" }}>
            （差 {fx(sb.threshold - sb.final)}）
          </span>
        )}
      </div>
    </div>
  );
}
