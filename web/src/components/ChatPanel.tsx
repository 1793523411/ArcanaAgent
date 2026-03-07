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
  streamingStatus: StreamingStatus;
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
  streamingStatus,
  error,
  files,
  onFilesChange,
  models,
  modelId,
  onModelChange,
}: Props) {
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="flex-1 min-h-0 overflow-auto p-6 flex flex-col gap-4">
        {(messages ?? []).map((m, i) => (
          <MessageBubble key={i} message={m} conversationId={conversationId} />
        ))}
        {(loading || streamingContent) && (
          <StreamingBubble content={streamingContent} status={streamingStatus} />
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
