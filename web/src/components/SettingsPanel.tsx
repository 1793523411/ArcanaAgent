import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { getConfig, putConfig } from "../api";
import type { UserConfig, ContextStrategyConfig } from "../types";

const DEFAULT_CONTEXT: ContextStrategyConfig = {
  strategy: "compress",
  trimToLast: 20,
  tokenThresholdPercent: 75,
  compressKeepRecent: 20,
};

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export default function SettingsPanel({ onClose, onSaved }: Props) {
  const [config, setConfig] = useState<UserConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<"context" | "skills">("context");

  useEffect(() => {
    getConfig().then(setConfig);
  }, []);

  const ctx = config?.context ?? DEFAULT_CONTEXT;

  const setContext = (next: Partial<ContextStrategyConfig>) => {
    if (!config) return;
    setConfig({
      ...config,
      context: { ...DEFAULT_CONTEXT, ...config.context, ...next },
    });
  };

  const toggleSkill = (id: string) => {
    if (!config) return;
    const enabled = config.enabledSkillIds.includes(id)
      ? config.enabledSkillIds.filter((s) => s !== id)
      : [...config.enabledSkillIds, id];
    setConfig({ ...config, enabledSkillIds: enabled });
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await putConfig({
        context: config.context ?? DEFAULT_CONTEXT,
        enabledSkillIds: config.enabledSkillIds,
        mcpServers: config.mcpServers,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (!config) return null;

  const sections = [
    { id: "context" as const, label: "上下文策略" },
    { id: "skills" as const, label: "Skill & MCP" },
  ] as const;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[100]" />
        <Dialog.Content
          onPointerDownOutside={onClose}
          onEscapeKeyDown={onClose}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[92%] max-w-[780px] h-[85vh] min-h-[420px] max-h-[680px] flex flex-col bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl z-[101] overflow-hidden"
        >
          <Dialog.Title id="settings-title" className="sr-only">
            全局设置
          </Dialog.Title>
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <nav
              aria-label="设置菜单"
              className="w-[180px] shrink-0 flex flex-col gap-0.5 p-3 border-r border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              {sections.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveSection(id)}
                  className={`w-full text-left px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                    activeSection === id
                      ? "text-[var(--color-accent)] bg-[var(--color-surface)] border border-[var(--color-border)]"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="flex-1 min-h-0 overflow-auto p-6">
            {activeSection === "context" && (
              <section aria-labelledby="context-heading" className="space-y-4">
                <h2 id="context-heading" className="text-base font-semibold text-[var(--color-text)] m-0">
                  上下文策略
                </h2>
                <p className="text-[13px] text-[var(--color-text-muted)]">
                  新对话创建时会按当前选择固定策略，之后修改全局设置不会影响已有对话。
                </p>
                <div className="space-y-3">
                  <fieldset className="space-y-2">
                    <legend className="text-sm text-[var(--color-text)]">策略</legend>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer text-[var(--color-text)]">
                        <input
                          type="radio"
                          name="contextStrategy"
                          checked={ctx.strategy === "compress"}
                          onChange={() => setContext({ strategy: "compress" })}
                          className="border-[var(--color-border)]"
                        />
                        <span>压缩</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer text-[var(--color-text)]">
                        <input
                          type="radio"
                          name="contextStrategy"
                          checked={ctx.strategy === "trim"}
                          onChange={() => setContext({ strategy: "trim" })}
                          className="border-[var(--color-border)]"
                        />
                        <span>截断</span>
                      </label>
                    </div>
                  </fieldset>
                  <div className="text-[13px] text-[var(--color-text-muted)]">
                    {ctx.strategy === "compress"
                      ? "压缩：使用 LLM 将旧对话做摘要。当估算 token 超过模型上下文窗口的设定比例时触发。"
                      : "截断：直接丢弃旧消息，仅保留最近若干条。当估算 token 超过设定比例时触发。"}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-sm text-[var(--color-text)] col-span-2 sm:col-span-1">
                      <span>token 超过上下文窗口比例（%）时触发</span>
                      <input
                        type="number"
                        min={20}
                        max={95}
                        value={ctx.tokenThresholdPercent}
                        onChange={(e) => setContext({ tokenThresholdPercent: Math.min(95, Math.max(20, parseInt(e.target.value, 10) || 75)) })}
                        className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]"
                      />
                      <span className="text-xs text-[var(--color-text-muted)]">如 75 表示 75%</span>
                    </label>
                    {ctx.strategy === "trim" ? (
                      <label className="flex flex-col gap-1 text-sm text-[var(--color-text)] col-span-2 sm:col-span-1">
                        <span>截断时保留最近（条）</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={ctx.trimToLast}
                          onChange={(e) => setContext({ trimToLast: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                          className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]"
                        />
                      </label>
                    ) : (
                      <label className="flex flex-col gap-1 text-sm text-[var(--color-text)] col-span-2 sm:col-span-1">
                        <span>压缩时保留最近（条）</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={ctx.compressKeepRecent}
                          onChange={(e) => setContext({ compressKeepRecent: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                          className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]"
                        />
                      </label>
                    )}
                  </div>
                </div>
              </section>
            )}
            {activeSection === "skills" && (
              <section aria-labelledby="skills-heading" className="space-y-4">
                <h2 id="skills-heading" className="text-base font-semibold text-[var(--color-text)] m-0">
                  Skill / MCP
                </h2>
                <p className="text-[13px] text-[var(--color-text-muted)]">
                  勾选要启用的 Demo Skill，Agent 将可使用对应工具。MCP 管理后续可在此扩展。
                </p>
                <div className="flex flex-col gap-2">
                  {(config.availableSkillIds ?? []).map((id) => (
                    <label
                      key={id}
                      className="flex items-center gap-2.5 py-2 cursor-pointer text-[var(--color-text)]"
                    >
                      <input
                        type="checkbox"
                        checked={config.enabledSkillIds.includes(id)}
                        onChange={() => toggleSkill(id)}
                        className="rounded border-[var(--color-border)]"
                      />
                      <span>{id}</span>
                    </label>
                  ))}
                </div>
              </section>
            )}
            </div>
          </div>
          <div className="shrink-0 flex gap-2 justify-end p-4 border-t border-[var(--color-border)]">
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
