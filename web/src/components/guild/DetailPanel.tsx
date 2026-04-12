import { useEffect, useState } from "react";
import type { GuildAgent, GuildTask } from "../../types/guild";
import AgentOutputStream from "./AgentOutputStream";
import MarkdownContent from "../MarkdownContent";
import ConfirmDialog from "./ConfirmDialog";
import { getTaskWorkspaceRaw } from "../../api/guild";

interface Props {
  selectedAgent: GuildAgent | null;
  selectedTask: GuildTask | null;
  agents: GuildAgent[];
  agentOutputs: Record<string, string>;
  onClose: () => void;
  onEditAgent?: (id: string) => void;
  onDeleteAgent?: (id: string) => void;
  onReleaseAgent?: (id: string) => void;
  onViewLog?: (taskId: string) => void;
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

export default function DetailPanel({ selectedAgent, selectedTask, agents, agentOutputs, onClose, onEditAgent, onDeleteAgent, onReleaseAgent, onViewLog }: Props) {
  const [expandedResult, setExpandedResult] = useState(false);
  const [expandedWorkspace, setExpandedWorkspace] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [workspaceMd, setWorkspaceMd] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [expandedBid, setExpandedBid] = useState<string | null>(null);

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
      <div className="flex flex-col h-full items-center justify-center" style={{ color: "var(--color-text-muted)" }}>
        <div className="text-2xl mb-2">👆</div>
        <div className="text-sm">选择 Agent 或任务查看详情</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
        <span className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          {selectedAgent ? "Agent 详情" : "任务详情"}
        </span>
        <button
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
          style={{ color: "var(--color-text-muted)" }}
        >
          ✕
        </button>
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
              onOpenChange={setConfirmRelease}
              onConfirm={() => {
                setConfirmRelease(false);
                onReleaseAgent?.(selectedAgent.id);
              }}
              title={`释放 Agent「${selectedAgent.name}」?`}
              description={"当前任务会被取消，Agent 重置为空闲。\n自治调度器会重新分配新任务。"}
              confirmLabel="释放"
              variant="warning"
            />
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              onConfirm={() => {
                setConfirmDelete(false);
                onDeleteAgent?.(selectedAgent.id);
              }}
              title={`删除 Agent「${selectedAgent.name}」?`}
              description="删除后无法恢复，该 Agent 的历史任务记录仍会保留。"
              confirmLabel="删除"
              variant="danger"
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
                <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text-muted)" }}>资产</div>
                <div className="space-y-1.5">
                  {selectedAgent.assets.map((asset) => (
                    <div
                      key={asset.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs"
                      style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                    >
                      <span className="font-medium" style={{ color: "var(--color-accent)" }}>{asset.type}</span>
                      <span className="flex-1 truncate" style={{ color: "var(--color-text)" }}>{asset.name}</span>
                      <span className="truncate max-w-[100px]" style={{ color: "var(--color-text-muted)" }}>{asset.uri}</span>
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

            {/* Live output */}
            {selectedAgent.status === "working" && (
              <div>
                <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text-muted)" }}>实时输出</div>
                <AgentOutputStream agentId={selectedAgent.id} output={agentOutputs[selectedAgent.id] ?? ""} />
              </div>
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
              <div className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
                状态：{selectedTask.status}
              </div>
            </div>

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
            {selectedTask.bids && selectedTask.bids.length > 0 && (
              <div>
                <div className="text-xs font-semibold mb-1.5" style={{ color: "var(--color-text-muted)" }}>投标（{selectedTask.bids.length}）</div>
                <div className="space-y-1.5">
                  {selectedTask.bids.map((bid) => {
                    const agent = agents.find((a) => a.id === bid.agentId);
                    const expanded = expandedBid === bid.agentId;
                    const sb = bid.scoreBreakdown;
                    return (
                      <div
                        key={bid.agentId}
                        className="rounded-lg px-3 py-2 text-xs space-y-1"
                        style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate" style={{ color: agent?.color ?? "var(--color-text)" }}>
                            {agent ? `${agent.icon} ${agent.name}` : bid.agentId}
                          </span>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {bid.via === "fallback" && (
                              <span
                                className="text-[9px] px-1 py-0.5 rounded"
                                style={{ background: "#f59e0b22", color: "#d97706" }}
                                title="未达竞标门槛，通过兜底策略分配"
                              >
                                兜底
                              </span>
                            )}
                            <span style={{ color: "var(--color-accent)" }}>置信度 {Math.round(bid.confidence * 100)}%</span>
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
                                <div>资产匹配</div><div className="text-right tabular-nums">{sb.asset.toFixed(3)}</div>
                                <div>记忆匹配</div><div className="text-right tabular-nums">{sb.memory.toFixed(3)}</div>
                                <div>技能匹配</div><div className="text-right tabular-nums">{sb.skill.toFixed(3)}</div>
                                <div>历史胜率</div><div className="text-right tabular-nums">{sb.success.toFixed(3)}</div>
                                <div>所有者奖励</div><div className="text-right tabular-nums">{sb.ownerBonus.toFixed(3)}</div>
                                <div>资产奖励</div><div className="text-right tabular-nums">{sb.assetBonus.toFixed(3)}</div>
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
            )}

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
                    <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>产出物</div>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {selectedTask.result.handoff.artifacts.map((a, i) => (
                        <li key={i} style={{ color: "var(--color-text)" }}>
                          <span className="font-mono text-[10px] mr-1" style={{ color: "var(--color-accent)" }}>{a.kind}</span>
                          <span>{a.ref}</span>
                          {a.description && <span style={{ color: "var(--color-text-muted)" }}> — {a.description}</span>}
                        </li>
                      ))}
                    </ul>
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
