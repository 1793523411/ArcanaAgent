import { useState } from "react";
import type { AgentRole, SubagentLog } from "../types";
import { ROLE_CONFIG, getRoleConfig } from "../constants/roles";

interface SubagentInfo {
  subagentId: string;
  subagentName?: string;
  role?: AgentRole;
  dependsOn?: string[];
  phase: "started" | "completed" | "failed";
}

interface PendingApproval {
  requestId: string;
  subagentId: string;
  operationType: string;
  operationDescription: string;
  details: Record<string, unknown>;
}

interface Props {
  /** Currently streaming sub-agents */
  streamingSubagents: SubagentInfo[];
  /** Historical sub-agents from the last AI message */
  historicalSubagents: SubagentLog[];
  /** Pending approval requests */
  pendingApprovals: PendingApproval[];
  /** Shared approval handler from parent */
  onApproval?: (requestId: string, approved: boolean) => void;
  /** Shared processing state from parent */
  processingApprovals?: Set<string>;
  /** Current conversation ID */
  conversationId: string;
  onClose: () => void;
}

export default function TeamPanel({ streamingSubagents, historicalSubagents, pendingApprovals, onApproval, processingApprovals: externalProcessing, conversationId, onClose }: Props) {
  // Use shared processingApprovals from parent if available, otherwise local fallback
  const [localProcessing, setLocalProcessing] = useState<Set<string>>(new Set());
  const processingApprovals = externalProcessing ?? localProcessing;

  // Merge streaming and historical into a unified view; streaming takes priority
  const streamingIds = new Set(streamingSubagents.map((s) => s.subagentId));
  const allAgents: SubagentInfo[] = [
    ...streamingSubagents,
    ...historicalSubagents.filter((s) => !streamingIds.has(s.subagentId)),
  ];

  // Group by role
  const roleGroups = new Map<AgentRole | "unknown", SubagentInfo[]>();
  for (const agent of allAgents) {
    const key = agent.role ?? "unknown";
    const list = roleGroups.get(key) ?? [];
    list.push(agent);
    roleGroups.set(key, list);
  }

  const completedCount = allAgents.filter((a) => a.phase === "completed").length;
  const totalCount = allAgents.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const roles: (AgentRole | "unknown")[] = ["planner", "coder", "reviewer", "tester", "unknown"];

  const handleApproval = async (requestId: string, approved: boolean) => {
    if (onApproval) {
      onApproval(requestId, approved);
      return;
    }
    // Fallback: local handling
    setLocalProcessing((prev) => new Set(prev).add(requestId));
    try {
      const { submitApproval } = await import("../api");
      await submitApproval(conversationId, requestId, approved);
    } catch {
      // The approval will be removed from pendingApprovals via the stream event
    } finally {
      setLocalProcessing((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--color-surface)] border-l border-[var(--color-border)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">Team Panel</h3>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Progress Overview */}
        {totalCount > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
              <span>Progress</span>
              <span>{completedCount}/{totalCount} completed</span>
            </div>
            <div className="h-2 rounded-full bg-[var(--color-bg)] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${progressPercent}%`,
                  backgroundColor: progressPercent === 100 ? "#10B981" : "var(--color-accent)",
                }}
              />
            </div>
          </div>
        )}

        {/* Pipeline Visualization */}
        {totalCount > 0 && (() => {
          // Build adjacency: nodes + edges from dependsOn
          const hasDeps = allAgents.some((a) => {
            const full = [...streamingSubagents, ...historicalSubagents];
            const match = full.find((f) => f.subagentId === a.subagentId);
            return match && "dependsOn" in match && Array.isArray((match as { dependsOn?: string[] }).dependsOn) && ((match as { dependsOn?: string[] }).dependsOn!).length > 0;
          });
          if (!hasDeps && totalCount <= 1) return null;

          // Merge full info for dependsOn
          type FullAgent = SubagentInfo & { dependsOn?: string[] };
          const fullAgents: FullAgent[] = allAgents.map((a) => {
            const streaming = streamingSubagents.find((s) => s.subagentId === a.subagentId);
            const historical = historicalSubagents.find((s) => s.subagentId === a.subagentId);
            const deps = streaming?.dependsOn ?? (historical as { dependsOn?: string[] })?.dependsOn;
            return { ...a, dependsOn: deps };
          });

          // Topological layers: agents with no deps first
          const placed = new Set<string>();
          const layers: FullAgent[][] = [];
          const remainingSet = new Set(fullAgents.map((a) => a.subagentId));
          const agentMap = new Map(fullAgents.map((a) => [a.subagentId, a]));

          while (remainingSet.size > 0) {
            const layer: FullAgent[] = [];
            for (const id of remainingSet) {
              const a = agentMap.get(id)!;
              const deps = a.dependsOn ?? [];
              if (deps.length === 0 || deps.every((d) => placed.has(d))) {
                layer.push(a);
              }
            }
            if (layer.length === 0) {
              // Circular or missing deps — dump rest into last layer
              layers.push(Array.from(remainingSet).map((id) => agentMap.get(id)!));
              break;
            }
            layers.push(layer);
            for (const a of layer) {
              placed.add(a.subagentId);
              remainingSet.delete(a.subagentId);
            }
          }

          return (
            <div className="space-y-1.5">
              <h4 className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Pipeline</h4>
              <div className="space-y-0">
                {layers.map((layer, layerIdx) => (
                  <div key={layerIdx}>
                    {/* Connection line from previous layer */}
                    {layerIdx > 0 && (
                      <div className="flex justify-center py-0.5">
                        <div className="w-px h-4 bg-[var(--color-border)]" />
                      </div>
                    )}
                    {/* Layer nodes */}
                    <div className="flex flex-wrap gap-1.5 justify-center">
                      {layer.map((agent) => {
                        const rc = getRoleConfig(agent.role);
                        const phaseColor =
                          agent.phase === "completed" ? "#10B981"
                          : agent.phase === "failed" ? "#EF4444"
                          : rc?.color ?? "var(--color-accent)";
                        const displayName = agent.subagentName ?? agent.subagentId.slice(0, 8);
                        return (
                          <div
                            key={agent.subagentId}
                            className="flex items-center gap-1 px-2 py-1 rounded-md border text-[10px]"
                            style={{
                              borderColor: phaseColor,
                              backgroundColor: `${phaseColor}10`,
                            }}
                            title={`${displayName}\n${agent.dependsOn?.length ? `Depends on: ${agent.dependsOn.join(", ")}` : "No dependencies"}`}
                          >
                            <span style={{ color: rc?.color }}>{rc?.icon ?? "\u{1F916}"}</span>
                            <span
                              className="max-w-[80px] truncate font-medium"
                              style={{ color: phaseColor }}
                            >
                              {displayName}
                            </span>
                            <span
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{
                                backgroundColor: phaseColor,
                                boxShadow: agent.phase === "started" ? `0 0 4px ${phaseColor}` : "none",
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Team Roster */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Roster</h4>
          {totalCount === 0 && (
            <p className="text-xs text-[var(--color-text-muted)] italic py-2">No agents active yet</p>
          )}
          {roles.map((roleKey) => {
            const agents = roleGroups.get(roleKey);
            if (!agents?.length) return null;
            const config = roleKey !== "unknown" ? ROLE_CONFIG[roleKey] : null;
            return (
              <div key={roleKey} className="space-y-1">
                {agents.map((agent) => {
                  const rc = getRoleConfig(agent.role);
                  const phaseColor =
                    agent.phase === "completed" ? "#10B981"
                    : agent.phase === "failed" ? "#EF4444"
                    : rc?.color ?? "var(--color-accent)";
                  const phaseLabel =
                    agent.phase === "completed" ? "completed"
                    : agent.phase === "failed" ? "failed"
                    : "working";
                  const displayName = agent.subagentName ?? agent.subagentId;
                  return (
                    <div
                      key={agent.subagentId}
                      className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
                    >
                      {/* Role icon */}
                      <span className="text-sm shrink-0" style={{ color: config?.color }}>
                        {config?.icon ?? "\u{1F916}"}
                      </span>
                      {/* Name + role */}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-[var(--color-text)] truncate">{displayName}</div>
                        {config && (
                          <div className="text-[10px] font-medium" style={{ color: config.color }}>
                            {config.displayName}
                          </div>
                        )}
                      </div>
                      {/* Status dot */}
                      <span className="shrink-0 flex items-center gap-1">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{
                            backgroundColor: phaseColor,
                            boxShadow: agent.phase === "started" ? `0 0 6px ${phaseColor}` : "none",
                          }}
                        />
                        <span className="text-[10px] text-[var(--color-text-muted)]">{phaseLabel}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Pending Approvals */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
            Approvals
            {pendingApprovals.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[#F59E0B] text-white text-[10px] font-bold">
                {pendingApprovals.length}
              </span>
            )}
          </h4>
          {pendingApprovals.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] italic py-2">No pending approvals</p>
          ) : (
            <div className="space-y-2">
              {pendingApprovals.map((approval) => {
                const isProcessing = processingApprovals.has(approval.requestId);
                const agentInfo = allAgents.find((a) => a.subagentId === approval.subagentId);
                const rc = getRoleConfig(agentInfo?.role);
                return (
                  <div
                    key={approval.requestId}
                    className="rounded-lg border border-[#F59E0B]/40 bg-[#F59E0B]/5 p-2.5 space-y-2"
                  >
                    {/* Operation header */}
                    <div className="flex items-start gap-2">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#F59E0B"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0 mt-0.5"
                      >
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-[var(--color-text)]">
                          {approval.operationType}
                        </div>
                        <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 break-all">
                          {approval.operationDescription}
                        </div>
                      </div>
                    </div>

                    {/* Agent info */}
                    {agentInfo && (
                      <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                        <span style={{ color: rc?.color }}>{rc?.icon ?? "\u{1F916}"}</span>
                        <span>{agentInfo.subagentName ?? agentInfo.subagentId}</span>
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={() => handleApproval(approval.requestId, true)}
                        className="flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors bg-[#10B981] text-white hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isProcessing ? "..." : "Approve"}
                      </button>
                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={() => handleApproval(approval.requestId, false)}
                        className="flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors bg-[#EF4444] text-white hover:bg-[#DC2626] disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isProcessing ? "..." : "Reject"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
