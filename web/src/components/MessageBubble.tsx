import type { StoredMessage } from "../types";
import MarkdownContent from "./MarkdownContent";
import AttachmentStrip from "./AttachmentStrip";

interface Props {
  message: StoredMessage;
  /** 当前对话 id，用于附件 URL（仅 human 消息需要） */
  conversationId?: string;
}

export default function MessageBubble({ message, conversationId }: Props) {
  const isHuman = message.type === "human";
  const text = message.content || (message.type === "ai" ? "(该条回复内容未保存)" : "");
  const attachments = message.attachments ?? [];

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
        {isHuman ? (
          text ? <div className="whitespace-pre-wrap break-words">{text}</div> : null
        ) : (
          <MarkdownContent>{text}</MarkdownContent>
        )}
      </div>
    </div>
  );
}
