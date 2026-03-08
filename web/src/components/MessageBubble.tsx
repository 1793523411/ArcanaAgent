import { useState } from "react";
import type { StoredMessage } from "../types";
import MarkdownContent from "./MarkdownContent";
import AttachmentStrip from "./AttachmentStrip";
import ToolCallBlock from "./ToolCallBlock";

interface Props {
  message: StoredMessage;
  conversationId?: string;
}

export default function MessageBubble({ message, conversationId }: Props) {
  const isHuman = message.type === "human";
  const attachments = message.attachments ?? [];
  const reasoning = message.type === "ai" ? message.reasoningContent : undefined;
  const hasReasoning = typeof reasoning === "string" && reasoning.trim().length > 0;
  const [reasoningCollapsed, setReasoningCollapsed] = useState(true);
  const toolLogs = message.toolLogs ?? [];
  const hasContent = typeof message.content === "string" && message.content.trim().length > 0;
  const text = hasContent
    ? message.content
    : (message.type === "ai" && toolLogs.length === 0 ? "(该条回复内容未保存)" : message.content || "");

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
          ${isHuman ? "bg-[var(--color-accent-dim)]" : "bg-[var(--color-surface)]"}
        `}
      >
        <div className="text-xs text-[var(--color-text-muted)] mb-1">
          {isHuman ? "你" : "Agent"}
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
        {toolLogs.length > 0 && <ToolCallBlock logs={toolLogs} defaultCollapsed />}
        {isHuman ? (
          text ? <div className="whitespace-pre-wrap break-words">{text}</div> : null
        ) : (
          <MarkdownContent>{text}</MarkdownContent>
        )}
      </div>
    </div>
  );
}
