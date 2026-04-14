import type { GuildAgent } from "../../types/guild";

const STATUS_LABEL: Record<GuildAgent["status"], string> = {
  idle: "空闲",
  working: "工作中",
  offline: "离线",
};

const STATUS_COLOR: Record<GuildAgent["status"], string> = {
  idle: "var(--color-text-muted)",
  working: "#22c55e",
  offline: "var(--color-border)",
};

interface Props {
  agent: GuildAgent;
  onClick?: () => void;
  selected?: boolean;
}

const ASSET_TYPE_ICON: Record<string, string> = {
  repo: "📦", document: "📄", api: "🔌", database: "🗄️",
  prompt: "💬", config: "⚙️", mcp_server: "🖥️", custom: "📎",
};

export default function AgentCard({ agent, onClick, selected }: Props) {
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors"
      style={{
        background: selected ? "var(--color-accent-alpha)" : "transparent",
        border: `1px solid ${selected ? "var(--color-accent)" : "var(--color-border)"}`,
      }}
    >
      <span className="text-lg shrink-0">{agent.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate" style={{ color: agent.color }}>{agent.name}</div>
        <div className="text-xs truncate" style={{ color: "var(--color-text-muted)" }}>{agent.description}</div>
        {agent.assets.length > 0 && (
          <div className="flex items-center gap-1 mt-0.5">
            {[...new Set(agent.assets.map((a) => a.type))].slice(0, 4).map((t) => (
              <span key={t} className="text-[10px]" title={t}>{ASSET_TYPE_ICON[t] ?? "📎"}</span>
            ))}
            <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
              {agent.assets.length} 项资产
            </span>
          </div>
        )}
      </div>
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-medium"
        style={{ background: STATUS_COLOR[agent.status] + "22", color: STATUS_COLOR[agent.status] }}
      >
        {STATUS_LABEL[agent.status]}
      </span>
    </div>
  );
}
