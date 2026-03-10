import type { ConversationMeta } from "../types";

interface Props {
  conversations: ConversationMeta[];
  current: ConversationMeta | null;
  onSelect: (c: ConversationMeta) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onNewConversation: () => void;
  onOpenConfig: () => void;
  onOpenScheduledTasks: () => void;
}

export default function Sidebar({
  conversations,
  current,
  onSelect,
  onDelete,
  onNewConversation,
  onOpenConfig,
  onOpenScheduledTasks,
}: Props) {
  return (
    <aside className="w-[260px] h-full border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col shrink-0 min-h-0">
      <div className="p-3 px-4 border-b border-[var(--color-border)]">
        <button
          type="button"
          onClick={onNewConversation}
          aria-label="新对话"
          className="w-full py-2.5 px-3.5 rounded-lg bg-[var(--color-accent)] text-white font-semibold border-none cursor-pointer hover:bg-[var(--color-accent-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2"
        >
          新对话
        </button>
      </div>
      <nav className="flex-1 overflow-auto p-2" aria-label="对话列表">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`
              group flex items-center gap-1 rounded-lg mb-1
              ${current?.id === c.id ? "bg-[var(--color-accent-alpha)]" : "hover:bg-[var(--color-surface-hover)]"}
            `}
          >
            <button
              type="button"
              onClick={() => onSelect(c)}
              aria-label={`打开对话：${c.title}`}
              className="flex-1 min-w-0 py-2.5 px-3 text-left text-sm cursor-pointer border-none bg-transparent text-[var(--color-text)]"
            >
              <span className="truncate block">{c.title}</span>
            </button>
            <button
              type="button"
              onClick={(e) => onDelete(c.id, e)}
              aria-label={`删除对话：${c.title}`}
              className="shrink-0 p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-error-text)] hover:bg-[var(--color-error-bg)] sm:opacity-0 sm:group-hover:opacity-100 transition-opacity border-none cursor-pointer"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </div>
        ))}
      </nav>
      <div className="p-2 border-t border-[var(--color-border)] space-y-2">
        <button
          type="button"
          onClick={onOpenScheduledTasks}
          aria-label="定时任务"
          className="w-full py-2 px-3 rounded-lg bg-transparent border border-[var(--color-border)] text-[var(--color-text)] text-[13px] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors flex items-center justify-center gap-2"
        >
          <span>⏰</span>
          <span>定时任务</span>
        </button>
        <button
          type="button"
          onClick={onOpenConfig}
          aria-label="全局设置"
          className="w-full py-2 px-3 rounded-lg bg-transparent border border-[var(--color-border)] text-[var(--color-text)] text-[13px] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors"
        >
          设置
        </button>
      </div>
    </aside>
  );
}
