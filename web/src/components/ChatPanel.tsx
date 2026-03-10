import { useEffect, useRef } from "react";
import type { StoredMessage, StreamingStatus } from "../types";
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
  error: string | null;
  files: FileWithData[];
  onFilesChange: (files: FileWithData[]) => void;
  models: Array<{ id: string; name: string; provider?: string; supportsReasoning?: boolean }>;
  modelId: string | undefined;
  onModelChange: (modelId: string) => void;
  artifactCount?: number;
  onToggleArtifacts?: () => void;
  artifactsPanelOpen?: boolean;
  isTaskExecuting?: boolean;
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
  error,
  files,
  onFilesChange,
  models,
  modelId,
  onModelChange,
  artifactCount = 0,
  onToggleArtifacts,
  artifactsPanelOpen,
  isTaskExecuting = false,
}: Props) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages.length, loading, streamingContent, streamingReasoning, streamingToolLogs.length, error]);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto p-6 flex flex-col gap-4">
        {(messages ?? []).map((m, i) => (
          <MessageBubble key={i} message={m} conversationId={conversationId} models={models} />
        ))}
        {isTaskExecuting && !loading && (
          <div className="p-4 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] text-sm flex items-center gap-3">
            <div className="animate-spin h-5 w-5 border-2 border-[var(--color-accent)] border-t-transparent rounded-full"></div>
            <span>定时任务正在执行中，Agent 正在处理您的请求...</span>
          </div>
        )}
        {(loading || streamingContent || streamingReasoning || streamingToolLogs.length > 0) && (
          <StreamingBubble
          content={streamingContent}
          reasoning={streamingReasoning}
          status={streamingStatus}
          toolLogs={streamingToolLogs}
          isStreaming={loading}
          supportsReasoning={(models.find((m) => m.id === modelId) ?? models[0])?.supportsReasoning === true}
          modelName={modelId ? (models.find((m) => m.id === modelId)?.name ?? modelId) : undefined}
          modelId={modelId}
          conversationId={conversationId}
        />
        )}
        {error && (
          <div className="p-3 rounded-lg bg-[var(--color-error-bg)] text-[var(--color-error-text)]">
            {error}
          </div>
        )}
      </div>
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
              disabled={isTaskExecuting}
            />
          </div>
          {artifactCount > 0 && onToggleArtifacts && (
            <button
              onClick={onToggleArtifacts}
              className={`shrink-0 mb-1 flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium transition-colors ${
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
      </div>
    </div>
  );
}
