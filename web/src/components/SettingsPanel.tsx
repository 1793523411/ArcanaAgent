import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { getConfig, putConfig, getSkills, uploadSkillZip, deleteSkill, type SkillMeta } from "../api";
import type { UserConfig, ContextStrategyConfig, McpServerConfig, McpStatusItem } from "../types";
import { useToast } from "./Toast";

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
  const { toast } = useToast();
  const [config, setConfig] = useState<UserConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<"context" | "mcp" | "skills">("context");
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [skillUploading, setSkillUploading] = useState(false);
  const [skillUploadError, setSkillUploadError] = useState<string | null>(null);

  // MCP form state
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpEnv, setMcpEnv] = useState("");
  const [mcpAdding, setMcpAdding] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatusItem[]>([]);

  useEffect(() => {
    getConfig().then((c) => {
      setConfig(c);
      setMcpStatus(c.mcpStatus ?? []);
    });
  }, []);

  useEffect(() => {
    if (activeSection === "skills") {
      getSkills().then(setSkills).catch(() => setSkills([]));
    }
  }, [activeSection]);

  const ctx = config?.context ?? DEFAULT_CONTEXT;

  const setContext = (next: Partial<ContextStrategyConfig>) => {
    if (!config) return;
    setConfig({
      ...config,
      context: { ...DEFAULT_CONTEXT, ...config.context, ...next },
    });
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const updated = await putConfig({
        context: config.context ?? DEFAULT_CONTEXT,
        mcpServers: config.mcpServers,
      });
      setMcpStatus(updated.mcpStatus ?? []);
      toast("设置已保存", "success");
      onSaved();
    } catch (e) {
      toast(`保存失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  if (!config) return null;

  const handleSkillZipChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !file.name.toLowerCase().endsWith(".zip")) {
      setSkillUploadError("请选择 .zip 文件");
      return;
    }
    setSkillUploadError(null);
    setSkillUploading(true);
    try {
      await uploadSkillZip(file);
      const list = await getSkills();
      setSkills(list);
      toast("技能安装成功", "success");
    } catch (err) {
      setSkillUploadError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setSkillUploading(false);
    }
  };

  const handleDeleteSkill = async (name: string) => {
    if (!confirm(`确定删除技能「${name}」？`)) return;
    try {
      await deleteSkill(name);
      setSkills((prev) => prev.filter((s) => s.name !== name));
      toast("技能已删除", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error");
    }
  };

  const handleAddMcpServer = async () => {
    const name = mcpName.trim();
    const command = mcpCommand.trim();
    if (!name || !command) {
      toast("名称和命令不能为空", "error");
      return;
    }
    if (config.mcpServers.some((s) => s.name === name)) {
      toast("名称已存在", "error");
      return;
    }
    const args = mcpArgs.trim() ? mcpArgs.trim().split(/\s+/) : [];
    const env: Record<string, string> = {};
    for (const pair of mcpEnv.trim().split(/\s+/).filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const newServer: McpServerConfig = {
      name, transport: "stdio", command, args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
    const newServers = [...config.mcpServers, newServer];
    setMcpName("");
    setMcpCommand("");
    setMcpArgs("");
    setMcpEnv("");
    setShowMcpForm(false);
    setMcpAdding(true);
    try {
      const updated = await putConfig({ mcpServers: newServers });
      setConfig((prev) => prev ? { ...prev, mcpServers: newServers } : prev);
      setMcpStatus(updated.mcpStatus ?? []);
      toast(`已添加 ${name}`, "success");
    } catch (e) {
      toast(`添加失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setMcpAdding(false);
    }
  };

  const handleRemoveMcpServer = async (name: string) => {
    const newServers = config.mcpServers.filter((s) => s.name !== name);
    try {
      const updated = await putConfig({ mcpServers: newServers });
      setConfig((prev) => prev ? { ...prev, mcpServers: newServers } : prev);
      setMcpStatus(updated.mcpStatus ?? []);
      toast(`已移除 ${name}`, "success");
    } catch (e) {
      toast(`移除失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const getServerStatus = (name: string): McpStatusItem | undefined => {
    return mcpStatus.find((s) => s.name === name);
  };

  const sections = [
    { id: "context" as const, label: "上下文策略" },
    { id: "mcp" as const, label: "MCP Servers" },
    { id: "skills" as const, label: "Skills" },
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
            {activeSection === "mcp" && (
              <section aria-labelledby="mcp-heading" className="space-y-4">
                <h2 id="mcp-heading" className="text-base font-semibold text-[var(--color-text)] m-0">
                  MCP Servers
                </h2>
                <p className="text-[13px] text-[var(--color-text-muted)]">
                  连接 MCP (Model Context Protocol) 服务器以扩展 Agent 的工具能力。配置后点击"保存"生效。
                </p>

                {config.mcpServers.length === 0 && !showMcpForm && (
                  <div className="text-[13px] text-[var(--color-text-muted)] py-4">
                    暂未配置 MCP 服务器。点击下方按钮添加。
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {config.mcpServers.map((server) => {
                    const status = getServerStatus(server.name);
                    return (
                      <div
                        key={server.name}
                        className="flex items-start justify-between gap-3 p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-[var(--color-text)]">{server.name}</span>
                            {status ? (
                              <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                {status.toolCount} tool{status.toolCount !== 1 ? "s" : ""}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
                                未连接
                              </span>
                            )}
                          </div>
                          <p className="m-0 mt-1 text-[12px] text-[var(--color-text-muted)] font-mono">
                            {server.command} {server.args.join(" ")}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveMcpServer(server.name)}
                          className="shrink-0 px-2 py-1 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-error-text)] border border-transparent hover:border-[var(--color-border)] rounded transition-colors"
                        >
                          删除
                        </button>
                      </div>
                    );
                  })}
                </div>

                {showMcpForm ? (
                  <div className="space-y-3 p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                    <div className="space-y-2">
                      <label className="block text-sm text-[var(--color-text)]">
                        名称
                        <input
                          type="text"
                          value={mcpName}
                          onChange={(e) => setMcpName(e.target.value)}
                          placeholder="如: filesystem"
                          className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                        />
                      </label>
                      <label className="block text-sm text-[var(--color-text)]">
                        命令
                        <input
                          type="text"
                          value={mcpCommand}
                          onChange={(e) => setMcpCommand(e.target.value)}
                          placeholder="如: npx"
                          className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                        />
                      </label>
                      <label className="block text-sm text-[var(--color-text)]">
                        参数（空格分隔）
                        <input
                          type="text"
                          value={mcpArgs}
                          onChange={(e) => setMcpArgs(e.target.value)}
                          placeholder="如: -y @modelcontextprotocol/server-filesystem /tmp"
                          className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                        />
                      </label>
                      <label className="block text-sm text-[var(--color-text)]">
                        环境变量（空格分隔，KEY=VALUE 格式）
                        <input
                          type="text"
                          value={mcpEnv}
                          onChange={(e) => setMcpEnv(e.target.value)}
                          placeholder="如: API_KEY=sk-xxx TIMEOUT=30"
                          className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                        />
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleAddMcpServer}
                        disabled={mcpAdding}
                        className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium border-none cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed hover:bg-[var(--color-accent-hover)] transition-colors"
                      >
                        {mcpAdding ? "保存中…" : "添加"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowMcpForm(false); setMcpName(""); setMcpCommand(""); setMcpArgs(""); setMcpEnv(""); }}
                        className="px-4 py-2 rounded-lg bg-transparent border border-[var(--color-border)] text-[var(--color-text)] text-sm cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowMcpForm(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] text-sm cursor-pointer hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    添加 MCP Server
                  </button>
                )}
              </section>
            )}
            {activeSection === "skills" && (
              <section aria-labelledby="skills-heading" className="space-y-4">
                <h2 id="skills-heading" className="text-base font-semibold text-[var(--color-text)] m-0">
                  Skills
                </h2>
                <p className="text-[13px] text-[var(--color-text-muted)]">
                  上传符合 SKILL.md 规范的 ZIP 包安装技能。ZIP 内需包含 SKILL.md（YAML frontmatter 含 name、description）。
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors">
                    <input
                      type="file"
                      accept=".zip"
                      className="sr-only"
                      disabled={skillUploading}
                      onChange={handleSkillZipChange}
                    />
                    <span>{skillUploading ? "上传中…" : "上传 ZIP"}</span>
                  </label>
                  {skillUploadError && (
                    <p className="text-[13px] text-[var(--color-error-text)]" role="alert">
                      {skillUploadError}
                    </p>
                  )}
                </div>
                <ul className="list-none m-0 p-0 flex flex-col gap-2">
                  {skills.length === 0 ? (
                    <li className="text-[13px] text-[var(--color-text-muted)]">暂无已安装技能，请上传 ZIP 或将技能放入 skills/ 目录。</li>
                  ) : (
                    skills.map((s) => (
                      <li
                        key={s.name}
                        className="flex items-start justify-between gap-3 py-2 px-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-[var(--color-text)]">{s.name}</span>
                            {s.userUploaded === false && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]">内置</span>
                            )}
                          </div>
                          {s.description && (
                            <p className="m-0 mt-0.5 text-[13px] text-[var(--color-text-muted)] line-clamp-2">
                              {s.description}
                            </p>
                          )}
                        </div>
                        {s.userUploaded !== false && (
                          <button
                            type="button"
                            onClick={() => handleDeleteSkill(s.name)}
                            className="shrink-0 px-2 py-1 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-error-text)] border border-transparent hover:border-[var(--color-border)] rounded transition-colors"
                          >
                            删除
                          </button>
                        )}
                      </li>
                    ))
                  )}
                </ul>
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
