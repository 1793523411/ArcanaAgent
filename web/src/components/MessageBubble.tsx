import type { StoredMessage } from "../types";
import MarkdownContent from "./MarkdownContent";

interface Props {
  message: StoredMessage;
}

export default function MessageBubble({ message }: Props) {
  const isHuman = message.type === "human";
  const text = message.content || (message.type === "ai" ? "(该条回复内容未保存)" : "");

  return (
    <div
      className={`
        max-w-[85%] py-3 px-4 rounded-xl border border-[var(--color-border)]
        ${isHuman ? "self-end bg-[var(--color-accent-dim)]" : "self-start bg-[var(--color-surface)]"}
      `}
    >
      <div className="text-xs text-[var(--color-text-muted)] mb-1">
        {isHuman ? "你" : "Agent"}
      </div>
      {isHuman ? (
        <div className="whitespace-pre-wrap break-words">{text}</div>
      ) : (
        <MarkdownContent>{text}</MarkdownContent>
      )}
    </div>
  );
}
