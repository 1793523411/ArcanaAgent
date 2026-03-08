import { useState, useEffect, useRef } from "react";
import type { StreamingStatus, ToolLog } from "../types";
import MarkdownContent from "./MarkdownContent";
import ToolCallBlock from "./ToolCallBlock";

interface Props {
  content: string;
  reasoning?: string;
  status: StreamingStatus;
  toolLogs?: ToolLog[];
  isStreaming?: boolean;
  supportsReasoning?: boolean;
}

export default function StreamingBubble({ content, reasoning, status, toolLogs = [], isStreaming = false, supportsReasoning = false }: Props) {
  const [reasoningCollapsed, setReasoningCollapsed] = useState(false);
  const reasoningRef = useRef<HTMLDivElement>(null);
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
  const showThinkingSection = hasReasoning || (isStreaming && supportsReasoning);

  return (
    <div className="self-start max-w-[85%] py-3 px-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
      <div className="text-xs text-[var(--color-text-muted)] mb-1">Agent</div>
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
              {hasReasoning ? <MarkdownContent>{reasoning}</MarkdownContent> : <span className="text-[var(--color-text-muted)]">（思考中…）</span>}
            </div>
          )}
        </div>
      )}
      {hasToolLogs && <ToolCallBlock logs={toolLogs} />}
      {content ? (
        <MarkdownContent>{content}</MarkdownContent>
      ) : (
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <span className="loading-dots" />
          {status === "tool" ? "正在执行工具…" : "正在思考…"}
        </div>
      )}
    </div>
  );
}
