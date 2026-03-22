import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import MarkdownContent from "./MarkdownContent";
import { getShare } from "../api";
import type { ShareRecord } from "../api";

export default function SharedView() {
  const { shareId } = useParams<{ shareId: string }>();
  const [record, setRecord] = useState<ShareRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!shareId) return;
    setLoading(true);
    getShare(shareId)
      .then(setRecord)
      .catch(() => setError("分享内容不存在或已过期"))
      .finally(() => setLoading(false));
  }, [shareId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center">
        <div className="text-[var(--color-text-muted)] text-sm">加载中...</div>
      </div>
    );
  }

  if (error || !record) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">404</div>
          <div className="text-[var(--color-text-muted)] text-sm">{error || "分享内容不存在"}</div>
        </div>
      </div>
    );
  }

  const dateStr = new Date(record.createdAt).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="min-h-screen bg-[var(--color-bg)] flex flex-col items-center py-12 px-4">
      {/* Header */}
      <div className="w-full max-w-[720px] mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm"
            style={{ background: "linear-gradient(135deg, #14b8a6, #0d9488)" }}
          >
            A
          </div>
          <span className="text-base font-semibold text-[var(--color-text)]">ArcanaAgent</span>
        </div>
        <div className="text-sm text-[var(--color-text-muted)]">
          {record.conversationTitle}
        </div>
        <div className="text-xs text-[var(--color-text-muted)] mt-1">
          {dateStr}
        </div>
      </div>

      {/* Content Card */}
      <div className="w-full max-w-[720px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-8">
        <div className="text-xs text-[var(--color-text-muted)] mb-4 flex items-center gap-1.5">
          <span>Agent</span>
          {record.message.modelId && (
            <span className="px-2 py-0.5 rounded-md bg-[var(--color-surface-hover)] border border-[var(--color-border)]">
              {record.message.modelId}
            </span>
          )}
        </div>
        <div className="text-sm leading-relaxed text-[var(--color-text)]">
          <MarkdownContent>{record.message.content}</MarkdownContent>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-8 text-xs text-[var(--color-text-muted)] flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
        Powered by ArcanaAgent
      </div>
    </div>
  );
}
