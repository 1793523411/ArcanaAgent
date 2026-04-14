import { useState, useEffect, useMemo } from "react";
import type { AgentMemory, GuildAgent } from "../../types/guild";
import { getAgentMemories } from "../../api/guild";
import MarkdownContent from "../MarkdownContent";

interface Props {
  agent: GuildAgent;
  onClose: () => void;
}

type MemoryType = AgentMemory["type"];

const TYPE_META: Record<MemoryType, { label: string; icon: string; color: string; desc: string }> = {
  experience: { label: "经验", icon: "🧠", color: "#8b5cf6", desc: "从任务执行中积累的经验" },
  knowledge: { label: "知识", icon: "📚", color: "#3b82f6", desc: "学到的领域知识和技术要点" },
  preference: { label: "偏好", icon: "⚙️", color: "#f59e0b", desc: "工作风格和行为偏好" },
};

const STRENGTH_BAR_COLORS = ["#d1d5db", "#86efac", "#4ade80", "#22c55e", "#16a34a"];

function strengthColor(s: number): string {
  const idx = Math.min(Math.floor(s / 2.5), STRENGTH_BAR_COLORS.length - 1);
  return STRENGTH_BAR_COLORS[idx];
}

export default function AgentMemoryPanel({ agent, onClose }: Props) {
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | MemoryType>("all");
  const [selected, setSelected] = useState<AgentMemory | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMemories([]);
    setSelected(null);
    (async () => {
      try {
        const data = await getAgentMemories(agent.id);
        if (!cancelled) setMemories(data);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agent.id]);

  const filtered = useMemo(
    () => filter === "all" ? memories : memories.filter((m) => m.type === filter),
    [memories, filter],
  );

  const counts = useMemo(() => {
    const c = { all: memories.length, experience: 0, knowledge: 0, preference: 0 };
    for (const m of memories) c[m.type]++;
    return c;
  }, [memories]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative w-full max-w-2xl rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", maxHeight: "80vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
          <div className="flex items-center gap-2">
            <span className="text-lg">{agent.icon}</span>
            <div>
              <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
                {selected ? selected.title : `${agent.name} — 记忆档案`}
              </h3>
              {!selected && (
                <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  {memories.length} 条记忆
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {selected && (
              <button
                onClick={() => setSelected(null)}
                className="text-xs px-2 py-1 rounded"
                style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
              >
                ← 返回
              </button>
            )}
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
              style={{ color: "var(--color-text-muted)" }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Type filter tabs */}
        {!selected && (
          <div className="flex items-center gap-1 px-5 py-2 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
            <button
              onClick={() => setFilter("all")}
              className="text-xs px-2.5 py-1 rounded-full transition-colors"
              style={{
                background: filter === "all" ? "var(--color-accent)" : "transparent",
                color: filter === "all" ? "white" : "var(--color-text-muted)",
              }}
            >
              全部 ({counts.all})
            </button>
            {(["experience", "knowledge", "preference"] as MemoryType[]).map((t) => {
              const meta = TYPE_META[t];
              return (
                <button
                  key={t}
                  onClick={() => setFilter(t)}
                  className="text-xs px-2.5 py-1 rounded-full transition-colors flex items-center gap-1"
                  style={{
                    background: filter === t ? meta.color : "transparent",
                    color: filter === t ? "white" : "var(--color-text-muted)",
                  }}
                >
                  <span className="text-[10px]">{meta.icon}</span>
                  {meta.label} ({counts[t]})
                </button>
              );
            })}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-48" style={{ color: "var(--color-text-muted)" }}>
              加载中...
            </div>
          ) : selected ? (
            /* Memory detail view */
            <div className="p-5 space-y-4">
              {/* Meta row */}
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ background: `${TYPE_META[selected.type].color}18`, color: TYPE_META[selected.type].color }}
                >
                  {TYPE_META[selected.type].icon} {TYPE_META[selected.type].label}
                </span>
                {selected.pinned && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "#f59e0b22", color: "#d97706" }}>
                    已固定
                  </span>
                )}
                <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  强度 {selected.strength}/10
                </span>
                <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  访问 {selected.accessCount} 次
                </span>
              </div>

              {/* Summary */}
              {selected.summary && (
                <div
                  className="rounded-lg px-4 py-3 text-sm"
                  style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                >
                  {selected.summary}
                </div>
              )}

              {/* Content */}
              <div className="text-sm">
                <MarkdownContent>{selected.content}</MarkdownContent>
              </div>

              {/* Tags */}
              {selected.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selected.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Timestamps */}
              <div className="text-xs space-y-0.5" style={{ color: "var(--color-text-muted)" }}>
                <div>创建：{new Date(selected.createdAt).toLocaleString("zh-CN")}</div>
                <div>更新：{new Date(selected.updatedAt).toLocaleString("zh-CN")}</div>
                {selected.lastAccessedAt && (
                  <div>最后访问：{new Date(selected.lastAccessedAt).toLocaleString("zh-CN")}</div>
                )}
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2" style={{ color: "var(--color-text-muted)" }}>
              <span className="text-3xl">🧠</span>
              <span className="text-sm">暂无记忆</span>
              <span className="text-xs">Agent 完成任务后会自动积累经验记忆</span>
            </div>
          ) : (
            /* Memory list */
            <div className="p-3 space-y-1">
              {filtered.map((m) => {
                const meta = TYPE_META[m.type];
                return (
                  <button
                    key={m.id}
                    onClick={() => setSelected(m)}
                    className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                  >
                    <span className="text-sm shrink-0 mt-0.5">{meta.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>
                          {m.title}
                        </span>
                        {m.pinned && (
                          <span className="text-[9px] px-1 py-px rounded shrink-0" style={{ background: "#f59e0b22", color: "#d97706" }}>
                            固定
                          </span>
                        )}
                      </div>
                      {m.summary && (
                        <div className="text-xs mt-0.5 line-clamp-2" style={{ color: "var(--color-text-muted)" }}>
                          {m.summary}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className="text-[9px] px-1 py-px rounded font-medium"
                          style={{ background: `${meta.color}18`, color: meta.color }}
                        >
                          {meta.label}
                        </span>
                        {/* Strength bar */}
                        <div className="flex items-center gap-0.5">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <div
                              key={i}
                              className="w-1.5 h-1.5 rounded-full"
                              style={{
                                background: i < Math.ceil(m.strength / 2)
                                  ? strengthColor(m.strength)
                                  : "var(--color-border)",
                              }}
                            />
                          ))}
                        </div>
                        <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                          {new Date(m.updatedAt).toLocaleDateString("zh-CN")}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
