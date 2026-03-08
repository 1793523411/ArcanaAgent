import { useState, useEffect } from "react";
import type { StreamingStatus } from "../types";
import MarkdownContent from "./MarkdownContent";

interface Props {
  content: string;
  reasoning?: string;
  status: StreamingStatus;
  /** 本次回复中已调用的工具，在思考区域展示 */
  toolCalls?: Array<{ name: string; input?: string }>;
  /** 是否仍在流式输出（思考过程在流式时展开，结束后折叠） */
  isStreaming?: boolean;
}

export default function StreamingBubble({ content, reasoning, status, toolCalls = [], isStreaming = false }: Props) {
  const [reasoningCollapsed, setReasoningCollapsed] = useState(false);
  useEffect(() => {
    if (!isStreaming && reasoning) setReasoningCollapsed(true);
    else if (isStreaming) setReasoningCollapsed(false);
  }, [isStreaming, reasoning]);

  const hasReasoning = typeof reasoning === "string" && reasoning.trim().length > 0;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  const showThinkingSection = isStreaming || hasReasoning || hasToolCalls;

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
            <div className="mt-1.5 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text)] whitespace-pre-wrap break-words max-h-[280px] overflow-auto space-y-2">
              {hasToolCalls && (
                <div className="space-y-1">
                  {toolCalls.map((tc, i) => (
                    <div key={i} className="flex flex-wrap items-baseline gap-1.5 text-[var(--color-text-muted)]">
                      <span className="font-medium text-[var(--color-accent)]">🔧 使用工具: {tc.name}</span>
                      {tc.input && tc.input !== "{}" && (
                        <span className="text-xs truncate max-w-[200px]" title={tc.input}>{tc.input}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {hasReasoning ? <MarkdownContent>{reasoning}</MarkdownContent> : !hasToolCalls && <span className="text-[var(--color-text-muted)]">（思考中…）</span>}
            </div>
          )}
        </div>
      )}
      {content ? (
        <MarkdownContent>{content}</MarkdownContent>
      ) : (
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <span className="loading-dots" />
          {status === "tool" ? "正在调用工具…" : "正在思考…"}
        </div>
      )}
    </div>
  );
}
