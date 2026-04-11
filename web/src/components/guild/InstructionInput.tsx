import { useState } from "react";

interface Props {
  onSubmit: (text: string) => void;
  loading?: boolean;
  placeholder?: string;
}

export default function InstructionInput({ onSubmit, loading, placeholder }: Props) {
  const [text, setText] = useState("");

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    onSubmit(trimmed);
    setText("");
  };

  return (
    <div
      className="flex items-end gap-2 p-3 border-t"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <textarea
        className="flex-1 px-3 py-2 rounded-lg text-sm resize-none"
        style={{
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text)",
          minHeight: 36,
          maxHeight: 120,
        }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder ?? "输入指令创建任务..."}
        rows={1}
        disabled={loading}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            handleSend();
          }
        }}
      />
      <button
        className="px-4 py-2 rounded-lg text-sm text-white shrink-0"
        style={{ background: loading || !text.trim() ? "var(--color-text-muted)" : "var(--color-accent)" }}
        onClick={handleSend}
        disabled={loading || !text.trim()}
      >
        {loading ? "..." : "发送"}
      </button>
    </div>
  );
}
