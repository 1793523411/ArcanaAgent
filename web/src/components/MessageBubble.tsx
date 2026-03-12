import { useState } from "react";
import type { StoredMessage } from "../types";
import MarkdownContent from "./MarkdownContent";
import AttachmentStrip from "./AttachmentStrip";
import ToolCallBlock from "./ToolCallBlock";
import { getArtifactUrl } from "../api";
import { formatTokenCount } from "../utils/format";

interface Props {
  message: StoredMessage;
  conversationId?: string;
  models?: Array<{ id: string; name: string }>;
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export default function MessageBubble({ message, conversationId, models = [] }: Props) {
  const isHuman = message.type === "human";
  const attachments = message.attachments ?? [];
  const reasoning = message.type === "ai" ? message.reasoningContent : undefined;
  const hasReasoning = typeof reasoning === "string" && reasoning.trim().length > 0;
  const [reasoningCollapsed, setReasoningCollapsed] = useState(true);
  const [planCollapsed, setPlanCollapsed] = useState(true);
  const [subagentsCollapsed, setSubagentsCollapsed] = useState(true);
  const [subagentCollapsedMap, setSubagentCollapsedMap] = useState<Record<string, boolean>>({});
  const [subSectionCollapsedMap, setSubSectionCollapsedMap] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const toolLogs = message.toolLogs ?? [];
  const subagents = message.subagents ?? [];
  const plan = message.type === "ai" ? message.plan : undefined;
  const hasPlan = Array.isArray(plan?.steps) && plan.steps.length > 0;
  const hasSubagents = message.type === "ai" && subagents.length > 0;
  const runningSubagents = subagents.filter((s) => s.phase === "started").length;
  const planPhaseLabel = plan?.phase === "completed" ? "已完成" : plan?.phase === "running" ? "执行中" : "初始化中";
  const hasContent = typeof message.content === "string" && message.content.trim().length > 0;
  const text = hasContent
    ? message.content
    : (message.type === "ai" && toolLogs.length === 0 ? "(该条回复内容未保存)" : "");

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
                <MarkdownContent>{reasoning}</MarkdownContent>
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
        {toolLogs.length > 0 && <ToolCallBlock logs={toolLogs} defaultCollapsed />}
        {hasSubagents && (
          <div className="mb-3 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
            <button
              type="button"
              onClick={() => setSubagentsCollapsed((c) => !c)}
              className="w-full text-left text-xs text-[var(--color-text-muted)] mb-1.5 flex items-center justify-between hover:text-[var(--color-text)] transition-colors"
            >
              <span>{subagentsCollapsed ? "▶" : "▼"} 子代理执行</span>
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
                return (
                  <div key={s.subagentId} className="text-sm px-2 py-2 rounded border border-[var(--color-border)] text-[var(--color-text)]">
                    <button type="button" onClick={() => toggleSubagent(s.subagentId)} className="w-full text-left flex items-center gap-2">
                      <span>{subCollapsed ? "▶" : "▼"}</span>
                      <span>{s.phase === "completed" ? "✓" : s.phase === "failed" ? "✕" : "●"}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">{s.subagentId}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">深度 {s.depth}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">
                        {s.phase === "completed" ? "已完成" : s.phase === "failed" ? "失败" : "执行中"}
                      </span>
                    </button>
                    {s.prompt && (
                      <div className="mt-1 text-[11px] text-[var(--color-text-muted)] break-words">
                        任务：{s.prompt}
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
          text ? <MarkdownContent transformImageUrl={transformImageUrl}>{text}</MarkdownContent> : null
        )}
      </div>
    </div>
  );
}
