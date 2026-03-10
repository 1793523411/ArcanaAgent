import { useState, useEffect, useRef } from "react";
import type { StreamingStatus, ToolLog } from "../types";
import MarkdownContent from "./MarkdownContent";
import ToolCallBlock from "./ToolCallBlock";
import { getArtifactUrl } from "../api";

interface Props {
  content: string;
  reasoning?: string;
  status: StreamingStatus;
  toolLogs?: ToolLog[];
  isStreaming?: boolean;
  supportsReasoning?: boolean;
  modelName?: string;
  modelId?: string;
  conversationId?: string;
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export default function StreamingBubble({ content, reasoning, status, toolLogs = [], isStreaming = false, supportsReasoning = false, modelName, conversationId }: Props) {
  const [reasoningCollapsed, setReasoningCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
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
  const copyableText = content.trim() || "";

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

  return (
    <div className="self-start max-w-[85%] py-3 px-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-[var(--color-text-muted)] shrink-0">Agent</span>
          {modelName && (
            <span
              className="text-[11px] px-2 py-0.5 rounded-md bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] border border-[var(--color-border)] truncate max-w-[140px] cursor-default"
              data-tooltip={modelName}
            >
              {modelName}
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
              {hasReasoning ? <MarkdownContent transformImageUrl={transformImageUrl}>{reasoning}</MarkdownContent> : <span className="text-[var(--color-text-muted)]">（思考中…）</span>}
            </div>
          )}
        </div>
      )}
      {hasToolLogs && <ToolCallBlock logs={toolLogs} />}
      {content ? (
        <MarkdownContent transformImageUrl={transformImageUrl}>{content}</MarkdownContent>
      ) : (
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <span className="loading-dots" />
          {status === "tool" ? "正在执行工具…" : "正在思考…"}
        </div>
      )}
    </div>
  );
}
