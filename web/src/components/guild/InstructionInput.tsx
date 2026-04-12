import { useState } from "react";
import type { TaskPriority, TaskKind } from "../../types/guild";
import Select from "./Select";

interface Props {
  onSubmit: (text: string, priority: TaskPriority, kind: TaskKind) => void;
  loading?: boolean;
  placeholder?: string;
  showPriority?: boolean;
}

const PRIORITY_OPTIONS: Array<{ value: TaskPriority; label: string; icon: string }> = [
  { value: "low", label: "低", icon: "○" },
  { value: "medium", label: "中", icon: "◐" },
  { value: "high", label: "高", icon: "●" },
  { value: "urgent", label: "紧急", icon: "⚡" },
];

export default function InstructionInput({ onSubmit, loading, placeholder, showPriority }: Props) {
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [asRequirement, setAsRequirement] = useState(true);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    onSubmit(trimmed, priority, asRequirement ? "requirement" : "adhoc");
    setText("");
  };

  return (
    <div
      className="flex flex-col gap-2 p-3 border-t"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <textarea
        className="w-full px-3 py-2 rounded-lg text-sm resize-y"
        style={{
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text)",
          minHeight: 72,
          maxHeight: 200,
        }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder ?? "输入指令创建任务…（Shift+Enter 换行，Enter 发送）"}
        rows={3}
        disabled={loading}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            handleSend();
          }
        }}
      />
      <div className="flex items-center gap-2 flex-wrap">
        {showPriority && (
          <Select<TaskPriority>
            value={priority}
            onChange={setPriority}
            disabled={loading}
            title="任务优先级"
            leadingLabel="优先级"
            options={PRIORITY_OPTIONS.map((p) => ({
              value: p.value,
              label: (
                <span className="flex items-center gap-1.5">
                  <span>{p.icon}</span>
                  <span>{p.label}</span>
                </span>
              ),
            }))}
          />
        )}
        <label
          className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg cursor-pointer select-none"
          style={{
            border: "1px solid var(--color-border)",
            background: asRequirement ? "var(--color-accent-alpha)" : "transparent",
            color: asRequirement ? "var(--color-accent)" : "var(--color-text-muted)",
          }}
          title="勾选后提交为需求，由 Lead Agent 自动分解为子任务"
        >
          <input
            type="checkbox"
            className="w-3 h-3 accent-[var(--color-accent)]"
            checked={asRequirement}
            onChange={(e) => setAsRequirement(e.target.checked)}
            disabled={loading}
          />
          <span>作为需求（让 Lead 分解）</span>
        </label>
        <div className="flex-1" />
        <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
          {text.length > 0 ? `${text.length} 字` : ""}
        </span>
        <button
          className="px-4 py-1.5 rounded-lg text-sm text-white shrink-0 transition-colors"
          style={{ background: loading || !text.trim() ? "var(--color-text-muted)" : "var(--color-accent)" }}
          onClick={handleSend}
          disabled={loading || !text.trim()}
        >
          {loading ? "发送中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
