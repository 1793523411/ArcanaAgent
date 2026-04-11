import { useState } from "react";
import type { Group, GuildAgent } from "../../types/guild";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  groups: Group[];
  agents: GuildAgent[];
  selectedGroupId: string | null;
  onSelectGroup: (id: string) => void;
  onSelectAgent: (id: string) => void;
  onCreateGroup: () => void;
  onCreateAgent: () => void;
  onAddAgentToGroup: (groupId: string, agentId: string) => Promise<void>;
  onRemoveAgentFromGroup: (groupId: string, agentId: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
}

function groupHasActiveAgents(group: Group, agents: GuildAgent[]): boolean {
  return group.agents.some((id) => {
    const a = agents.find((ag) => ag.id === id);
    return a?.status === "working";
  });
}

export default function GroupList({
  groups, agents, selectedGroupId,
  onSelectGroup, onSelectAgent, onCreateGroup, onCreateAgent,
  onAddAgentToGroup, onRemoveAgentFromGroup, onDeleteGroup,
}: Props) {
  // Pool: agents not in any group, plus all agents for multi-group assignment
  const poolAgents = agents.filter((a) => !a.groupId);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [assigningTo, setAssigningTo] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-3 border-b shrink-0 flex items-center justify-between" style={{ borderColor: "var(--color-border)" }}>
        <span className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>小组</span>
        <button
          className="text-xs px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]"
          style={{ color: "var(--color-accent)" }}
          onClick={onCreateGroup}
          title="新建小组"
        >
          + 小组
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {groups.length === 0 && (
          <div className="text-xs text-center py-6" style={{ color: "var(--color-text-muted)" }}>
            暂无小组
          </div>
        )}
        {groups.map((group) => {
          const active = groupHasActiveAgents(group, agents);
          const memberCount = group.agents.length;
          const selected = group.id === selectedGroupId;
          const expanded = expandedGroup === group.id;
          const groupAgents = group.agents
            .map((id) => agents.find((a) => a.id === id))
            .filter((a): a is GuildAgent => a !== null);

          return (
            <div key={group.id}>
              <div
                className="w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer hover:bg-[var(--color-surface-hover)]"
                style={{
                  background: selected ? "var(--color-accent-alpha)" : "transparent",
                  border: `1px solid ${selected ? "var(--color-accent)" : "transparent"}`,
                }}
                onClick={() => {
                  onSelectGroup(group.id);
                  setExpandedGroup(expanded ? null : group.id);
                }}
                aria-expanded={expanded}
                role="button"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: active ? "#22c55e" : "var(--color-border)" }}
                    title={active ? "有 Agent 工作中" : "空闲"}
                  />
                  <span className="flex-1 text-sm truncate font-medium" style={{ color: "var(--color-text)" }}>
                    {group.name}
                  </span>
                  <span className="text-[11px] shrink-0" style={{ color: "var(--color-text-muted)" }}>
                    {memberCount}人
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    className="shrink-0 transition-transform duration-150"
                    style={{
                      color: "var(--color-text-muted)",
                      transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                    }}
                    aria-hidden
                  >
                    <path d="M4 2.5L7.5 6L4 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                {group.description && (
                  <div className="text-xs mt-0.5 truncate ml-4" style={{ color: "var(--color-text-muted)" }}>
                    {group.description}
                  </div>
                )}
              </div>

              {/* Expanded: show group members + actions */}
              {expanded && (
                <div className="ml-4 mt-1 mb-2 space-y-1">
                  {groupAgents.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-1.5 px-2 py-1.5 rounded text-xs cursor-pointer hover:bg-[var(--color-surface-hover)]"
                      onClick={(e) => { e.stopPropagation(); onSelectAgent(a.id); }}
                    >
                      <span>{a.icon}</span>
                      <span className="flex-1 truncate" style={{ color: a.color }}>{a.name}</span>
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: a.status === "working" ? "#22c55e" : "var(--color-border)" }}
                      />
                      <button
                        className="text-[10px] px-1 hover:text-red-400"
                        style={{ color: "var(--color-text-muted)" }}
                        title="移出小组"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveAgentFromGroup(group.id, a.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}

                  {/* Assign agent dropdown */}
                  {assigningTo === group.id ? (
                    <div className="px-2 py-1 space-y-1">
                      <div className="text-[10px] font-medium" style={{ color: "var(--color-text-muted)" }}>
                        选择要加入的 Agent:
                      </div>
                      {(() => {
                        const available = agents.filter((a) => !group.agents.includes(a.id));
                        if (available.length === 0) {
                          return (
                            <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                              没有可添加的 Agent，请先创建
                            </div>
                          );
                        }
                        return available.map((a) => (
                          <button
                            key={a.id}
                            className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:bg-[var(--color-surface-hover)] text-left"
                            onClick={() => {
                              onAddAgentToGroup(group.id, a.id);
                              setAssigningTo(null);
                            }}
                          >
                            <span>{a.icon}</span>
                            <span style={{ color: a.color }}>{a.name}</span>
                            {a.groupId && <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>(已在其他组)</span>}
                          </button>
                        ));
                      })()}
                      <button
                        className="text-[10px] px-2 py-0.5"
                        style={{ color: "var(--color-text-muted)" }}
                        onClick={() => setAssigningTo(null)}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2 px-2 pt-1">
                      <button
                        className="text-[10px] px-2 py-0.5 rounded hover:bg-[var(--color-surface-hover)]"
                        style={{ color: "var(--color-accent)" }}
                        onClick={(e) => { e.stopPropagation(); setAssigningTo(group.id); }}
                      >
                        + 添加成员
                      </button>
                      <button
                        className="text-[10px] px-2 py-0.5 rounded hover:bg-[var(--color-surface-hover)]"
                        style={{ color: "var(--color-text-muted)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingGroup(group);
                        }}
                      >
                        删除小组
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Agent pool */}
      <div className="shrink-0 border-t px-3 py-3 space-y-2" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold" style={{ color: "var(--color-text-muted)" }}>Agent 池</span>
          <button
            className="text-xs px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-accent)" }}
            onClick={onCreateAgent}
            title="创建 Agent"
          >
            + Agent
          </button>
        </div>
        {poolAgents.length === 0 ? (
          <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>暂无空闲 Agent</div>
        ) : (
          <div className="space-y-1">
            {poolAgents.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-[var(--color-surface-hover)]"
                onClick={() => onSelectAgent(a.id)}
              >
                <span className="text-sm">{a.icon}</span>
                <span className="flex-1 text-xs truncate" style={{ color: a.color }}>{a.name}</span>
                <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                  {a.stats.tasksCompleted}任务
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!deletingGroup}
        onOpenChange={(o) => { if (!o) setDeletingGroup(null); }}
        onConfirm={() => {
          const g = deletingGroup;
          setDeletingGroup(null);
          if (g) onDeleteGroup(g.id);
        }}
        title={deletingGroup ? `删除小组「${deletingGroup.name}」?` : "删除小组?"}
        description="删除后无法恢复。组内的 Agent 会被移到空闲池，历史任务记录保留。"
        confirmLabel="删除"
        variant="danger"
      />
    </div>
  );
}
