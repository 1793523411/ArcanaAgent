import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { AgentRole, StreamingStatus, ToolLog, TeamDef, AgentDef } from "../types";
import MarkdownContent from "./MarkdownContent";
import ToolCallBlock from "./ToolCallBlock";
import { getArtifactUrl } from "../api";
import { formatTokenCount } from "../utils/format";
import { getRoleConfig } from "../constants/roles";

interface PendingApproval {
  requestId: string;
  subagentId: string;
  operationType: string;
  operationDescription: string;
  details: Record<string, unknown>;
}

interface Props {
  content: string;
  reasoning?: string;
  status: StreamingStatus;
  toolLogs?: ToolLog[];
  subagents?: Array<{
    subagentId: string;
    subagentName?: string;
    role?: AgentRole;
    dependsOn?: string[];
    depth: number;
    prompt: string;
    phase: "started" | "completed" | "failed";
    status: StreamingStatus;
    content: string;
    reasoning: string;
    toolLogs: ToolLog[];
    plan: {
      phase: "created" | "running" | "completed";
      steps: Array<{
        title: string;
        acceptance_checks: string[];
        evidences: string[];
        completed: boolean;
      }>;
      currentStep: number;
      toolName?: string;
    } | null;
    summary?: string;
    error?: string;
  }>;
  plan?: {
    phase: "created" | "running" | "completed";
    steps: Array<{
      title: string;
      acceptance_checks: string[];
      evidences: string[];
      completed: boolean;
    }>;
    currentStep: number;
    toolName?: string;
  };
  pendingApprovals?: PendingApproval[];
  onApproval?: (requestId: string, approved: boolean) => void;
  processingApprovals?: Set<string>;
  conversationId?: string;
  isStreaming?: boolean;
  supportsReasoning?: boolean;
  modelName?: string;
  usageTokens?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  team?: TeamDef | null;
  agents?: AgentDef[];
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export default function StreamingBubble({
  content,
  reasoning,
  status,
  toolLogs = [],
  subagents = [],
  plan,
  pendingApprovals = [],
  onApproval,
  processingApprovals: externalProcessing,
  conversationId,
  isStreaming = false,
  supportsReasoning = false,
  modelName,
  usageTokens,
  team = null,
  agents = [],
}: Props) {
  const [reasoningCollapsed, setReasoningCollapsed] = useState(false);
  const [planCollapsed, setPlanCollapsed] = useState(false);
  const [subagentsCollapsed, setSubagentsCollapsed] = useState(false);
  const [subagentCollapsedMap, setSubagentCollapsedMap] = useState<Record<string, boolean>>({});
  const [subSectionCollapsedMap, setSubSectionCollapsedMap] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  // Use shared processingApprovals from parent if available, otherwise local fallback
  const [localProcessing, setLocalProcessing] = useState<Set<string>>(new Set());
  const processingApprovals = externalProcessing ?? localProcessing;
  const reasoningRef = useRef<HTMLDivElement>(null);

  const handleApproval = useCallback(async (requestId: string, approved: boolean) => {
    if (onApproval) {
      onApproval(requestId, approved);
      return;
    }
    // Fallback: local handling (should not happen when parent passes onApproval)
    if (!conversationId) return;
    setLocalProcessing((prev) => new Set(prev).add(requestId));
    try {
      const { submitApproval } = await import("../api");
      await submitApproval(conversationId, requestId, approved);
    } catch {
      // handled by stream event
    } finally {
      setLocalProcessing((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  }, [onApproval, conversationId]);
  const userScrolledRef = useRef(false);

  useEffect(() => {
    if (!isStreaming && reasoning) setReasoningCollapsed(true);
    else if (isStreaming) {
      setReasoningCollapsed(false);
      userScrolledRef.current = false;
    }
  }, [isStreaming, reasoning]);

  useEffect(() => {
    const el = reasoningRef.current;
    if (!el || !isStreaming || reasoningCollapsed || userScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [reasoning, isStreaming, reasoningCollapsed]);

  const handleReasoningScroll = () => {
    const el = reasoningRef.current;
    if (!el || !isStreaming) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledRef.current = distanceFromBottom > 30;
  };

  const hasReasoning = typeof reasoning === "string" && reasoning.trim().length > 0;
  const hasToolLogs = toolLogs.length > 0;
  const hasSubagents = subagents.length > 0;
  const runningSubagents = subagents.filter((s) => s.phase === "started").length;
  const hasPlan = Array.isArray(plan?.steps) && plan.steps.length > 0;
  const planPhaseLabel = plan?.phase === "completed" ? "已完成" : plan?.phase === "running" ? "执行中" : "初始化中";
  useEffect(() => {
    if (isStreaming && hasPlan) setPlanCollapsed(false);
  }, [isStreaming, hasPlan, plan?.steps.length]);
  useEffect(() => {
    if (!isStreaming) return;
    setSubagentsCollapsed(false);
  }, [isStreaming, subagents.length]);
  // Compute a stable key: "id1:phase1,id2:phase2,..."
  const subagentsPhaseKey = subagents.map((s) => `${s.subagentId}:${s.phase}`).join(",");
  useEffect(() => {
    if (subagents.length === 0) return;
    const finished = subagents.filter((s) => s.phase === "completed" || s.phase === "failed");
    if (finished.length > 0) {
      setSubagentCollapsedMap((prev) => {
        const next = { ...prev };
        for (const s of finished) next[s.subagentId] = true;
        return next;
      });
      setSubSectionCollapsedMap((prev) => {
        const next = { ...prev };
        for (const s of finished) {
          next[`${s.subagentId}:reasoning`] = true;
          next[`${s.subagentId}:plan`] = true;
          next[`${s.subagentId}:tools`] = true;
          next[`${s.subagentId}:content`] = true;
        }
        return next;
      });
    }
    if (finished.length === subagents.length) {
      setSubagentsCollapsed(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subagentsPhaseKey]);
  const showThinkingSection = hasReasoning || (isStreaming && supportsReasoning);
  const copyableText = content.trim() || "";

  const toggleSubagent = (subagentId: string) => {
    setSubagentCollapsedMap((prev) => ({ ...prev, [subagentId]: !prev[subagentId] }));
  };

  const toggleSubSection = (subagentId: string, section: "reasoning" | "plan" | "tools" | "content") => {
    const key = `${subagentId}:${section}`;
    setSubSectionCollapsedMap((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleCopy = async () => {
    if (!copyableText) return;
    try {
      await navigator.clipboard.writeText(copyableText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  // 转换图片 URL：将本地路径转换为 artifact URL
  const transformImageUrl = (src: string) => {
    // 如果是绝对 URL 或 data URI，直接返回
    if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) {
      return src;
    }
    // 如果没有 conversationId，无法转换，返回原路径
    if (!conversationId) {
      return src;
    }
    // 处理相对路径，转换为 artifact URL
    const cleaned = src.startsWith("./") ? src.slice(2) : src;
    return getArtifactUrl(conversationId, cleaned);
  };

  // 获取team成员信息
  const teamMemberDisplay = useMemo(() => {
    if (!team || team.agents.length === 0)
      return [];
    return team.agents
      .map((agentId) => agents.find((a) => a.id === agentId))
      .filter(Boolean) as AgentDef[];
  }, [team, agents]);

  const [showTeamMembers, setShowTeamMembers] = useState(false);
  const teamMemberRef = useRef<HTMLDivElement>(null);

  return (
    <div className="self-start max-w-[85%] py-3 px-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-xs text-[var(--color-text-muted)] shrink-0">Agent</span>
          {team && (<div className="relative">
            <button
              type="button"
              onClick={() => setShowTeamMembers(!showTeamMembers)}
              onMouseEnter={() => setShowTeamMembers(true)}
              onMouseLeave={() => setShowTeamMembers(false)}
              className="text-[11px] px-2 py-0.5 rounded-md bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] border border-[var(--color-border)] cursor-default shrink-0 hover:text-[var(--color-text)] transition-colors flex items-center gap-1"
              title={team.name}
            >
              <span>👥</span>
              <span className="truncate max-w-[100px]">{team.name}</span>
            </button>
            {showTeamMembers && (<div
              ref={teamMemberRef}
              className="absolute left-0 top-full mt-1 z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg p-3 min-w-[200px] shadow-xl"
              style={{ minWidth: "200px" }}
            >
              <div className="text-xs font-medium mb-2" style={{ color: "var(--color-text-muted)" }}>
                团队成员
              </div>
              <div className="space-y-1">
                {teamMemberDisplay.map((agent) => (<div key={agent.id} className="flex items-center gap-2 text-xs">
                  <span style={{ color: agent.color }}>{agent.icon}</span>
                  <span style={{ color: "var(--color-text)" }}>{agent.name}</span>
                </div>))}
              </div>
            </div>)}
          </div>)}
          {modelName && (
            <span
              className="text-[11px] px-2 py-0.5 rounded-md bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] border border-[var(--color-border)] truncate max-w-[140px] cursor-default shrink-0"
              data-tooltip={modelName}
            >
              {modelName}
            </span>
          )}
          {usageTokens && usageTokens.totalTokens > 0 && (
            <span
              className="text-[10px] text-[var(--color-text-muted)] whitespace-nowrap px-1.5 py-0.5 rounded-md bg-[var(--color-surface-hover)] border border-[var(--color-border)] shrink-0"
              title="含系统提示词 + 对话上下文 + 本轮回复；多轮模型调用会累加"
            >
              入 {formatTokenCount(usageTokens.promptTokens)} / 出 {formatTokenCount(usageTokens.completionTokens)}
            </span>
          )}
        </div>
        {copyableText && (
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)] transition-colors"
            title={copied ? "已复制" : "复制"}
          >
            {copied ? (
              <span className="text-[10px] text-[var(--color-accent)]">已复制</span>
            ) : (
              <CopyIcon />
            )}
          </button>
        )}
      </div>
      {showThinkingSection && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setReasoningCollapsed((c) => !c)}
            className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <span className="select-none">{reasoningCollapsed ? "▶" : "▼"}</span>
            <span>思考过程</span>
          </button>
          {!reasoningCollapsed && (
            <div
              ref={reasoningRef}
              onScroll={handleReasoningScroll}
              className="mt-1.5 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text)] whitespace-pre-wrap break-words max-h-[280px] overflow-auto"
            >
              {hasReasoning ? <MarkdownContent transformImageUrl={transformImageUrl} disableMermaid>{reasoning}</MarkdownContent> : <span className="text-[var(--color-text-muted)]">（思考中…）</span>}
            </div>
          )}
        </div>
      )}
      {hasPlan && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setPlanCollapsed((c) => !c)}
            className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <span className="select-none">{planCollapsed ? "▶" : "▼"}</span>
            <span>执行计划</span>
            <span className="text-[11px] text-[var(--color-text-muted)]">{planPhaseLabel}</span>
            <span>
              {Math.min(plan!.currentStep, plan!.steps.length)}/{plan!.steps.length}
            </span>
          </button>
          {!planCollapsed && (
            <div className="mt-1.5 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
              <div className="text-xs text-[var(--color-text-muted)] mb-1.5 flex items-center justify-between">
                <span>阶段：{planPhaseLabel}</span>
                <span>{Math.min(plan?.currentStep ?? 0, plan?.steps.length ?? 0)}/{plan?.steps.length ?? 0}</span>
              </div>
              <div className="space-y-1.5">
                {plan!.steps.map((step, idx) => {
                  const normalized = typeof step === "string"
                    ? { title: step, acceptance_checks: [`验证：${step}`], evidences: [], completed: idx < plan!.currentStep }
                    : step;
                  const done = normalized.completed;
                  const active = idx === plan!.currentStep && plan!.phase === "running";
                  return (
                    <div
                      key={`${idx}-${normalized.title}`}
                      className={`text-sm px-2 py-1.5 rounded border ${
                        done
                          ? "border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]"
                          : active
                            ? "border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 text-[var(--color-text)]"
                            : "border-[var(--color-border)] text-[var(--color-text-muted)]"
                      }`}
                    >
                      <div>{done ? "✓" : active ? "→" : "○"} {normalized.title}</div>
                      <div className="mt-1 text-[11px] opacity-80">
                        验收：{normalized.acceptance_checks.join("；")}
                      </div>
                      {done && normalized.evidences.length > 0 && (
                        <div className="mt-1 text-[11px] opacity-80">依据：{normalized.evidences[normalized.evidences.length - 1]}</div>
                      )}
                    </div>
                  );
                })}
              </div>
              {plan?.toolName && plan.phase === "running" && (
                <div className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                  当前工具：{plan.toolName}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {hasToolLogs && <ToolCallBlock logs={toolLogs} />}
      {hasSubagents && (
        <div className="mb-3 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
          <button
            type="button"
            onClick={() => setSubagentsCollapsed((c) => !c)}
            className="w-full text-left text-xs text-[var(--color-text-muted)] mb-1.5 flex items-center justify-between hover:text-[var(--color-text)] transition-colors"
          >
            <span>{subagentsCollapsed ? "▶" : "▼"} 子Agent执行</span>
            <span>运行中 {runningSubagents} / 总计 {subagents.length}</span>
          </button>
          {!subagentsCollapsed && <div className="space-y-2">
            {subagents.map((s) => {
              const subCollapsed = !!subagentCollapsedMap[s.subagentId];
              const hasSubReasoning = !!s.reasoning.trim();
              const hasSubPlan = !!(s.plan?.steps?.length);
              const hasSubTools = s.toolLogs.length > 0;
              const hasSubContent = !!s.content.trim();
              const reasoningCollapsed = !!subSectionCollapsedMap[`${s.subagentId}:reasoning`];
              const subPlanCollapsed = !!subSectionCollapsedMap[`${s.subagentId}:plan`];
              const subToolsCollapsed = !!subSectionCollapsedMap[`${s.subagentId}:tools`];
              const subContentCollapsed = !!subSectionCollapsedMap[`${s.subagentId}:content`];
              const subPlanPhaseLabel = s.plan?.phase === "completed" ? "已完成" : s.plan?.phase === "running" ? "执行中" : "初始化中";
              const promptTrimmed = (s.prompt ?? "").replace(/\s+/g, " ").trim();
              const subagentDisplayName = s.subagentName ?? (promptTrimmed ? promptTrimmed.slice(0, 40) + (promptTrimmed.length > 40 ? "…" : "") : s.subagentId);
              const roleConfig = getRoleConfig(s.role);
              const borderColor = roleConfig?.color ?? "var(--color-border)";
              return (
                <div key={s.subagentId} className="text-sm px-2 py-2 rounded text-[var(--color-text)]" style={{ borderLeft: `3px solid ${borderColor}`, border: `1px solid var(--color-border)`, borderLeftWidth: "3px", borderLeftColor: borderColor }}>
                  <button type="button" onClick={() => toggleSubagent(s.subagentId)} className="w-full text-left flex items-start gap-2 flex-wrap">
                    <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{subCollapsed ? "▶" : "▼"}</span>
                    {roleConfig ? (
                      <span className="shrink-0 text-[13px] flex items-center gap-1" style={{ color: roleConfig.color }}>
                        <span>{roleConfig.icon}</span>
                        <span className="font-medium text-[11px]">{roleConfig.displayName}</span>
                      </span>
                    ) : (
                      <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{s.phase === "completed" ? "✓" : s.phase === "failed" ? "✕" : "●"}</span>
                    )}
                    <span className="text-[11px] text-[var(--color-text-muted)] min-w-0 flex-1 break-words" title={s.subagentId}>{subagentDisplayName}</span>
                    <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded-full" style={roleConfig ? {
                      backgroundColor: s.phase === "completed" ? "#10B98120" : s.phase === "failed" ? "#EF444420" : `${roleConfig.color}20`,
                      color: s.phase === "completed" ? "#10B981" : s.phase === "failed" ? "#EF4444" : roleConfig.color,
                    } : {}}>
                      {s.phase === "completed" ? "✓ 已完成" : s.phase === "failed" ? "✕ 失败" : "● 执行中"}
                    </span>
                  </button>
                  {s.prompt && (
                    <div className="mt-1 text-[11px] text-[var(--color-text-muted)] break-words">
                      任务：{s.prompt}
                    </div>
                  )}
                  {/* Context from dependsOn agents */}
                  {s.dependsOn && s.dependsOn.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {s.dependsOn.map((depId) => {
                        const depAgent = subagents.find((a) => a.subagentId === depId);
                        const depName = depAgent?.subagentName ?? depId.slice(0, 8);
                        const depRole = getRoleConfig(depAgent?.role);
                        return (
                          <span
                            key={depId}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[var(--color-surface-hover)] border border-[var(--color-border)] text-[var(--color-text-muted)]"
                            title={`依赖: ${depId}`}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                            </svg>
                            {depRole && <span style={{ color: depRole.color }}>{depRole.icon}</span>}
                            <span>Context from: {depName}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {!subCollapsed && hasSubReasoning && (
                    <div className="mt-2">
                      <button type="button" onClick={() => toggleSubSection(s.subagentId, "reasoning")} className="text-[11px] text-[var(--color-text-muted)] mb-1">
                        {reasoningCollapsed ? "▶" : "▼"} 思考过程
                      </button>
                      {!reasoningCollapsed && (
                        <div className="p-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[12px]">
                          <MarkdownContent transformImageUrl={transformImageUrl} disableMermaid>{s.reasoning}</MarkdownContent>
                        </div>
                      )}
                    </div>
                  )}
                  {!subCollapsed && hasSubPlan && (
                    <div className="mt-2 p-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                      <button type="button" onClick={() => toggleSubSection(s.subagentId, "plan")} className="w-full text-left text-[11px] text-[var(--color-text-muted)] mb-1 flex items-center justify-between">
                        <span>{subPlanCollapsed ? "▶" : "▼"} 执行计划 {subPlanPhaseLabel}</span>
                        <span>{Math.min(s.plan?.currentStep ?? 0, s.plan?.steps.length ?? 0)}/{s.plan?.steps.length ?? 0}</span>
                      </button>
                      {!subPlanCollapsed && (
                        <div className="space-y-1">
                          {s.plan?.steps.map((step, idx) => (
                            <div key={`${s.subagentId}-${idx}-${step.title}`} className="text-[12px] px-2 py-1 rounded border border-[var(--color-border)]">
                              <div>{step.completed ? "✓" : idx === (s.plan?.currentStep ?? -1) ? "→" : "○"} {step.title}</div>
                              <div className="opacity-80">验收：{step.acceptance_checks.join("；")}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {!subCollapsed && hasSubTools && (
                    <div className="mt-2">
                      <button type="button" onClick={() => toggleSubSection(s.subagentId, "tools")} className="text-[11px] text-[var(--color-text-muted)] mb-1">
                        {subToolsCollapsed ? "▶" : "▼"} 工具调用
                      </button>
                      {!subToolsCollapsed && <ToolCallBlock logs={s.toolLogs} />}
                    </div>
                  )}
                  {!subCollapsed && hasSubContent && (
                    <div className="mt-2">
                      <button type="button" onClick={() => toggleSubSection(s.subagentId, "content")} className="text-[11px] text-[var(--color-text-muted)] mb-1">
                        {subContentCollapsed ? "▶" : "▼"} 回复正文
                      </button>
                      {!subContentCollapsed && (
                        <div className="p-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[12px]">
                          <MarkdownContent transformImageUrl={transformImageUrl} disableMermaid>{s.content}</MarkdownContent>
                        </div>
                      )}
                    </div>
                  )}
                  {s.phase === "failed" && s.error && (
                    <div className="mt-2 text-[11px] text-[var(--color-error-text)] break-words">
                      错误：{s.error}
                    </div>
                  )}
                  {/* Inline approval cards for this sub-agent */}
                  {pendingApprovals.filter((a) => a.subagentId === s.subagentId).map((approval) => {
                    const isProcessing = processingApprovals.has(approval.requestId);
                    return (
                      <div
                        key={approval.requestId}
                        className="mt-2 rounded-lg border-2 border-[#F59E0B]/50 bg-[#F59E0B]/5 p-2 space-y-1.5"
                      >
                        <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#F59E0B]">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                          Awaiting Approval
                        </div>
                        <div className="text-[11px] text-[var(--color-text)]">
                          <span className="font-medium">{approval.operationType}</span>
                          <span className="text-[var(--color-text-muted)]"> — {approval.operationDescription}</span>
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={isProcessing}
                            onClick={() => handleApproval(approval.requestId, true)}
                            className="flex-1 px-2 py-1 rounded text-[11px] font-medium bg-[#10B981] text-white hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {isProcessing ? "..." : "Approve"}
                          </button>
                          <button
                            type="button"
                            disabled={isProcessing}
                            onClick={() => handleApproval(approval.requestId, false)}
                            className="flex-1 px-2 py-1 rounded text-[11px] font-medium bg-[#EF4444] text-white hover:bg-[#DC2626] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {isProcessing ? "..." : "Reject"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>}
        </div>
      )}
      {content ? (
        <MarkdownContent transformImageUrl={transformImageUrl} disableMermaid>{content}</MarkdownContent>
      ) : (
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <span className="loading-dots" />
          {status === "tool" ? "正在执行工具…" : "正在思考…"}
        </div>
      )}
    </div>
  );
}
