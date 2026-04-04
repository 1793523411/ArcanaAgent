import { useState, useMemo, useRef } from "react";
import type { StoredMessage, TeamDef, AgentDef } from "../types";
import MarkdownContent from "./MarkdownContent";
import AttachmentStrip from "./AttachmentStrip";
import ToolCallBlock from "./ToolCallBlock";
import { getArtifactUrl } from "../api";
import { formatTokenCount } from "../utils/format";
import { getRoleConfig } from "../constants/roles";

interface Props {
  message: StoredMessage;
  conversationId?: string;
  models?: Array<{ id: string; name: string }>;
  team?: TeamDef | null;
  agents?: AgentDef[];
  onShare?: () => void;
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

export default function MessageBubble({ message, conversationId, models = [], team = null, agents = [], onShare }: Props) {
  const isHuman = message.type === "human";
  const attachments = message.attachments ?? [];
  const reasoning = message.type === "ai" ? message.reasoningContent : undefined;
  const hasReasoning = typeof reasoning === "string" && reasoning.trim().length > 0;
  const [reasoningCollapsed, setReasoningCollapsed] = useState(true);
  const [planCollapsed, setPlanCollapsed] = useState(true);
  const [subagentsCollapsed, setSubagentsCollapsed] = useState(true);
  // F5: Default all historical subagents to collapsed
  const [subagentCollapsedMap, setSubagentCollapsedMap] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const s of (message.subagents ?? [])) map[s.subagentId] = true;
    return map;
  });
  // F7: Default all sub-sections to collapsed for historical messages
  const [subSectionCollapsedMap, setSubSectionCollapsedMap] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const s of (message.subagents ?? [])) {
      map[`${s.subagentId}:reasoning`] = true;
      map[`${s.subagentId}:plan`] = true;
      map[`${s.subagentId}:tools`] = true;
      map[`${s.subagentId}:content`] = true;
    }
    return map;
  });
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
  const [copied, setCopied] = useState(false);
  const toolLogs = message.toolLogs ?? [];
  const subagents = message.subagents ?? [];
  const plan = message.type === "ai" ? message.plan : undefined;
  const hasPlan = Array.isArray(plan?.steps) && plan.steps.length > 0;
  const harness = message.type === "ai" ? message.harness : undefined;
  const hasHarness = Array.isArray(harness?.events) && harness.events.length > 0;
  const lastDriverPhase = harness?.driverEvents?.length
    ? harness.driverEvents[harness.driverEvents.length - 1].phase
    : undefined;
  const driverRoundCount =
    harness?.driverEvents?.length && harness.driverEvents.length > 0
      ? Math.max(...harness.driverEvents.map((e) => e.iteration)) + 1
      : 0;
  const [harnessCollapsed, setHarnessCollapsed] = useState(true);
  const [iterationsCollapsed, setIterationsCollapsed] = useState(true);
  const hasSubagents = message.type === "ai" && subagents.length > 0;
  const runningSubagents = subagents.filter((s) => s.phase === "started").length;
  const planPhaseLabel = plan?.phase === "completed" ? "已完成" : plan?.phase === "running" ? "执行中" : "初始化中";
  const hasContent = typeof message.content === "string" && message.content.trim().length > 0;
  const isToolDispatchOnly = message.type === "ai" && !hasContent && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const text = hasContent
    ? message.content
    : (message.type === "ai" && toolLogs.length === 0 && !isToolDispatchOnly ? "(该条回复内容未保存)" : "");

  const copyableText = text || (message.content && String(message.content).trim()) || "";
  const modelName = message.type === "ai" && message.modelId
    ? (models.find((m) => m.id === message.modelId)?.name ?? message.modelId)
    : null;

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

  const toggleSubagent = (subagentId: string) => {
    setSubagentCollapsedMap((prev) => ({ ...prev, [subagentId]: !prev[subagentId] }));
  };

  const toggleSubSection = (subagentId: string, section: "reasoning" | "plan" | "tools" | "content") => {
    const key = `${subagentId}:${section}`;
    setSubSectionCollapsedMap((prev) => ({ ...prev, [key]: !prev[key] }));
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

  return (
    <div
      className={`flex flex-col max-w-[85%] ${isHuman ? "items-end self-end" : "items-start self-start"}`}
    >
      {attachments.length > 0 && (
        <AttachmentStrip
          attachments={attachments}
          align={isHuman ? "end" : "start"}
          conversationId={conversationId}
        />
      )}
      <div
        className={`
          w-full py-3 px-4 rounded-xl border border-[var(--color-border)]
          ${isHuman ? "bg-[var(--color-user-bubble)] text-[var(--color-user-bubble-text)]" : "bg-[var(--color-surface)]"}
        `}
      >
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="text-xs text-[var(--color-text-muted)] shrink-0">
              {isHuman ? "你" : "Agent"}
            </span>
            {!isHuman && team && (<div className="relative">
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
                className="text-[11px] rounded-md bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] border border-[var(--color-border)] cursor-default shrink-0"
                data-tooltip={modelName}
              >
                <span className="block px-2 py-0.5 truncate max-w-[140px]">{modelName}</span>
              </span>
            )}
            {!isHuman && message.usageTokens && message.usageTokens.totalTokens > 0 && (
              <span
                className="text-[10px] text-[var(--color-text-muted)] whitespace-nowrap px-1.5 py-0.5 rounded-md bg-[var(--color-surface-hover)] border border-[var(--color-border)] shrink-0"
                title="含系统提示词 + 对话上下文 + 本轮回复；多轮模型调用会累加"
              >
                入 {formatTokenCount(message.usageTokens.promptTokens)} / 出 {formatTokenCount(message.usageTokens.completionTokens)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {!isHuman && onShare && copyableText && (
              <button
                type="button"
                onClick={() => onShare!()}
                className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)] transition-colors"
                title="分享"
              >
                <ShareIcon />
              </button>
            )}
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
        </div>
        {hasReasoning && (
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
              <div className="mt-1.5 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text)] whitespace-pre-wrap break-words max-h-[280px] overflow-auto">
                <MarkdownContent transformImageUrl={transformImageUrl}>{reasoning}</MarkdownContent>
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
            </button>
            {!planCollapsed && (
              <div className="mt-1.5 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                <div className="text-xs text-[var(--color-text-muted)] mb-1.5 flex items-center justify-between">
                  <span>阶段：{planPhaseLabel}</span>
                  <span>{Math.min(plan?.currentStep ?? 0, plan?.steps.length ?? 0)}/{plan?.steps.length ?? 0}</span>
                </div>
                <div className="space-y-1.5">
                  {plan?.steps.map((step, idx) => {
                    const normalized = typeof step === "string"
                      ? { title: step, acceptance_checks: [`验证：${step}`], evidences: [], completed: idx < (plan.currentStep ?? 0) }
                      : step;
                    const done = normalized.completed;
                    const active = idx === (plan.currentStep ?? 0) && plan.phase === "running";
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
                    最近工具：{plan.toolName}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {hasHarness && (
          <div className="mb-3">
            <button
              type="button"
              onClick={() => setHarnessCollapsed((c) => !c)}
              className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              <span className="select-none">{harnessCollapsed ? "▶" : "▼"}</span>
              <span>执行监控事件</span>
              <span className="text-[10px] opacity-70">({harness!.events.length})</span>
            </button>
            {!harnessCollapsed && (
              <div className="mt-1.5 space-y-1.5">
                {harness!.driverEvents && harness!.driverEvents.length > 0 && (
                  <div className="text-[11px] px-2 py-1 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                    Driver:{" "}
                    {lastDriverPhase === "completed"
                      ? "已完成"
                      : lastDriverPhase === "max_retries_reached"
                        ? "已达最大重试"
                        : "已终止"}
                    {" "}(共 {driverRoundCount} 轮)
                  </div>
                )}
                {harness!.events.map((evt, idx) => {
                  if (evt.kind === "eval") {
                    const v = evt.data.verdict;
                    const borderCls = v === "pass"
                      ? "border-[var(--color-success-border)]"
                      : v === "weak" || v === "inconclusive"
                        ? "border-yellow-500/60"
                        : "border-[var(--color-error-text)]/60";
                    const icon = v === "pass" ? "✅" : v === "weak" ? "⚠️" : v === "inconclusive" ? "ℹ️" : "❌";
                    return (
                      <div key={`h-${idx}`} className={`text-[12px] px-2 py-1.5 rounded border ${borderCls} bg-[var(--color-bg)]`}>
                        <div>{icon} 步骤 {evt.data.stepIndex + 1} 评估: <span className="font-medium">{v}</span></div>
                        <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">{evt.data.reason}</div>
                      </div>
                    );
                  }
                  if (evt.kind === "loop_detection" && evt.data.detected) {
                    return (
                      <div key={`h-${idx}`} className="text-[12px] px-2 py-1.5 rounded border border-yellow-500/60 bg-[var(--color-bg)]">
                        <div>🔄 循环检测: {evt.data.type === "exact_cycle" ? "精确循环" : "语义停滞"}</div>
                        {evt.data.description && <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">{evt.data.description}</div>}
                      </div>
                    );
                  }
                  if (evt.kind === "replan" && evt.data.shouldReplan) {
                    return (
                      <div key={`h-${idx}`} className="text-[12px] px-2 py-1.5 rounded border border-blue-500/60 bg-[var(--color-bg)]">
                        <div>🔀 {evt.data.pendingApproval ? "重规划建议" : "已重规划"} (触发: {evt.data.trigger === "eval_fail" ? "评估失败" : "循环检测"})</div>
                        {evt.data.pendingApproval && <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">仅作为参考建议，未自动应用</div>}
                        {evt.data.revisedSteps && (
                          <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                            新步骤: {evt.data.revisedSteps.map(s => s.title).join(" → ")}
                          </div>
                        )}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </div>
        )}
        {toolLogs.length > 0 && <ToolCallBlock logs={toolLogs} defaultCollapsed />}
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
                const hasSubReasoning = !!s.reasoning?.trim();
                const hasSubPlan = !!(s.plan?.steps?.length);
                const hasSubTools = (s.toolLogs?.length ?? 0) > 0;
                const hasSubContent = !!s.content?.trim();
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
                    {/* F6: Context from dependsOn agents */}
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
                            <MarkdownContent transformImageUrl={transformImageUrl}>{s.reasoning}</MarkdownContent>
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
                        {!subToolsCollapsed && <ToolCallBlock logs={s.toolLogs ?? []} defaultCollapsed />}
                      </div>
                    )}
                    {!subCollapsed && hasSubContent && (
                      <div className="mt-2">
                        <button type="button" onClick={() => toggleSubSection(s.subagentId, "content")} className="text-[11px] text-[var(--color-text-muted)] mb-1">
                          {subContentCollapsed ? "▶" : "▼"} 回复正文
                        </button>
                        {!subContentCollapsed && (
                          <div className="p-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[12px]">
                            <MarkdownContent transformImageUrl={transformImageUrl}>{s.content}</MarkdownContent>
                          </div>
                        )}
                      </div>
                    )}
                    {s.phase === "failed" && s.error && (
                      <div className="mt-2 text-[11px] text-[var(--color-error-text)] break-words">错误：{s.error}</div>
                    )}
                  </div>
                );
              })}
            </div>}
          </div>
        )}
        {isHuman ? (
          text ? <div className="whitespace-pre-wrap break-words">{text}</div> : null
        ) : (
          <>
            {message.previousIterations && message.previousIterations.length > 0 && (
              <div className="mb-3 rounded-lg border border-[var(--color-border)] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setIterationsCollapsed((v) => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] transition-colors"
                >
                  <span className="transition-transform" style={{ transform: iterationsCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>▼</span>
                  {message.previousIterations.length} 轮中间结果（非最终输出）
                </button>
                {!iterationsCollapsed && (
                  <div className="border-t border-[var(--color-border)]">
                    {message.previousIterations.map((iter, idx) => (
                      <div key={idx} className="px-4 py-3 border-b border-[var(--color-border)] last:border-b-0">
                        <div className="text-[11px] text-[var(--color-text-muted)] mb-2 font-medium">第 {idx + 1} 轮</div>
                        <div className="text-sm opacity-70">
                          <MarkdownContent transformImageUrl={transformImageUrl}>{iter}</MarkdownContent>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {text ? <MarkdownContent transformImageUrl={transformImageUrl}>{text}</MarkdownContent> : null}
          </>
        )}
      </div>
    </div>
  );
}
