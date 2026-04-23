import { useEffect, useState } from "react";
import type { ArtifactStrategy, GuildAgent } from "../../types/guild";
import AIGroupDesignerModal from "./AIGroupDesignerModal";

interface Props {
  /** Presence switches the modal into edit mode. */
  initial?: { name: string; description: string; artifactStrategy?: ArtifactStrategy };
  /** Available existing agents — required for AI mode. */
  agents?: GuildAgent[];
  /** Called when AI mode finishes and creates a group. Parent should reload & focus it. */
  onAIDone?: (groupId: string) => void;
  onConfirm: (data: { name: string; description: string; artifactStrategy?: ArtifactStrategy }) => Promise<void>;
  onClose: () => void;
}

export default function CreateGroupModal({ initial, agents, onAIDone, onConfirm, onClose }: Props) {
  const isEdit = !!initial;
  const aiAvailable = !isEdit && !!onAIDone;
  const [aiMode, setAiMode] = useState(false);
  const initialStrategy: ArtifactStrategy = initial?.artifactStrategy ?? "isolated";
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [artifactStrategy, setArtifactStrategy] = useState<ArtifactStrategy>(initialStrategy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ESC closes (unless mid-save).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const strategyChanged = isEdit && artifactStrategy !== initialStrategy;

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm({ name: name.trim(), description: description.trim(), artifactStrategy });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (aiMode && aiAvailable) {
    return (
      <AIGroupDesignerModal
        agents={agents ?? []}
        onDone={(gid) => { onAIDone!(gid); onClose(); }}
        onClose={() => setAiMode(false)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="relative w-full max-w-md rounded-xl p-5 shadow-2xl"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>{isEdit ? "编辑小组" : "新建小组"}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            ✕
          </button>
        </div>

        {aiAvailable && (
          <button
            type="button"
            className="w-full mb-3 px-3 py-2 rounded-lg text-xs flex items-center justify-between"
            style={{ background: "var(--color-accent-alpha)", border: "1px solid var(--color-accent)", color: "var(--color-accent)" }}
            onClick={() => setAiMode(true)}
          >
            <span className="flex items-center gap-1.5">
              <span>✨</span>
              <span className="font-semibold">用 AI 建组</span>
              <span style={{ opacity: 0.7 }}>— 连同需要的 Agent 一起搞定</span>
            </span>
            <span>→</span>
          </button>
        )}

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
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>产物策略</label>
            <div className="flex gap-2">
              {([
                { value: "isolated" as const, label: "隔离模式", desc: "每个任务独立产物目录" },
                { value: "collaborative" as const, label: "协作模式", desc: "共享目录 + 自动追踪" },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="flex-1 px-3 py-2 rounded-lg text-xs text-left"
                  style={{
                    background: artifactStrategy === opt.value ? "var(--color-accent)" : "var(--color-bg)",
                    color: artifactStrategy === opt.value ? "white" : "var(--color-text)",
                    border: artifactStrategy === opt.value ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
                  }}
                  onClick={() => setArtifactStrategy(opt.value)}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div style={{ opacity: 0.7 }}>{opt.desc}</div>
                </button>
              ))}
            </div>
            {strategyChanged && (
              <div
                className="mt-2 text-[11px] px-2 py-1.5 rounded"
                style={{ color: "var(--color-text-muted)", background: "var(--color-bg)", border: "1px dashed var(--color-border)" }}
              >
                ⚠ 切换策略只影响后续任务，历史产物会保留在原目录结构中，不会自动迁移。
              </div>
            )}
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
            {saving ? (isEdit ? "保存中…" : "创建中…") : isEdit ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
