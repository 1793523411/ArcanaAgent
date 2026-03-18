import { useState, useRef, useLayoutEffect, useEffect, useCallback, useMemo } from "react";
import type { SubagentLog, ApprovalLog } from "../types";
import { getRoleConfig } from "../constants/roles";

interface SubagentInfo {
  subagentId: string;
  subagentName?: string;
  role?: string;
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
  /** Historical sub-agents grouped by round (each round = one user turn) */
  historicalRounds: Array<{ label: string; subagents: SubagentLog[] }>;
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

/* ── Pipeline DAG types ── */
type FullAgent = SubagentInfo & { dependsOn?: string[] };
interface DagEdge { fromId: string; toId: string }
interface NodeRect { x: number; y: number; w: number; h: number }

function getPhaseColor(agent: SubagentInfo): string {
  if (agent.phase === "completed") return "#10B981";
  if (agent.phase === "failed") return "#EF4444";
  return getRoleConfig(agent.role)?.color ?? "var(--color-accent)";
}

/* ── PipelineDag component ── */
function PipelineDag({ layers, edges, agentMap }: {
  layers: FullAgent[][];
  edges: DagEdge[];
  agentMap: Map<string, FullAgent>;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [rects, setRects] = useState<Map<string, NodeRect>>(new Map());
  const [wrapperH, setWrapperH] = useState(0);

  const measure = useCallback(() => {
    const w = wrapperRef.current;
    if (!w) return;
    const wRect = w.getBoundingClientRect();
    const next = new Map<string, NodeRect>();
    for (const [id, el] of nodeRefs.current) {
      const r = el.getBoundingClientRect();
      next.set(id, {
        x: r.left - wRect.left,
        y: r.top - wRect.top,
        w: r.width,
        h: r.height,
      });
    }
    setRects(next);
    setWrapperH(w.scrollHeight);
  }, []);

  // Measure after every render that changes layers
  useLayoutEffect(() => {
    measure();
  }, [layers, measure]);

  // Re-measure on resize
  useEffect(() => {
    const w = wrapperRef.current;
    if (!w) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(w);
    return () => ro.disconnect();
  }, [measure]);

  // Build SVG paths
  const paths = useMemo(() => {
    if (rects.size === 0) return [];
    return edges.map((e) => {
      const from = rects.get(e.fromId);
      const to = rects.get(e.toId);
      if (!from || !to) return null;
      const px = from.x + from.w / 2;
      const py = from.y + from.h;
      const cx = to.x + to.w / 2;
      const cy = to.y;
      const midY = (py + cy) / 2;
      const d = `M ${px} ${py} C ${px} ${midY}, ${cx} ${midY}, ${cx} ${cy}`;
      // Color: both completed → green, otherwise border color
      const fromAgent = agentMap.get(e.fromId);
      const toAgent = agentMap.get(e.toId);
      const bothDone = fromAgent?.phase === "completed" && toAgent?.phase === "completed";
      return { key: `${e.fromId}-${e.toId}`, d, done: bothDone };
    }).filter(Boolean) as { key: string; d: string; done: boolean }[];
  }, [rects, edges, agentMap]);

  const LAYER_GAP = 28;

  return (
    <div ref={wrapperRef} className="relative">
      {/* SVG edge overlay */}
      <svg
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: wrapperH || "100%",
          pointerEvents: "none",
          overflow: "visible",
        }}
      >
        <defs>
          <marker
            id="dag-arrow"
            viewBox="0 0 6 6"
            refX="6"
            refY="3"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 6 3 L 0 6 Z" fill="var(--color-border)" />
          </marker>
          <marker
            id="dag-arrow-done"
            viewBox="0 0 6 6"
            refX="6"
            refY="3"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 6 3 L 0 6 Z" fill="#10B981" opacity="0.5" />
          </marker>
        </defs>
        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke={p.done ? "#10B981" : "var(--color-border)"}
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity={p.done ? 0.45 : 0.6}
            markerEnd={p.done ? "url(#dag-arrow-done)" : "url(#dag-arrow)"}
            style={{ transition: "opacity 0.3s, stroke 0.3s" }}
          />
        ))}
      </svg>

      {/* Layer rows */}
      {layers.map((layer, layerIdx) => (
        <div
          key={layerIdx}
          className="flex flex-wrap gap-2 justify-center"
          style={{
            marginTop: layerIdx > 0 ? LAYER_GAP : 0,
            position: "relative",
            zIndex: 1,
          }}
        >
          {layer.map((agent) => {
            const rc = getRoleConfig(agent.role);
            const phaseColor = getPhaseColor(agent);
            const displayName = agent.subagentName ?? agent.subagentId.slice(0, 8);
            return (
              <div
                key={agent.subagentId}
                ref={(el) => {
                  if (el) nodeRefs.current.set(agent.subagentId, el);
                  else nodeRefs.current.delete(agent.subagentId);
                }}
                className="flex items-center gap-1.5 pl-0 pr-2 py-1 rounded-md text-[10px]"
                style={{
                  minWidth: 72,
                  maxWidth: 120,
                  border: "1px solid var(--color-border)",
                  borderLeft: `3px solid ${phaseColor}`,
                  backgroundColor: `${phaseColor}0F`,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                  opacity: 1,
                  transform: "translateY(0)",
                  transition: "opacity 0.3s ease-out, transform 0.3s ease-out, background-color 0.3s",
                  transitionDelay: `${layerIdx * 80}ms`,
                }}
                title={`${displayName}\n${agent.dependsOn?.length ? `Depends on: ${agent.dependsOn.join(", ")}` : "No dependencies"}`}
              >
                <span className="pl-1.5 shrink-0" style={{ color: rc?.color }}>{rc?.icon ?? "\u{1F916}"}</span>
                <span
                  className="truncate font-medium leading-tight"
                  style={{ color: phaseColor, maxWidth: 72 }}
                >
                  {displayName}
                </span>
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0 ml-auto"
                  style={{
                    backgroundColor: phaseColor,
                    boxShadow: agent.phase === "started" ? `0 0 5px ${phaseColor}` : "none",
                    animation: agent.phase === "started" ? "dag-pulse 1.5s ease-in-out infinite" : "none",
                  }}
                />
              </div>
            );
          })}
        </div>
      ))}

      {/* Pulse animation for active nodes */}
      <style>{`
        @keyframes dag-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 4px currentColor; }
          50% { opacity: 0.5; box-shadow: 0 0 8px currentColor; }
        }
      `}</style>
    </div>
  );
}

/* ── Main TeamPanel ── */
export default function TeamPanel({ streamingSubagents, historicalRounds, pendingApprovals, onApproval, processingApprovals: externalProcessing, conversationId, onClose }: Props) {
  const [localProcessing, setLocalProcessing] = useState<Set<string>>(new Set());
  const processingApprovals = externalProcessing ?? localProcessing;
  const [collapsedRounds, setCollapsedRounds] = useState<Set<number>>(new Set());

  const historicalSubagents = useMemo(() => historicalRounds.flatMap((r) => r.subagents), [historicalRounds]);

  // Merge streaming and historical into a unified view; streaming takes priority
  const streamingIds = new Set(streamingSubagents.map((s) => s.subagentId));
  const allAgents: SubagentInfo[] = [
    ...streamingSubagents,
    ...historicalSubagents.filter((s) => !streamingIds.has(s.subagentId)),
  ];

  // Group by role
  const roleGroups = new Map<string, SubagentInfo[]>();
  for (const agent of allAgents) {
    const key = agent.role ?? "unknown";
    const list = roleGroups.get(key) ?? [];
    list.push(agent);
    roleGroups.set(key, list);
  }

  const completedCount = allAgents.filter((a) => a.phase === "completed").length;
  const totalCount = allAgents.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // Extract historical approval records from stored subagent logs
  const historicalApprovals = useMemo(() => {
    const records: (ApprovalLog & { subagentId: string; subagentName?: string; role?: string })[] = [];
    const pendingIds = new Set(pendingApprovals.map((p) => p.requestId));
    for (const s of historicalSubagents) {
      if (!s.approvalLogs?.length) continue;
      for (const a of s.approvalLogs) {
        // skip any that are still pending (already shown in pending section)
        if (pendingIds.has(a.requestId)) continue;
        records.push({ ...a, subagentId: s.subagentId, subagentName: s.subagentName, role: s.role });
      }
    }
    return records;
  }, [historicalSubagents, pendingApprovals]);

  // Compute pipeline data
  const pipelineData = useMemo(() => {
    if (totalCount === 0) return null;

    const hasDeps = allAgents.some((a) => {
      const full = [...streamingSubagents, ...historicalSubagents];
      const match = full.find((f) => f.subagentId === a.subagentId);
      return match && "dependsOn" in match && Array.isArray((match as { dependsOn?: string[] }).dependsOn) && ((match as { dependsOn?: string[] }).dependsOn!).length > 0;
    });
    if (!hasDeps && totalCount <= 1) return null;

    // Merge full info for dependsOn
    const fullAgents: FullAgent[] = allAgents.map((a) => {
      const streaming = streamingSubagents.find((s) => s.subagentId === a.subagentId);
      const historical = historicalSubagents.find((s) => s.subagentId === a.subagentId);
      const deps = streaming?.dependsOn ?? (historical as { dependsOn?: string[] })?.dependsOn;
      return { ...a, dependsOn: deps };
    });

    // Topological layers
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
        layers.push(Array.from(remainingSet).map((id) => agentMap.get(id)!));
        break;
      }
      layers.push(layer);
      for (const a of layer) {
        placed.add(a.subagentId);
        remainingSet.delete(a.subagentId);
      }
    }

    // Build edges
    const edges: DagEdge[] = [];
    for (const agent of fullAgents) {
      for (const depId of agent.dependsOn ?? []) {
        if (agentMap.has(depId)) {
          edges.push({ fromId: depId, toId: agent.subagentId });
        }
      }
    }

    return { layers, edges, agentMap };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCount, streamingSubagents, historicalSubagents]);

  const handleApproval = async (requestId: string, approved: boolean) => {
    if (onApproval) {
      onApproval(requestId, approved);
      return;
    }
    setLocalProcessing((prev) => new Set(prev).add(requestId));
    try {
      const { submitApproval } = await import("../api");
      await submitApproval(conversationId, requestId, approved);
    } catch {
      // removed via stream event
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

        {/* Pipeline DAG */}
        {pipelineData && (
          <div className="space-y-1.5">
            <h4 className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Pipeline</h4>
            <PipelineDag
              layers={pipelineData.layers}
              edges={pipelineData.edges}
              agentMap={pipelineData.agentMap}
            />
          </div>
        )}

        {/* Team Roster — grouped by round */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Roster</h4>
          {totalCount === 0 && (
            <p className="text-xs text-[var(--color-text-muted)] italic py-2">No agents active yet</p>
          )}
          {historicalRounds.map((round, roundIdx) => {
            if (!round.subagents.length) return null;
            const collapsed = collapsedRounds.has(roundIdx);
            const roundCompleted = round.subagents.every((a) => a.phase === "completed");
            const roundFailed = round.subagents.some((a) => a.phase === "failed");
            return (
              <div key={roundIdx} className="space-y-1">
                <button
                  type="button"
                  onClick={() => setCollapsedRounds((prev) => {
                    const next = new Set(prev);
                    collapsed ? next.delete(roundIdx) : next.add(roundIdx);
                    return next;
                  })}
                  className="flex items-center gap-1.5 w-full text-left text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors py-0.5"
                >
                  <span className="select-none">{collapsed ? "▶" : "▼"}</span>
                  <span className="font-medium truncate">{round.label}</span>
                  <span className="text-[10px] shrink-0">({round.subagents.length} agents)</span>
                  <span
                    className="w-2 h-2 rounded-full ml-auto shrink-0"
                    style={{
                      backgroundColor: roundFailed ? "#EF4444" : roundCompleted ? "#10B981" : "var(--color-accent)",
                      boxShadow: !roundCompleted && !roundFailed ? `0 0 6px var(--color-accent)` : "none",
                    }}
                  />
                </button>
                {!collapsed && round.subagents.map((agent) => {
                  const rc = getRoleConfig(agent.role);
                  const phaseColor = getPhaseColor(agent);
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
                      <span className="text-sm shrink-0" style={{ color: rc?.color }}>
                        {rc?.icon ?? "\u{1F916}"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-[var(--color-text)] truncate">{displayName}</div>
                        {rc && (
                          <div className="text-[10px] font-medium" style={{ color: rc.color }}>
                            {rc.displayName}
                          </div>
                        )}
                      </div>
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
          {/* Streaming agents (current round, not yet in history) */}
          {streamingSubagents.filter((s) => !historicalSubagents.some((h) => h.subagentId === s.subagentId)).length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] text-[var(--color-text-muted)] font-medium py-0.5 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse" />
                <span>Current</span>
              </div>
              {streamingSubagents.filter((s) => !historicalSubagents.some((h) => h.subagentId === s.subagentId)).map((agent) => {
                const rc = getRoleConfig(agent.role);
                const phaseColor = getPhaseColor(agent);
                const displayName = agent.subagentName ?? agent.subagentId;
                return (
                  <div
                    key={agent.subagentId}
                    className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
                  >
                    <span className="text-sm shrink-0" style={{ color: rc?.color }}>
                      {rc?.icon ?? "\u{1F916}"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-[var(--color-text)] truncate">{displayName}</div>
                      {rc && (
                        <div className="text-[10px] font-medium" style={{ color: rc.color }}>
                          {rc.displayName}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 flex items-center gap-1">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{
                          backgroundColor: phaseColor,
                          boxShadow: agent.phase === "started" ? `0 0 6px ${phaseColor}` : "none",
                        }}
                      />
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        {agent.phase === "completed" ? "completed" : agent.phase === "failed" ? "failed" : "working"}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Approvals */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
            Approvals
            {pendingApprovals.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[#F59E0B] text-white text-[10px] font-bold">
                {pendingApprovals.length}
              </span>
            )}
          </h4>
          {pendingApprovals.length === 0 && historicalApprovals.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] italic py-2">No approvals</p>
          ) : (
            <div className="space-y-2">
              {/* Pending approvals – with action buttons */}
              {pendingApprovals.map((approval) => {
                const isProcessing = processingApprovals.has(approval.requestId);
                const agentInfo = allAgents.find((a) => a.subagentId === approval.subagentId);
                const rc = getRoleConfig(agentInfo?.role);
                return (
                  <div
                    key={approval.requestId}
                    className="rounded-lg border border-[#F59E0B]/40 bg-[#F59E0B]/5 p-2.5 space-y-2"
                  >
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
                    {agentInfo && (
                      <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                        <span style={{ color: rc?.color }}>{rc?.icon ?? "\u{1F916}"}</span>
                        <span>{agentInfo.subagentName ?? agentInfo.subagentId}</span>
                      </div>
                    )}
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
              {/* Historical approvals – read-only with result badge */}
              {historicalApprovals.map((record) => {
                const rc = getRoleConfig(record.role);
                const isApproved = record.approved;
                return (
                  <div
                    key={record.requestId}
                    className={`rounded-lg border p-2.5 space-y-1 ${
                      isApproved
                        ? "border-[#10B981]/30 bg-[#10B981]/5"
                        : "border-[#EF4444]/30 bg-[#EF4444]/5"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={`shrink-0 mt-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded ${
                          isApproved
                            ? "bg-[#10B981]/15 text-[#10B981]"
                            : "bg-[#EF4444]/15 text-[#EF4444]"
                        }`}
                      >
                        {isApproved ? "Approved" : "Rejected"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-[var(--color-text)]">
                          {record.operationType}
                        </div>
                        <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 break-all">
                          {record.operationDescription}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                      <span style={{ color: rc?.color }}>{rc?.icon ?? "\u{1F916}"}</span>
                      <span>{record.subagentName ?? record.subagentId}</span>
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
