import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { getConfig, putConfig } from "../api";
import type { UserConfig } from "../types";

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export default function ConfigModal({ onClose, onSaved }: Props) {
  const [config, setConfig] = useState<UserConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getConfig().then(setConfig);
  }, []);

  const toggleTool = (id: string) => {
    if (!config) return;
    const enabled = config.enabledToolIds.includes(id)
      ? config.enabledToolIds.filter((s) => s !== id)
      : [...config.enabledToolIds, id];
    setConfig({ ...config, enabledToolIds: enabled });
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await putConfig({
        enabledToolIds: config.enabledToolIds,
        mcpServers: config.mcpServers,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (!config) return null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[100]" />
        <Dialog.Content
          onPointerDownOutside={onClose}
          onEscapeKeyDown={onClose}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-[440px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 z-[101] shadow-xl"
        >
          <Dialog.Title id="config-title" className="m-0 mb-4 text-lg font-semibold text-[var(--color-text)]">
            Tools / MCP 配置
          </Dialog.Title>
          <Dialog.Description asChild>
            <p className="text-[var(--color-text-muted)] text-[13px] mb-5">
              勾选要启用的工具，Agent 将可调用对应能力。
            </p>
          </Dialog.Description>
          <div className="flex flex-col gap-2 mb-5">
            {(config.availableToolIds ?? []).map((id) => (
              <label
                key={id}
                className="flex items-center gap-2.5 py-2 cursor-pointer text-[var(--color-text)]"
              >
                <input
                  type="checkbox"
                  checked={config.enabledToolIds.includes(id)}
                  onChange={() => toggleTool(id)}
                  className="rounded border-[var(--color-border)]"
                />
                <span>{id}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                className="px-4 py-2.5 rounded-lg bg-transparent border border-[var(--color-border)] text-[var(--color-text)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors"
              >
                取消
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              aria-live="polite"
              aria-busy={saving}
              className="px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white font-semibold border-none cursor-pointer disabled:cursor-not-allowed hover:not(:disabled):bg-[var(--color-accent-hover)] transition-colors"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
