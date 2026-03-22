import { useState, useEffect } from "react";

const STORAGE_KEY = "arcana-agent-tool-sidebar-open";

interface Props {
  onOpenTemplates: () => void;
  onOpenConfig: () => void;
  onOpenScheduledTasks: () => void;
  onOpenAgentTeam: () => void;
  onOpenModels: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export default function ToolSidebar({
  onOpenTemplates,
  onOpenConfig,
  onOpenScheduledTasks,
  onOpenAgentTeam,
  onOpenModels,
  theme,
  onToggleTheme,
}: Props) {
  const [open, setOpen] = useState(() => {
    if (typeof localStorage === "undefined") return false;
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "true";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(open));
  }, [open]);

  const toggle = () => setOpen((o) => !o);

  return (
    <aside
      className={`
        h-full flex flex-col shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)]
        transition-[width] duration-200 ease-out overflow-hidden
        ${open ? "w-[180px]" : "w-12"}
      `}
      aria-label="工具"
    >
      {/* 展开/收起 触发条 */}
      <button
        type="button"
        onClick={toggle}
        aria-label={open ? "收起工具栏" : "展开工具栏"}
        className={`
          shrink-0 flex items-center justify-center py-3 border-b border-[var(--color-border)]
          text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]
          transition-colors
          ${open ? "px-2" : "px-0 w-12"}
        `}
      >
        <span className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </button>

      <div className="flex-1 overflow-auto p-2 flex flex-col gap-2 min-h-0">
        <button
          type="button"
          onClick={onOpenTemplates}
          aria-label="模板管理"
          title="模板管理"
          className={`
            rounded-lg border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer
            hover:bg-[var(--color-surface-hover)] transition-colors flex items-center
            ${open ? "w-full py-2 px-3 gap-2 justify-center text-[13px]" : "w-9 h-9 justify-center p-0 shrink-0 self-center"}
          `}
        >
          <span>🧩</span>
          {open && <span>模板管理</span>}
        </button>
        <button
          type="button"
          onClick={onOpenScheduledTasks}
          aria-label="定时任务"
          title="定时任务"
          className={`
            rounded-lg border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer
            hover:bg-[var(--color-surface-hover)] transition-colors flex items-center
            ${open ? "w-full py-2 px-3 gap-2 justify-center text-[13px]" : "w-9 h-9 justify-center p-0 shrink-0 self-center"}
          `}
        >
          <span>⏰</span>
          {open && <span>定时任务</span>}
        </button>
        <button
          type="button"
          onClick={onOpenAgentTeam}
          aria-label="Agent / Team"
          title="Agent / Team 管理"
          className={`
            rounded-lg border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer
            hover:bg-[var(--color-surface-hover)] transition-colors flex items-center
            ${open ? "w-full py-2 px-3 gap-2 justify-center text-[13px]" : "w-9 h-9 justify-center p-0 shrink-0 self-center"}
          `}
        >
          <span>👥</span>
          {open && <span>Agent/Team</span>}
        </button>
        <button
          type="button"
          onClick={onOpenModels}
          aria-label="模型管理"
          title="模型管理"
          className={`
            rounded-lg border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer
            hover:bg-[var(--color-surface-hover)] transition-colors flex items-center
            ${open ? "w-full py-2 px-3 gap-2 justify-center text-[13px]" : "w-9 h-9 justify-center p-0 shrink-0 self-center"}
          `}
        >
          <span>🧠</span>
          {open && <span>模型管理</span>}
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "切换为浅色主题" : "切换为深色主题"}
          title={theme === "dark" ? "浅色模式" : "深色模式"}
          className={`
            rounded-lg border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer
            hover:bg-[var(--color-surface-hover)] transition-colors flex items-center
            ${open ? "w-full py-2 px-3 gap-2 justify-center text-[13px]" : "w-9 h-9 justify-center p-0 shrink-0 self-center"}
          `}
        >
          <span>{theme === "dark" ? "☀️" : "🌙"}</span>
          {open && <span>{theme === "dark" ? "浅色" : "深色"}</span>}
        </button>
        <button
          type="button"
          onClick={onOpenConfig}
          aria-label="全局设置"
          title="设置"
          className={`
            rounded-lg border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer
            hover:bg-[var(--color-surface-hover)] transition-colors flex items-center
            ${open ? "w-full py-2 px-3 gap-2 justify-center text-[13px]" : "w-9 h-9 justify-center p-0 shrink-0 self-center"}
          `}
        >
          <span>⚙️</span>
          {open && <span>设置</span>}
        </button>
      </div>
    </aside>
  );
}
