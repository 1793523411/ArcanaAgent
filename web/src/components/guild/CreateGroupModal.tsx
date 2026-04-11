import { useState } from "react";

interface Props {
  onConfirm: (data: { name: string; description: string }) => Promise<void>;
  onClose: () => void;
}

export default function CreateGroupModal({ onConfirm, onClose }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm({ name: name.trim(), description: description.trim() });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="relative w-full max-w-md rounded-xl p-5 shadow-2xl"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>新建小组</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            ✕
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>名称</label>
            <input
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="小组名称"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) handleSubmit(); }}
            />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>描述</label>
            <input
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="小组用途描述"
            />
          </div>
          {error && (
            <div className="text-xs" style={{ color: "var(--color-error-text)" }}>{error}</div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            className="px-4 py-1.5 rounded-lg text-sm"
            style={{ color: "var(--color-text-muted)" }}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="px-4 py-1.5 rounded-lg text-sm text-white"
            style={{ background: saving || !name.trim() ? "var(--color-text-muted)" : "var(--color-accent)" }}
            onClick={handleSubmit}
            disabled={saving || !name.trim()}
          >
            {saving ? "创建中..." : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
