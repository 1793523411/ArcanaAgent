import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentRole, ConversationMode, StoredMessage, StreamingStatus } from "../types";
import MessageBubble from "./MessageBubble";
import StreamingBubble from "./StreamingBubble";
import ChatInputBar, { type FileWithData } from "./ChatInputBar";

interface Props {
  messages: StoredMessage[];
  conversationId?: string;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  loading: boolean;
  streamingContent: string;
  streamingReasoning: string;
  streamingStatus: StreamingStatus;
  streamingToolLogs: Array<{ name: string; input: string; output: string }>;
  streamingSubagents: Array<{
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
    toolLogs: Array<{ name: string; input: string; output: string }>;
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
  streamingPlan?: {
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
  pendingApprovals?: Array<{
    requestId: string;
    subagentId: string;
    operationType: string;
    operationDescription: string;
    details: Record<string, unknown>;
  }>;
  onApproval?: (requestId: string, approved: boolean) => void;
  processingApprovals?: Set<string>;
  error: string | null;
  files: FileWithData[];
  onFilesChange: (files: FileWithData[]) => void;
  models: Array<{ id: string; name: string; provider?: string; supportsReasoning?: boolean }>;
  modelId: string | undefined;
  onModelChange: (modelId: string) => void;
  mode: ConversationMode;
  onModeChange: (mode: ConversationMode) => void;
  modeLocked?: boolean;
  artifactCount?: number;
  onToggleArtifacts?: () => void;
  artifactsPanelOpen?: boolean;
  showTeamPanel?: boolean;
  onToggleTeamPanel?: () => void;
  isTaskExecuting?: boolean;
  usageTokens?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  contextUsage?: {
    strategy: "full" | "trim" | "compress";
    contextWindow: number;
    thresholdTokens: number;
    tokenThresholdPercent: number;
    contextMessageCount: number;
    estimatedTokens?: number;
    promptTokens?: number;
    trimToLast?: number;
    olderCount?: number;
    recentCount?: number;
  } | null;
  onCompress?: () => void;
  compressing?: boolean;
}

export default function ChatPanel({
  messages,
  conversationId,
  input,
  onInputChange,
  onSend,
  loading,
  streamingContent,
  streamingReasoning,
  streamingStatus,
  streamingToolLogs,
  streamingSubagents,
  streamingPlan,
  pendingApprovals = [],
  onApproval,
  processingApprovals,
  error,
  files,
  onFilesChange,
  models,
  modelId,
  onModelChange,
  mode,
  onModeChange,
  modeLocked = true,
  artifactCount = 0,
  onToggleArtifacts,
  artifactsPanelOpen,
  showTeamPanel,
  onToggleTeamPanel,
  isTaskExecuting = false,
  usageTokens = null,
  contextUsage = null,
  onCompress,
  compressing = false,
}: Props) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const STICK_THRESHOLD_PX = 120;
  const selectedModel = (models.find((m) => m.id === modelId) ?? models[0]) as
    | { id: string; name: string; supportsReasoning?: boolean; contextWindow?: number }
    | undefined;

  // 获取配置中的策略（从 URL /api/config 读取）
  const [configStrategy, setConfigStrategy] = useState<"full" | "trim" | "compress" | undefined>();

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(config => {
        setConfigStrategy(config.context?.strategy);
      })
      .catch(() => {});
  }, []);

  const latestAiWithContext = [...(messages ?? [])]
    .reverse()
    .find((m) => m.type === "ai" && m.contextUsage);
  const latestMessageContextUsage = latestAiWithContext?.contextUsage ?? null;
  const effectiveContextUsage = contextUsage ?? latestMessageContextUsage ?? null;
  const fallbackContextWindow = selectedModel?.contextWindow ?? 200000; // 默认 200k tokens
  const effectiveContextWindow = effectiveContextUsage?.contextWindow ?? fallbackContextWindow;
  const effectiveThresholdTokens = effectiveContextUsage?.thresholdTokens;
  const effectiveThresholdPercent = effectiveContextUsage?.tokenThresholdPercent ?? 75;
  // 优先使用配置中的策略，而不是历史消息中的策略
  const effectiveStrategy = configStrategy ?? effectiveContextUsage?.strategy ?? "compress";
  const effectiveSessionTokens = effectiveContextUsage?.promptTokens ?? effectiveContextUsage?.estimatedTokens ?? null;
  const displayContextUsage = effectiveContextWindow > 0
    ? {
        strategy: effectiveStrategy,
        percentByWindow: effectiveSessionTokens != null
          ? Math.min(100, Math.max(0, (effectiveSessionTokens / effectiveContextWindow) * 100))
          : undefined,
        percentByThreshold: effectiveSessionTokens != null && typeof effectiveThresholdTokens === "number" && effectiveThresholdTokens > 0
          ? Math.min(100, Math.max(0, (effectiveSessionTokens / effectiveThresholdTokens) * 100))
          : undefined,
        sessionTokens: effectiveSessionTokens ?? undefined,
        totalTokens: effectiveContextWindow,
        thresholdTokens: effectiveThresholdTokens ?? Math.floor(effectiveContextWindow * (effectiveThresholdPercent / 100)),
        tokenThresholdPercent: effectiveThresholdPercent,
      }
    : null;

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < STICK_THRESHOLD_PX;
    shouldStickToBottomRef.current = nearBottom;
    setShowScrollToBottom(distanceFromBottom >= STICK_THRESHOLD_PX);
  };

  const scrollToBottom = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
  };

  // 切换对话时立即定位到底部，避免首屏闪动
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    shouldStickToBottomRef.current = true;
    lastScrollHeightRef.current = el.scrollHeight;
  }, [conversationId]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const increasedHeight = el.scrollHeight > lastScrollHeightRef.current;
    lastScrollHeightRef.current = el.scrollHeight;
    // 仅在用户当前处于底部附近时才自动滚到底部，避免打断用户向上查看
    if (distanceFromBottom > STICK_THRESHOLD_PX || (!shouldStickToBottomRef.current && increasedHeight)) {
      setShowScrollToBottom(true);
      return;
    }
    const raf = requestAnimationFrame(() => {
      if (!el) return;
      const again = el.scrollHeight - el.scrollTop - el.clientHeight;
      // 消息更新时使用瞬时滚动，避免流式输出时动画卡顿
      if (again <= STICK_THRESHOLD_PX) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages.length, loading, streamingContent, streamingReasoning, streamingToolLogs.length, streamingSubagents.length, error]);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 relative">
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-auto p-6 flex flex-col gap-4">
        {(messages ?? [])
          .filter((m) => m.type !== "tool") // 过滤掉 tool 消息，它们的内容已在 toolLogs 中展示
          .map((m, i) => (
            <MessageBubble key={i} message={m} conversationId={conversationId} models={models} />
          ))}
        {isTaskExecuting && !loading && (
          <div className="p-4 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] text-sm flex items-center gap-3">
            <div className="animate-spin h-5 w-5 border-2 border-[var(--color-accent)] border-t-transparent rounded-full"></div>
            <span>定时任务正在执行中，Agent 正在处理您的请求...</span>
          </div>
        )}
        {(loading || streamingContent || streamingReasoning || streamingToolLogs.length > 0 || streamingSubagents.length > 0) && (
          <StreamingBubble
          content={streamingContent}
          reasoning={streamingReasoning}
          status={streamingStatus}
          toolLogs={streamingToolLogs}
          subagents={streamingSubagents}
          plan={streamingPlan ?? undefined}
          pendingApprovals={pendingApprovals}
          onApproval={onApproval}
          processingApprovals={processingApprovals}
          conversationId={conversationId}
          isStreaming={loading}
          supportsReasoning={(models.find((m) => m.id === modelId) ?? models[0])?.supportsReasoning === true}
          modelName={modelId ? (models.find((m) => m.id === modelId)?.name ?? modelId) : undefined}
          usageTokens={usageTokens || undefined}
        />
        )}
        {error && (
          <div className="p-3 rounded-lg bg-[var(--color-error-bg)] text-[var(--color-error-text)]">
            {error}
          </div>
        )}
      </div>
      {showScrollToBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-20 right-6 z-10 p-2 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
          title="回到底部"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
        </button>
      )}
      <div className="shrink-0 px-4 py-3 border-t border-[var(--color-border)]">
        <div className="flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <ChatInputBar
              value={input}
              onChange={onInputChange}
              onSend={onSend}
              loading={loading || isTaskExecuting}
              compact
              placeholder={isTaskExecuting ? "定时任务执行中，请稍候..." : "输入消息…"}
              files={files}
              onFilesChange={onFilesChange}
              models={models}
              modelId={modelId}
              onModelChange={onModelChange}
              mode={mode}
              onModeChange={onModeChange}
              modeLocked={modeLocked}
              disabled={isTaskExecuting}
              contextUsage={displayContextUsage}
              onCompress={onCompress}
              compressing={compressing}
            />
          </div>
          {(mode === "team" && onToggleTeamPanel) || (artifactCount > 0 && onToggleArtifacts) ? (
            <div className="shrink-0 mb-1 flex flex-col gap-2">
              {mode === "team" && onToggleTeamPanel && (
                <button
                  onClick={onToggleTeamPanel}
                  className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium transition-colors ${
                    showTeamPanel
                      ? "bg-[var(--color-accent)] text-white"
                      : "bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                  title="Team Panel"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  Team
                </button>
              )}
              {artifactCount > 0 && onToggleArtifacts && (
                <button
                  onClick={onToggleArtifacts}
                  className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium transition-colors ${
                    artifactsPanelOpen
                      ? "bg-[var(--color-accent)] text-white"
                      : "bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                  title="查看产物文件"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  {artifactCount}
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
