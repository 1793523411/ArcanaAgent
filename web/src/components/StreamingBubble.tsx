import type { StreamingStatus } from "../types";
import MarkdownContent from "./MarkdownContent";

interface Props {
  content: string;
  status: StreamingStatus;
}

export default function StreamingBubble({ content, status }: Props) {
  return (
    <div className="self-start max-w-[85%] py-3 px-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
      <div className="text-xs text-[var(--color-text-muted)] mb-1">Agent</div>
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
