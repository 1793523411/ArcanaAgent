import { useEffect, useRef } from "react";
import type { StoredMessage, StreamingStatus } from "../types";
import MessageBubble from "./MessageBubble";
import StreamingBubble from "./StreamingBubble";
import ChatInputBar, { type FileWithData } from "./ChatInputBar";

interface Props {
  messages: StoredMessage[];
  /** 当前对话 id，用于附件 URL */
  conversationId?: string;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  loading: boolean;
  streamingContent: string;
  streamingReasoning: string;
  streamingStatus: StreamingStatus;
  streamingToolCalls: Array<{ name: string; input?: string }>;
  error: string | null;
  files: FileWithData[];
  onFilesChange: (files: FileWithData[]) => void;
  models: Array<{ id: string; name: string; provider?: string }>;
  modelId: string | undefined;
  onModelChange: (modelId: string) => void;
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
  streamingToolCalls,
  error,
  files,
  onFilesChange,
  models,
  modelId,
  onModelChange,
}: Props) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages.length, loading, streamingContent, streamingReasoning, streamingToolCalls.length, error]);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto p-6 flex flex-col gap-4">
        {(messages ?? []).map((m, i) => (
          <MessageBubble key={i} message={m} conversationId={conversationId} />
        ))}
        {(loading || streamingContent || streamingReasoning || streamingToolCalls.length > 0) && (
          <StreamingBubble content={streamingContent} reasoning={streamingReasoning} status={streamingStatus} toolCalls={streamingToolCalls} isStreaming={loading} />
        )}
        {error && (
          <div className="p-3 rounded-lg bg-[var(--color-error-bg)] text-[var(--color-error-text)]">
            {error}
          </div>
        )}
      </div>
      <div className="shrink-0 p-4 border-t border-[var(--color-border)]">
        <ChatInputBar
          value={input}
          onChange={onInputChange}
          onSend={onSend}
          loading={loading}
          compact
          placeholder="输入消息…"
          files={files}
          onFilesChange={onFilesChange}
          models={models}
          modelId={modelId}
          onModelChange={onModelChange}
        />
      </div>
    </div>
  );
}
