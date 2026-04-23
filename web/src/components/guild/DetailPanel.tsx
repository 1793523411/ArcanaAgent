import { useEffect, useState, lazy, Suspense } from "react";
import type { GuildAgent, GuildTask } from "../../types/guild";
import AgentOutputStream from "./AgentOutputStream";
import MarkdownContent from "../MarkdownContent";
import ConfirmDialog from "./ConfirmDialog";
import AgentMemoryPanel from "./AgentMemoryPanel";
import DeliverablesPanel from "./DeliverablesPanel";
import { getTaskWorkspaceRaw, updateAgentAsset, clearTaskRejections, forkGuildAgent } from "../../api/guild";

const SubtaskDAG = lazy(() => import("./SubtaskDAG"));

interface Props {
  selectedAgent: GuildAgent | null;
  selectedTask: GuildTask | null;
  agents: GuildAgent[];
  tasks?: GuildTask[];
  agentOutputs: Record<string, string>;
  /** Ids of in_progress tasks that haven't emitted an SSE event recently. */
  staleTaskIds?: Set<string>;
  onClose: () => void;
  /** Collapse the entire panel (hide from layout). Shown as a second header button. */
  onCollapse?: () => void;
  onEditAgent?: (id: string) => void;
  onDeleteAgent?: (id: string) => Promise<void> | void;
  onReleaseAgent?: (id: string) => Promise<void> | void;
  /** Called after a new fork has been created; parent should refresh its agent list. */
  onAgentForked?: (newAgentId: string) => void;
  onViewLog?: (taskId: string) => void;
  onSelectTask?: (id: string) => void;
  onOpenWorkspace?: (agentId: string) => void;
  onAgentUpdated?: (agentId: string) => void;
}

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

const ARTIFACT_ICON: Record<string, { icon: string; color: string }> = {
  commit: { icon: "⑃", color: "#8b5cf6" },
  file: { icon: "📄", color: "#3b82f6" },
  url: { icon: "🔗", color: "#06b6d4" },
  note: { icon: "📝", color: "#f59e0b" },
};

const ASSET_TYPE_ICON: Record<string, string> = {
  repo: "📦", document: "📄", api: "🔌", database: "🗄️",
  prompt: "💬", config: "⚙️", mcp_server: "🖥️", custom: "📎",
};

export default function DetailPanel({ selectedAgent, selectedTask, agents, tasks, agentOutputs, staleTaskIds, onClose, onCollapse, onEditAgent, onDeleteAgent, onReleaseAgent, onAgentForked, onViewLog, onSelectTask, onOpenWorkspace, onAgentUpdated }: Props) {
  const [expandedResult, setExpandedResult] = useState(false);
  const [expandedWorkspace, setExpandedWorkspace] = useState(false);
  const [expandedDAG, setExpandedDAG] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [forkBusy, setForkBusy] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [workspaceMd, setWorkspaceMd] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [expandedBid, setExpandedBid] = useState<string | null>(null);
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; uri: string; description: string; tags: string }>({ name: "", uri: "", description: "", tags: "" });
  const [savingAsset, setSavingAsset] = useState(false);

  // Fetch workspace markdown whenever a requirement task is selected.
  // Subtasks carry their parent's workspaceRef, so we resolve the viewer
  // target off whichever id the task exposes.
  useEffect(() => {
    setWorkspaceMd(null);
    setWorkspaceError(null);
    setExpandedBid(null);
    if (!selectedTask) return;
    const parentId = selectedTask.kind === "requirement"
      ? selectedTask.id
      : selectedTask.parentTaskId;
    if (!parentId) return;
    let cancelled = false;
    (async () => {
      try {
        const md = await getTaskWorkspaceRaw(selectedTask.groupId, parentId);
        if (!cancelled) setWorkspaceMd(md);
      } catch (e) {
        if (!cancelled) {
          const msg = String(e);
          // Friendlier message for the common "no workspace yet" case.
          if (/Workspace not found|404/.test(msg)) {
            setWorkspaceMd("");
          } else {
            setWorkspaceError(msg);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTask?.id, selectedTask?.kind, selectedTask?.parentTaskId, selectedTask?.groupId]);

  if (!selectedAgent && !selectedTask) {
    return (
      <div className="flex flex-col h-full">
        {onCollapse && (
          <div className="flex justify-end px-2 py-2 border-b" style={{ borderColor: "var(--color-border)" }}>
            <button
              onClick={onCollapse}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
              style={{ color: "var(--color-text-muted)" }}
              title="收起面板"
            >
              ▶
            </button>
          </div>
        )}
        <div className="flex-1 flex flex-col items-center justify-center" style={{ color: "var(--color-text-muted)" }}>
          <div className="text-2xl mb-2">👆</div>
          <div className="text-sm">选择 Agent 或任务查看详情</div>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="text-xs mt-3 px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]"
              style={{ color: "var(--color-accent)" }}
            >
              收起面板 ▶
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
        <span className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          {selectedAgent ? "Agent 详情" : "任务详情"}
        </span>
        <div className="flex items-center gap-1">
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
              style={{ color: "var(--color-text-muted)" }}
              title="收起面板"
            >
              ▶
            </button>
          )}
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
            title="清除选择"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {selectedAgent && (
          <>
            {/* Agent header */}
            <div className="flex items-center gap-3">
              <span className="text-3xl">{selectedAgent.icon}</span>
              <div>
                <div className="font-semibold" style={{ color: selectedAgent.color }}>{selectedAgent.name}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: STATUS_COLOR[selectedAgent.status] }}
                  />
                  <span className="text-xs" style={{ color: STATUS_COLOR[selectedAgent.status] }}>
                    {STATUS_LABEL[selectedAgent.status]}
                  </span>
                </div>
              </div>
            </div>

            {selectedAgent.description && (
              <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>{selectedAgent.description}</p>
            )}

            {/* Edit / Release / Delete actions */}
            <div className="flex gap-2 flex-wrap">
              {onEditAgent && (
                <button
                  className="text-xs px-3 py-1.5 rounded-lg"
                  style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}
                  onClick={() => onEditAgent(selectedAgent.id)}
                >
                  编辑 Agent
                </button>
              )}
              {onAgentForked && (
                <button
                  className="text-xs px-3 py-1.5 rounded-lg"
                  style={{ background: "#a855f722", color: "#9333ea", opacity: forkBusy ? 0.5 : 1 }}
                  disabled={forkBusy}
                  title="复制一份独立的 Agent，含相同资产与 prompt — 方便基于它改造"
                  onClick={async () => {
                    if (forkBusy) return;
                    setForkBusy(true);
                    try {
                      const forked = await forkGuildAgent(selectedAgent.id);
                      onAgentForked(forked.id);
                    } finally {
                      setForkBusy(false);
                    }
                  }}
                >
                  {forkBusy ? "派生中…" : "🌿 派生"}
                </button>
              )}
              {onReleaseAgent && selectedAgent.status === "working" && (
                <button
                  className="text-xs px-3 py-1.5 rounded-lg"
                  style={{ background: "#f59e0b22", color: "#d97706" }}
                  title="终止当前任务并把 Agent 重置为空闲，自治调度器会重新分配任务"
                  onClick={() => setConfirmRelease(true)}
                >
                  释放
                </button>
              )}
              {onDeleteAgent && (
                <button
                  className="text-xs px-3 py-1.5 rounded-lg"
                  style={{ color: "var(--color-text-muted)" }}
                  onClick={() => setConfirmDelete(true)}
                >
                  删除
                </button>
              )}
            </div>

            <ConfirmDialog
              open={confirmRelease}
              onOpenChange={(o) => { if (!o && !releaseBusy) setConfirmRelease(false); }}
              onConfirm={async () => {
                if (!onReleaseAgent) return;
                setReleaseBusy(true);
                try {
                  await onReleaseAgent(selectedAgent.id);
                  setConfirmRelease(false);
                } finally {
                  setReleaseBusy(false);
                }
              }}
              title={`释放 Agent「${selectedAgent.name}」?`}
              description={"当前任务会被取消，Agent 重置为空闲。\n自治调度器会重新分配新任务。"}
              confirmLabel="释放"
              variant="warning"
              loading={releaseBusy}
            />
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={(o) => { if (!o && !deleteBusy) setConfirmDelete(false); }}
              onConfirm={async () => {
                if (!onDeleteAgent) return;
                setDeleteBusy(true);
                try {
                  await onDeleteAgent(selectedAgent.id);
                  setConfirmDelete(false);
                } finally {
                  setDeleteBusy(false);
                }
              }}
              title={`删除 Agent「${selectedAgent.name}」?`}
              description="删除后无法恢复，该 Agent 的历史任务记录仍会保留。"
              confirmLabel="删除"
              variant="danger"
              loading={deleteBusy}
            />

            {/* Stats */}
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "完成任务", value: selectedAgent.stats.tasksCompleted },
                { label: "成功率", value: `${Math.round(selectedAgent.stats.successRate * 100)}%` },
                { label: "平均置信度", value: `${Math.round(selectedAgent.stats.avgConfidence * 100)}%` },
                { label: "总工时", value: `${Math.round(selectedAgent.stats.totalWorkTimeMs / 60000)}分钟` },
              ].map((s) => (
                <div
                  key={s.label}
                  className="rounded-lg px-3 py-2 text-center"
                  style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                >
                  <div className="text-lg font-semibold" style={{ color: "var(--color-accent)" }}>{s.value}</div>
                  <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Assets */}
            {selectedAgent.assets.length > 0 && (
              <div>
                <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text-muted)" }}>
                  资产（{selectedAgent.assets.length}）
                </div>
                <div className="space-y-1.5">
                  {selectedAgent.assets.map((asset) => (
                    <div
                      key={asset.id}
                      className="px-2.5 py-2 rounded-lg text-xs"
                      style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                    >
                      {editingAssetId === asset.id ? (
                        <div className="space-y-1.5 min-w-0">
                          <div className="flex gap-1.5 min-w-0">
                            <input
                              className="flex-1 min-w-0 px-2 py-1 rounded text-xs"
                              style={{ background: "var(--color-surface-hover)", color: "var(--color-text)", border: "1px solid var(--color-border)" }}
                              placeholder="名称"
                              value={editForm.name}
                              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                            />
                            <input
                              className="flex-1 min-w-0 px-2 py-1 rounded text-xs"
                              style={{ background: "var(--color-surface-hover)", color: "var(--color-text)", border: "1px solid var(--color-border)" }}
                              placeholder="URI"
                              value={editForm.uri}
                              onChange={(e) => setEditForm((f) => ({ ...f, uri: e.target.value }))}
                            />
                          </div>
                          <input
                            className="w-full px-2 py-1 rounded text-xs"
                            style={{ background: "var(--color-surface-hover)", color: "var(--color-text)", border: "1px solid var(--color-border)" }}
                            placeholder="描述"
                            value={editForm.description}
                            onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                          />
                          <input
                            className="w-full px-2 py-1 rounded text-xs"
                            style={{ background: "var(--color-surface-hover)", color: "var(--color-text)", border: "1px solid var(--color-border)" }}
                            placeholder="标签（逗号分隔）"
                            value={editForm.tags}
                            onChange={(e) => setEditForm((f) => ({ ...f, tags: e.target.value }))}
                          />
                          <div className="flex gap-1.5 justify-end">
                            <button
                              className="text-[10px] px-2 py-0.5 rounded"
                              style={{ color: "var(--color-text-muted)" }}
                              onClick={() => setEditingAssetId(null)}
                              disabled={savingAsset}
                            >
                              取消
                            </button>
                            <button
                              className="text-[10px] px-2 py-0.5 rounded"
                              style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}
                              disabled={savingAsset}
                              onClick={async () => {
                                if (!selectedAgent) return;
                                setSavingAsset(true);
                                try {
                                  await updateAgentAsset(selectedAgent.id, asset.id, {
                                    name: editForm.name,
                                    uri: editForm.uri,
                                    description: editForm.description,
                                    tags: editForm.tags.split(",").map((t) => t.trim()).filter(Boolean),
                                  });
                                  setEditingAssetId(null);
                                  onAgentUpdated?.(selectedAgent.id);
                                } finally {
                                  setSavingAsset(false);
                                }
                              }}
                            >
                              {savingAsset ? "保存中…" : "保存"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="text-sm shrink-0">{ASSET_TYPE_ICON[asset.type] ?? "📎"}</span>
                            <span className="font-medium flex-1 truncate" style={{ color: "var(--color-text)" }}>{asset.name}</span>
                            <span
                              className="text-[9px] px-1 py-px rounded font-medium uppercase shrink-0"
                              style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}
                            >
                              {asset.type}
                            </span>
                            <button
                              className="shrink-0 text-[11px] px-1 py-px rounded hover:bg-[var(--color-surface-hover)]"
                              style={{ color: "var(--color-text-muted)" }}
                              title="编辑资产"
                              onClick={() => {
                                setEditingAssetId(asset.id);
                                setEditForm({
                                  name: asset.name,
                                  uri: asset.uri,
                                  description: asset.description ?? "",
                                  tags: (asset.tags ?? []).join(", "),
                                });
                              }}
                            >
                              ✏️
                            </button>
                          </div>
                          {asset.description && (
                            <div className="text-[10px] mt-1 pl-6" style={{ color: "var(--color-text-muted)" }}>
                              {asset.description}
                            </div>
                          )}
                          <div className="flex items-center gap-2 mt-1 pl-6">
                            <span className="font-mono text-[10px] truncate" style={{ color: "var(--color-text-muted)" }}>
                              {asset.uri}
                            </span>
                            {asset.tags && asset.tags.length > 0 && (
                              <div className="flex gap-1 shrink-0">
                                {asset.tags.slice(0, 3).map((t) => (
                                  <span
                                    key={t}
                                    className="text-[9px] px-1 py-px rounded"
                                    style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                                  >
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Skills */}
            {selectedAgent.skills.length > 0 && (
              <div>
                <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text-muted)" }}>技能</div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedAgent.skills.map((s) => (
                    <span
                      key={s}
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 记忆档案 — entry point to view agent memories */}
            <div>
              <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text-muted)" }}>记忆档案</div>
              <button
                onClick={() => setShowMemory(true)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
              >
                <span className="text-lg shrink-0">🧠</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>查看记忆</div>
                  <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                    浏览 Agent 的经验、知识、偏好目录
                  </div>
                </div>
                <span className="text-xs shrink-0" style={{ color: "var(--color-text-muted)" }}>→</span>
              </button>
            </div>

            {/* 工作空间 — browse agent workspace */}
            <div>
              <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text-muted)" }}>工作空间</div>
              <button
                onClick={() => onOpenWorkspace?.(selectedAgent.id)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
              >
                <span className="text-lg shrink-0">{"\uD83D\uDD27"}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>查看工作空间</div>
                  <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                    Agent 执行任务时的工作文件和产出
                  </div>
                </div>
                <span className="text-xs shrink-0" style={{ color: "var(--color-text-muted)" }}>{"\u2192"}</span>
              </button>
            </div>

            {/* 工作产出 — aggregated artifacts from this agent's completed tasks */}
            {tasks && tasks.length > 0 && (() => {
              const agentTasks = tasks.filter(
                (t) => t.assignedAgentId === selectedAgent.id && t.result,
              );
              if (agentTasks.length === 0) return null;
              const allArtifacts = agentTasks.flatMap((t) =>
                (t.result?.handoff?.artifacts ?? []).map((a) => ({ ...a, taskTitle: t.title, taskId: t.id })),
              );
              return (
                <div>
                  <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text-muted)" }}>
                    工作产出（{agentTasks.length} 个任务）
                  </div>
                  {allArtifacts.length > 0 ? (
                    <div className="space-y-1">
                      {allArtifacts.map((a, i) => {
                        const ai = ARTIFACT_ICON[a.kind] ?? ARTIFACT_ICON.note;
                        const isUrl = a.kind === "url" || /^https?:\/\//.test(a.ref);
                        return (
                          <div
                            key={i}
                            className="flex items-start gap-1.5 px-2 py-1.5 rounded text-xs"
                            style={{ background: `${ai.color}08`, border: `1px solid ${ai.color}20` }}
                          >
                            <span className="shrink-0 text-[11px] mt-px">{ai.icon}</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="text-[9px] px-1 py-px rounded font-medium uppercase shrink-0"
                                  style={{ background: `${ai.color}18`, color: ai.color }}
                                >
                                  {a.kind}
                                </span>
                                {isUrl ? (
                                  <a
                                    href={a.ref}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-mono truncate hover:underline"
                                    style={{ color: ai.color }}
                                  >
                                    {a.ref}
                                  </a>
                                ) : (
                                  <span className="font-mono truncate" style={{ color: "var(--color-text)" }}>
                                    {a.ref}
                                  </span>
                                )}
                              </div>
                              {a.description && (
                                <div className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                                  {a.description}
                                </div>
                              )}
                              <div
                                className="text-[10px] mt-0.5 cursor-pointer hover:underline"
                                style={{ color: "var(--color-text-muted)" }}
                                onClick={() => onSelectTask?.(a.taskId)}
                              >
                                来自: {a.taskTitle}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {agentTasks.slice(0, 5).map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-pointer hover:bg-[var(--color-surface-hover)]"
                          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                          onClick={() => onSelectTask?.(t.id)}
                        >
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: t.status === "completed" ? "#10B981" : "#EF4444" }} />
                          <span className="truncate flex-1" style={{ color: "var(--color-text)" }}>{t.title}</span>
                          <span className="text-[10px] shrink-0" style={{ color: "var(--color-text-muted)" }}>
                            {t.result?.summary ? `${t.result.summary.slice(0, 30)}...` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Live output */}
            {selectedAgent.status === "working" && (
              <div>
                <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text-muted)" }}>实时输出</div>
                <AgentOutputStream agentId={selectedAgent.id} output={agentOutputs[selectedAgent.id] ?? ""} />
              </div>
            )}

            {/* Agent Memory Panel modal */}
            {showMemory && (
              <AgentMemoryPanel agent={selectedAgent} onClose={() => setShowMemory(false)} />
            )}
          </>
        )}

        {selectedTask && (
          <>
            {/* Task header */}
            <div>
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>{selectedTask.title}</h3>
                <span
                  className="text-xs px-2 py-0.5 rounded-full shrink-0 font-medium"
                  style={{ background: PRIORITY_COLOR[selectedTask.priority] + "22", color: PRIORITY_COLOR[selectedTask.priority] }}
                >
                  {PRIORITY_LABEL[selectedTask.priority]}
                </span>
              </div>
              <div className="text-xs mt-1 flex items-center gap-2" style={{ color: "var(--color-text-muted)" }}>
                <span>状态：{selectedTask.status}</span>
                {selectedTask.status === "in_progress" && staleTaskIds?.has(selectedTask.id) && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}
                    title="最近 8 秒没有收到任何输出 — Agent 可能正在深度推理（长 reasoning / 大 tool 调用）"
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "currentColor" }} />
                    思考中…
                  </span>
                )}
              </div>
            </div>

            {/* Rejection hint: show when the auto-bidding blacklist would filter
                everyone out. Lets the user reset and retry without digging into
                the API. */}
            {selectedTask.status === "open" && (selectedTask._rejectedBy?.length ?? 0) > 0 && (
              <RejectionHint
                task={selectedTask}
                agents={agents}
              />
            )}

            {selectedTask.description && (
              <p className="text-sm whitespace-pre-wrap" style={{ color: "var(--color-text)" }}>{selectedTask.description}</p>
            )}

            {selectedTask.acceptanceCriteria && (
              <div
                className="rounded-lg px-3 py-2 text-xs"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
              >
                <div className="font-semibold mb-1" style={{ color: "var(--color-text-muted)" }}>验收标准</div>
                <div className="whitespace-pre-wrap" style={{ color: "var(--color-text)" }}>{selectedTask.acceptanceCriteria}</div>
              </div>
            )}

            {selectedTask.declaredOutputs && selectedTask.declaredOutputs.length > 0 && (
              <DeliverablesPanel
                outputs={selectedTask.declaredOutputs}
                title={selectedTask.kind === "pipeline" ? "最终交付产物" : "步骤产出"}
                dense={selectedTask.kind !== "pipeline"}
              />
            )}

            {/* DAG execution graph — only shown when the selected task is the
                pipeline/requirement parent itself. Subtask detail is a zoom-in
                view (description / handoff / log) where the bigger graph would
                be noise; users click the parent to orient if needed. */}
            {(selectedTask.kind === "pipeline" || selectedTask.kind === "requirement") && tasks && tasks.some((t) => t.parentTaskId === selectedTask.id) && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs font-semibold" style={{ color: "var(--color-text-muted)" }}>
                    {selectedTask.kind === "pipeline" ? "流程执行图" : "子任务依赖图"}
                  </div>
                  <button
                    className="text-[10px] px-2 py-0.5 rounded hover:bg-[var(--color-surface-hover)]"
                    style={{ color: "var(--color-accent)" }}
                    onClick={() => setExpandedDAG(true)}
                  >
                    全屏查看
                  </button>
                </div>
                <DAGStatusLegend />
                <div
                  className="rounded-lg"
                  style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                >
                  <Suspense fallback={<div className="text-xs text-center py-4" style={{ color: "var(--color-text-muted)" }}>加载中…</div>}>
                    <SubtaskDAG
                      parentTask={selectedTask}
                      allTasks={tasks}
                      agents={agents}
                      onSelectTask={onSelectTask}
                    />
                  </Suspense>
                </div>
              </div>
            )}

            {(selectedTask.kind === "requirement" || selectedTask.parentTaskId) && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs font-semibold" style={{ color: "var(--color-text-muted)" }}>
                    协作工作区（{selectedTask.kind === "requirement" ? "本需求" : "父需求"}）
                  </div>
                  {workspaceMd && workspaceMd.trim() !== "" && (
                    <button
                      className="text-[10px] px-2 py-0.5 rounded hover:bg-[var(--color-surface-hover)]"
                      style={{ color: "var(--color-accent)" }}
                      onClick={() => setExpandedWorkspace(true)}
                    >
                      全屏查看
                    </button>
                  )}
                </div>
                <div
                  className="rounded-lg px-3 py-2 text-xs overflow-y-auto"
                  style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", maxHeight: 260 }}
                >
                  {workspaceError ? (
                    <div style={{ color: "#ef4444" }}>加载失败：{workspaceError}</div>
                  ) : workspaceMd === null ? (
                    <div style={{ color: "var(--color-text-muted)" }}>加载中…</div>
                  ) : workspaceMd.trim() === "" ? (
                    <div style={{ color: "var(--color-text-muted)" }}>工作区为空</div>
                  ) : (
                    <MarkdownContent>{workspaceMd}</MarkdownContent>
                  )}
                </div>
              </div>
            )}

            {/* Assigned agent */}
            {selectedTask.assignedAgentId && (() => {
              const agent = agents.find((a) => a.id === selectedTask.assignedAgentId);
              if (!agent) return null;
              return (
                <div>
                  <div className="text-xs font-semibold mb-1.5" style={{ color: "var(--color-text-muted)" }}>执行 Agent</div>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
                    <span className="text-lg">{agent.icon}</span>
                    <span className="text-sm font-medium" style={{ color: agent.color }}>{agent.name}</span>
                  </div>
                </div>
              );
            })()}

            {/* Bids */}
            {selectedTask.bids && selectedTask.bids.length > 0 && (() => {
              // Sort: winner first, then other real bidders (higher conf first),
              // then below-threshold candidates last so the "why was X not picked"
              // story reads top-down.
              const winnerId = selectedTask.assignedAgentId;
              const sorted = [...selectedTask.bids].sort((a, b) => {
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
                  投标（{selectedTask.bids.length}
                  {belowCount > 0 && (
                    <span style={{ color: "var(--color-text-muted)" }}>
                      {" · "}{belowCount} 未达门槛
                    </span>
                  )}
                  ）
                </div>
                <div className="space-y-1.5">
                  {sorted.map((bid) => {
                    const agent = agents.find((a) => a.id === bid.agentId);
                    const expanded = expandedBid === bid.agentId;
                    const sb = bid.scoreBreakdown;
                    const isBelow = bid.via === "below_threshold";
                    const isWinner = bid.agentId === winnerId;
                    return (
                      <div
                        key={bid.agentId}
                        className="rounded-lg px-3 py-2 text-xs space-y-1"
                        style={{
                          background: "var(--color-bg)",
                          border: `1px solid ${isWinner ? "var(--color-accent)" : "var(--color-border)"}`,
                          opacity: isBelow ? 0.65 : 1,
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate" style={{ color: agent?.color ?? "var(--color-text)" }}>
                            {agent ? `${agent.icon} ${agent.name}` : bid.agentId}
                          </span>
                          <div className="flex items-center gap-1.5 shrink-0">
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
                              >
                                兜底
                              </span>
                            )}
                            {isBelow && sb && (
                              <span
                                className="text-[9px] px-1 py-0.5 rounded"
                                style={{ background: "#fee2e2", color: "#991b1b" }}
                                title={`该 Agent 的最终得分 ${sb.final.toFixed(3)} 低于竞标门槛 ${sb.threshold.toFixed(3)}`}
                              >
                                未达门槛
                              </span>
                            )}
                            <span style={{ color: isBelow ? "var(--color-text-muted)" : "var(--color-accent)" }}>
                              置信度 {Math.round(bid.confidence * 100)}%
                            </span>
                          </div>
                        </div>
                        <div style={{ color: "var(--color-text-muted)" }}>{bid.reasoning}</div>
                        {sb && (
                          <>
                            <button
                              className="text-[10px] underline"
                              style={{ color: "var(--color-text-muted)" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedBid(expanded ? null : bid.agentId);
                              }}
                            >
                              {expanded ? "收起" : "打分细节"}
                            </button>
                            {expanded && (
                              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                                {sb.llmScore != null ? (
                                  <>
                                    <div>LLM 评分</div><div className="text-right tabular-nums" style={{ color: "#ec4899" }}>{sb.llmScore.toFixed(1)}/10</div>
                                    {sb.llmReason && <div className="col-span-2 text-[9px] italic" style={{ color: "var(--color-text-muted)" }}>{sb.llmReason}</div>}
                                  </>
                                ) : sb.embedding != null ? (
                                  <>
                                    <div>语义匹配</div><div className="text-right tabular-nums" style={{ color: "#8b5cf6" }}>{sb.embedding.toFixed(3)}</div>
                                  </>
                                ) : (
                                  <>
                                    <div>资产匹配</div><div className="text-right tabular-nums">{sb.asset.toFixed(3)}</div>
                                    <div>技能匹配</div><div className="text-right tabular-nums">{sb.skill.toFixed(3)}</div>
                                  </>
                                )}
                                <div>记忆匹配</div><div className="text-right tabular-nums">{sb.memory.toFixed(3)}</div>
                                <div>历史胜率</div><div className="text-right tabular-nums">{sb.success.toFixed(3)}</div>
                                <div>所有者奖励</div><div className="text-right tabular-nums">{sb.ownerBonus.toFixed(3)}</div>
                                {!sb.embedding && <><div>资产奖励</div><div className="text-right tabular-nums">{sb.assetBonus.toFixed(3)}</div></>}
                                <div>负载惩罚</div><div className="text-right tabular-nums">-{sb.loadPenalty.toFixed(3)}</div>
                                <div>门槛</div><div className="text-right tabular-nums">{sb.threshold.toFixed(3)}</div>
                                <div className="font-semibold" style={{ color: "var(--color-text)" }}>最终得分</div>
                                <div className="text-right tabular-nums font-semibold" style={{ color: "var(--color-accent)" }}>{sb.final.toFixed(3)}</div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              );
            })()}

            {/* Result */}
            {selectedTask.result && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs font-semibold" style={{ color: "var(--color-text-muted)" }}>执行结果</div>
                  <button
                    className="text-[10px] px-2 py-0.5 rounded hover:bg-[var(--color-surface-hover)]"
                    style={{ color: "var(--color-accent)" }}
                    onClick={() => setExpandedResult(true)}
                  >
                    全屏查看
                  </button>
                </div>
                <div
                  className="rounded-lg px-3 py-2 text-sm overflow-y-auto"
                  style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", maxHeight: 300 }}
                >
                  <MarkdownContent>{selectedTask.result.summary}</MarkdownContent>
                  {selectedTask.result.agentNotes && (
                    <div className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>{selectedTask.result.agentNotes}</div>
                  )}
                </div>
              </div>
            )}

            {/* Handoff — structured output from a completed subtask */}
            {selectedTask.result?.handoff && (
              <div
                className="rounded-lg px-3 py-2 text-xs space-y-1.5"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
              >
                <div className="font-semibold" style={{ color: "var(--color-text-muted)" }}>交接 Handoff</div>
                <div style={{ color: "var(--color-text)" }}>{selectedTask.result.handoff.summary}</div>
                {selectedTask.result.handoff.artifacts.length > 0 && (
                  <div>
                    <div className="text-[10px] mb-1" style={{ color: "var(--color-text-muted)" }}>产出物</div>
                    <div className="space-y-1">
                      {selectedTask.result.handoff.artifacts.map((a, i) => {
                        const ai = ARTIFACT_ICON[a.kind] ?? ARTIFACT_ICON.note;
                        const isUrl = a.kind === "url" || /^https?:\/\//.test(a.ref);
                        return (
                          <div
                            key={i}
                            className="flex items-start gap-1.5 px-2 py-1 rounded"
                            style={{ background: `${ai.color}08`, border: `1px solid ${ai.color}20` }}
                          >
                            <span className="shrink-0 text-[11px] mt-px">{ai.icon}</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="text-[9px] px-1 py-px rounded font-medium uppercase"
                                  style={{ background: `${ai.color}18`, color: ai.color }}
                                >
                                  {a.kind}
                                </span>
                                {isUrl ? (
                                  <a
                                    href={a.ref}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs font-mono truncate hover:underline"
                                    style={{ color: ai.color }}
                                  >
                                    {a.ref}
                                  </a>
                                ) : (
                                  <span className="text-xs font-mono truncate" style={{ color: "var(--color-text)" }}>
                                    {a.ref}
                                  </span>
                                )}
                              </div>
                              {a.description && (
                                <div className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                                  {a.description}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {selectedTask.result.handoff.openQuestions && selectedTask.result.handoff.openQuestions.length > 0 && (
                  <div>
                    <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>待澄清</div>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {selectedTask.result.handoff.openQuestions.map((q, i) => (
                        <li key={i} style={{ color: "var(--color-text)" }}>{q}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Expanded result modal */}
            {expandedResult && selectedTask.result && (
              <div className="fixed inset-0 z-[70] flex items-center justify-center">
                <div className="absolute inset-0 bg-black/50" onClick={() => setExpandedResult(false)} />
                <div
                  className="relative w-full max-w-3xl rounded-xl shadow-2xl flex flex-col overflow-hidden"
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", maxHeight: "85vh" }}
                >
                  <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
                    <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
                      {selectedTask.title} — 执行结果
                    </h3>
                    <button
                      onClick={() => setExpandedResult(false)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-6">
                    <MarkdownContent>{selectedTask.result.summary}</MarkdownContent>
                  </div>
                </div>
              </div>
            )}

            {/* Expanded workspace modal */}
            {expandedWorkspace && workspaceMd && (
              <div className="fixed inset-0 z-[70] flex items-center justify-center">
                <div className="absolute inset-0 bg-black/50" onClick={() => setExpandedWorkspace(false)} />
                <div
                  className="relative w-full max-w-3xl rounded-xl shadow-2xl flex flex-col overflow-hidden"
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", maxHeight: "85vh" }}
                >
                  <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
                    <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
                      {selectedTask.title} — 协作工作区
                    </h3>
                    <button
                      onClick={() => setExpandedWorkspace(false)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-6">
                    <MarkdownContent>{workspaceMd}</MarkdownContent>
                  </div>
                </div>
              </div>
            )}

            {/* Expanded DAG modal */}
            {expandedDAG && (selectedTask.kind === "pipeline" || selectedTask.kind === "requirement") && tasks && (
              <div className="fixed inset-0 z-[70] flex items-center justify-center">
                <div className="absolute inset-0 bg-black/50" onClick={() => setExpandedDAG(false)} />
                <div
                  className="relative w-full max-w-4xl rounded-xl shadow-2xl flex flex-col overflow-hidden"
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", height: "75vh" }}
                >
                  <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
                    <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
                      {selectedTask.title} — {selectedTask.kind === "pipeline" ? "流程执行图" : "子任务依赖图"}
                    </h3>
                    <button
                      onClick={() => setExpandedDAG(false)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="px-5 pt-3 shrink-0">
                    <DAGStatusLegend />
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <Suspense fallback={<div className="text-xs text-center py-4" style={{ color: "var(--color-text-muted)" }}>加载中…</div>}>
                      <SubtaskDAG
                        parentTask={selectedTask}
                        allTasks={tasks}
                        agents={agents}
                        onSelectTask={(id) => { setExpandedDAG(false); onSelectTask?.(id); }}
                        fullscreen
                      />
                    </Suspense>
                  </div>
                </div>
              </div>
            )}

            {/* View log button */}
            {onViewLog && (selectedTask.status === "completed" || selectedTask.status === "failed" || selectedTask.status === "in_progress") && (
              <button
                className="w-full text-xs px-3 py-2 rounded-lg font-medium flex items-center justify-center gap-1.5"
                style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}
                onClick={() => onViewLog(selectedTask.id)}
              >
                查看日志
              </button>
            )}

            {/* Timestamps */}
            <div className="text-xs space-y-0.5" style={{ color: "var(--color-text-muted)" }}>
              <div>创建：{new Date(selectedTask.createdAt).toLocaleString("zh-CN")}</div>
              {selectedTask.startedAt && <div>开始：{new Date(selectedTask.startedAt).toLocaleString("zh-CN")}</div>}
              {selectedTask.completedAt && <div>完成：{new Date(selectedTask.completedAt).toLocaleString("zh-CN")}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Shown on an `open` task whose auto-bidding blacklist is non-empty. Explains
 *  why the scheduler isn't picking the task up and offers a one-click reset. */
function RejectionHint({ task, agents }: { task: GuildTask; agents: GuildAgent[] }) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rejected = task._rejectedBy ?? [];
  const names = rejected
    .map((id) => agents.find((a) => a.id === id)?.name ?? id.slice(0, 6))
    .join("、");
  const handleClear = async () => {
    setClearing(true);
    setError(null);
    try {
      await clearTaskRejections(task.id, task.groupId);
    } catch (e) {
      setError(String(e));
    } finally {
      setClearing(false);
    }
  };
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs"
      style={{ background: "var(--color-bg)", border: "1px dashed #f59e0b", color: "var(--color-text)" }}
    >
      <div className="font-medium mb-0.5" style={{ color: "#f59e0b" }}>
        ⚠ 自动竞标已暂停
      </div>
      <div style={{ color: "var(--color-text-muted)" }}>
        {rejected.length} 个 Agent 拒绝过此任务（{names}）。需要手动分配，或清空拒绝名单让调度器重新尝试。
      </div>
      {error && <div className="mt-1" style={{ color: "var(--color-error-text)" }}>{error}</div>}
      <button
        className="mt-1.5 text-[11px] px-2 py-0.5 rounded disabled:opacity-60"
        style={{ background: "var(--color-surface)", color: "var(--color-accent)", border: "1px solid var(--color-border)" }}
        disabled={clearing}
        onClick={handleClear}
      >
        {clearing ? "清空中…" : "清空拒绝名单"}
      </button>
    </div>
  );
}

/** Compact color legend above the DAG — keeps the status palette self-describing. */
const DAG_LEGEND_ITEMS: Array<{ color: string; label: string; pulse?: boolean }> = [
  { color: "#9ca3af", label: "待处理" },
  { color: "#f59e0b", label: "竞标中" },
  { color: "#3b82f6", label: "进行中", pulse: true },
  { color: "#10B981", label: "已完成" },
  { color: "#EF4444", label: "失败" },
  { color: "#d97706", label: "阻塞" },
  { color: "#6b7280", label: "取消" },
];

function DAGStatusLegend() {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1.5 px-2 py-1 rounded text-[10px]"
      style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text-muted)" }}
    >
      {DAG_LEGEND_ITEMS.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1">
          <span
            className="w-2 h-2 rounded-full"
            style={{
              background: item.color,
              boxShadow: item.pulse ? `0 0 4px ${item.color}` : "none",
              animation: item.pulse ? "dag-pulse 1.5s ease-in-out infinite" : "none",
            }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
