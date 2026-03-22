import { useState, useRef, useEffect } from "react";
import type { ConversationMeta } from "../types";

const SIDEBAR_OPEN_KEY = "arcana-agent-conversation-sidebar-open";

interface Props {
  conversations: ConversationMeta[];
  current: ConversationMeta | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSelect: (c: ConversationMeta) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onExport: (id: string, format: "markdown" | "json") => Promise<void>;
  onNewConversation: () => void;
}

export default function Sidebar({
  conversations,
  current,
  searchQuery,
  onSearchChange,
  onSelect,
  onDelete,
  onRename,
  onExport,
  onNewConversation,
}: Props) {
  const [open, setOpen] = useState(() => {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_OPEN_KEY, String(open));
  }, [open]);

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  const handleStartEdit = (c: ConversationMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(c.id);
    setEditingValue(c.title);
  };

  const handleSaveRename = (id: string) => {
    const title = editingValue.trim();
    if (title) {
      onRename(id, title).finally(() => {
        setEditingId(null);
        setEditingValue("");
      });
    } else {
      setEditingId(null);
      setEditingValue("");
    }
  };

  return (
    <aside
      className={`
        group h-full flex flex-col shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] min-h-0
        transition-[width] duration-200 ease-out overflow-hidden
        ${open ? "w-[260px]" : "w-12"}
      `}
      aria-label="对话列表"
    >
      {/* 顶部：仅新对话 */}
      <div className={`shrink-0 border-b border-[var(--color-border)] flex items-center ${open ? "p-3 px-4 flex-col gap-2" : "p-2 flex-col gap-2"}`}>
        <button
          type="button"
          onClick={onNewConversation}
          aria-label="新对话"
          title="新对话"
          className={`
            rounded-lg bg-[var(--color-accent)] text-white font-semibold border-none cursor-pointer hover:bg-[var(--color-accent-hover)]
            focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2 flex items-center justify-center
            ${open ? "w-full py-2.5 px-3.5" : "w-9 h-9 p-0 shrink-0"}
          `}
        >
          {open ? "新对话" : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          )}
        </button>
      </div>
      {open && (
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索对话..."
          aria-label="搜索对话"
          className="mx-2 mt-2 w-[calc(100%-16px)] py-2 px-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] text-sm placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none shrink-0"
        />
      )}
      <nav className={`flex-1 overflow-auto ${open ? "p-2" : "p-0"} min-h-0`} aria-label="对话列表">
        {open && conversations.map((c) => (
          <div
            key={c.id}
            onMouseEnter={() => setHoveredRowId(c.id)}
            onMouseLeave={() => setHoveredRowId(null)}
            className={`
              flex items-center gap-1 rounded-lg mb-1
              ${current?.id === c.id ? "bg-[var(--color-accent-alpha)]" : "hover:bg-[var(--color-surface-hover)]"}
            `}
          >
            {editingId === c.id ? (
              <input
                ref={inputRef}
                type="text"
                value={editingValue}
                onChange={(e) => setEditingValue(e.target.value)}
                onBlur={() => handleSaveRename(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveRename(c.id);
                  if (e.key === "Escape") {
                    setEditingId(null);
                    setEditingValue("");
                  }
                }}
                className="flex-1 min-w-0 py-2 px-2 text-sm border border-[var(--color-accent)] rounded bg-[var(--color-bg)] text-[var(--color-text)]"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <button
                type="button"
                onClick={() => onSelect(c)}
                onDoubleClick={(e) => handleStartEdit(c, e)}
                aria-label={`打开对话：${c.title}`}
                className="flex-1 min-w-0 py-2.5 px-3 text-left text-sm cursor-pointer border-none bg-transparent text-[var(--color-text)]"
              >
                <span className="truncate block">{c.title}</span>
              </button>
            )}
            {editingId !== c.id && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExport(c.id, "markdown");
                  }}
                  aria-label={`导出对话：${c.title}`}
                  className={`shrink-0 p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-alpha)] transition-opacity border-none cursor-pointer ${hoveredRowId === c.id ? "opacity-100" : "opacity-0"}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={(e) => onDelete(c.id, e)}
                  aria-label={`删除对话：${c.title}`}
                  className={`shrink-0 p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-error-text)] hover:bg-[var(--color-error-bg)] transition-opacity border-none cursor-pointer ${hoveredRowId === c.id ? "opacity-100" : "opacity-0"}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                </button>
              </>
            )}
          </div>
        ))}
      </nav>
      {/* 底部：展开/收起按钮，仅 hover 时显示 */}
      <div className="shrink-0 border-t border-[var(--color-border)] py-2 px-2 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        {open ? (
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="收起对话列表"
            className="flex items-center justify-center gap-1.5 w-full py-2 px-2 rounded-lg text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors border-none cursor-pointer"
          >
            <span className="shrink-0 rotate-180">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </span>
            <span>收起</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="展开对话列表"
            className="flex items-center justify-center w-9 h-9 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors border-none cursor-pointer p-0"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
      </div>
    </aside>
  );
}
