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
  const [copied, setCopied] = useState(false);
  const toolLogs = message.toolLogs ?? [];
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
        {toolLogs.length > 0 && <ToolCallBlock logs={toolLogs} defaultCollapsed />}
        {isHuman ? (
          text ? <div className="whitespace-pre-wrap break-words">{text}</div> : null
        ) : (
          text ? <MarkdownContent transformImageUrl={transformImageUrl}>{text}</MarkdownContent> : null
        )}
      </div>
    </div>
  );
}
