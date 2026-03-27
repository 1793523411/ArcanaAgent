import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { getConfig, putConfig, getSkills, uploadSkillZip, deleteSkill, getIndexStatus, restartMcpServer, testClaudeCode, type SkillMeta, type IndexStatusResponse, type ClaudeCodeTestResult } from "../api";
import type { UserConfig, ContextStrategyConfig, McpServerConfig, McpStatusItem, PlanningConfig, ApprovalRule } from "../types";
import { useToast } from "./Toast";

const DEFAULT_CONTEXT: ContextStrategyConfig = {
  strategy: "compress",
  trimToLast: 20,
  tokenThresholdPercent: 75,
  compressKeepRecent: 20,
  saveToolMessages: true,
};

const DEFAULT_PLANNING: PlanningConfig = {
  enabled: true,
  streamProgress: true,
};

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export default function SettingsPanel({ onClose, onSaved }: Props) {
  const { toast } = useToast();
  const [config, setConfig] = useState<UserConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<"context" | "mcp" | "skills" | "approval" | "codeIndex" | "claudeCode">("context");
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [skillUploading, setSkillUploading] = useState(false);
  const [skillUploadError, setSkillUploadError] = useState<string | null>(null);
  const [deleteSkillTarget, setDeleteSkillTarget] = useState<string | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatusResponse | null>(null);
  const [indexStatusLoading, setIndexStatusLoading] = useState(false);

  // Claude Code test state
  const [ccTesting, setCcTesting] = useState(false);
  const [ccTestResult, setCcTestResult] = useState<ClaudeCodeTestResult | null>(null);

  // MCP form state
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "streamablehttp">("stdio");
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpEnv, setMcpEnv] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpHeaders, setMcpHeaders] = useState("");
  const [mcpAdding, setMcpAdding] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatusItem[]>([]);
  const [mcpRestarting, setMcpRestarting] = useState<string | null>(null);
  const [mcpExpanded, setMcpExpanded] = useState<Set<string>>(new Set());

  // Approval rule form state
  const [showApprovalForm, setShowApprovalForm] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleName, setRuleName] = useState("");
  const [rulePattern, setRulePattern] = useState("");
  const [ruleOpType, setRuleOpType] = useState<ApprovalRule["operationType"]>("run_command");
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [rulePatternError, setRulePatternError] = useState<string | null>(null);

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
    if (activeSection === "codeIndex") {
      setIndexStatusLoading(true);
      getIndexStatus()
        .then(setIndexStatus)
        .catch(() => setIndexStatus(null))
        .finally(() => setIndexStatusLoading(false));
    }
  }, [activeSection]);

  const ctx = config?.context ?? DEFAULT_CONTEXT;
  const planning = config?.planning ?? DEFAULT_PLANNING;

  const setContext = (next: Partial<ContextStrategyConfig>) => {
    if (!config) return;
    setConfig({
      ...config,
      context: { ...DEFAULT_CONTEXT, ...config.context, ...next },
    });
  };

  const setPlanning = (next: Partial<PlanningConfig>) => {
    if (!config) return;
    setConfig({
      ...config,
      planning: { ...DEFAULT_PLANNING, ...config.planning, ...next },
    });
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const updated = await putConfig({
        context: config.context ?? DEFAULT_CONTEXT,
        planning: config.planning ?? DEFAULT_PLANNING,
        mcpServers: config.mcpServers,
        approvalRules: config.approvalRules,
        codeIndexStrategy: config.codeIndexStrategy ?? null,
        claudeCode: config.claudeCode,
      } as Partial<UserConfig>);
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
    try {
      await deleteSkill(name);
      setSkills((prev) => prev.filter((s) => s.name !== name));
      setDeleteSkillTarget(null);
      toast("技能已删除", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error");
    }
  };

  const handleAddMcpServer = async () => {
    const name = mcpName.trim();
    if (!name) {
      toast("名称不能为空", "error");
      return;
    }
    if (config.mcpServers.some((s) => s.name === name)) {
      toast("名称已存在", "error");
      return;
    }
    let newServer: McpServerConfig;
    if (mcpTransport === "streamablehttp") {
      const url = mcpUrl.trim();
      if (!url) { toast("URL 不能为空", "error"); return; }
      const headers: Record<string, string> = {};
      for (const pair of mcpHeaders.trim().split(/\n/).filter(Boolean)) {
        const eq = pair.indexOf(":");
        if (eq > 0) headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
      newServer = { name, transport: "streamablehttp", url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
    } else {
      const command = mcpCommand.trim();
      if (!command) { toast("命令不能为空", "error"); return; }
      const args = mcpArgs.trim() ? mcpArgs.trim().split(/\s+/) : [];
      const env: Record<string, string> = {};
      for (const pair of mcpEnv.trim().split(/\s+/).filter(Boolean)) {
        const eq = pair.indexOf("=");
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      newServer = { name, transport: "stdio", command, args, ...(Object.keys(env).length > 0 ? { env } : {}) };
    }
    const newServers = [...config.mcpServers, newServer];
    setMcpName(""); setMcpCommand(""); setMcpArgs(""); setMcpEnv(""); setMcpUrl(""); setMcpHeaders("");
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

  const handleRestartMcpServer = async (name: string) => {
    setMcpRestarting(name);
    try {
      const result = await restartMcpServer(name);
      setMcpStatus(result.mcpStatus ?? []);
      if (result.connected) {
        toast(`${name} 重启成功，已加载 ${result.toolCount} 个工具`, "success");
      } else {
        toast(`${name} 连接失败: ${result.error ?? "未知错误"}`, "error");
      }
    } catch (e) {
      toast(`重启失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setMcpRestarting(null);
    }
  };

  const getServerStatus = (name: string): McpStatusItem | undefined => {
    return mcpStatus.find((s) => s.name === name);
  };

  const sections = [
    { id: "context" as const, label: "上下文策略" },
    { id: "codeIndex" as const, label: "代码索引" },
    { id: "mcp" as const, label: "MCP Servers" },
    { id: "skills" as const, label: "Skills" },
    { id: "approval" as const, label: "审批规则" },
    { id: "claudeCode" as const, label: "Claude Code" },
  ] as const;

  return (
    <>
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[100]" />
        <Dialog.Content
          onPointerDownOutside={onClose}
          onEscapeKeyDown={onClose}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[95%] max-w-[1000px] h-[90vh] min-h-[500px] max-h-[900px] flex flex-col bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl z-[101] overflow-hidden"
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
                    <legend className="text-sm text-[var(--color-text)]">执行计划</legend>
                    <label className="flex items-center gap-2 cursor-pointer text-[var(--color-text)]">
                      <input
                        type="checkbox"
                        checked={planning.enabled}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setPlanning({
                            enabled: checked,
                            ...(checked ? {} : { streamProgress: false }),
                          });
                        }}
                        className="border-[var(--color-border)]"
                      />
                      <span>启用先计划后执行</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-[var(--color-text)]">
                      <input
                        type="checkbox"
                        checked={planning.streamProgress}
                        disabled={!planning.enabled}
                        onChange={(e) => setPlanning({ streamProgress: e.target.checked })}
                        className="border-[var(--color-border)]"
                      />
                      <span className={!planning.enabled ? "opacity-60" : ""}>流式展示计划执行进度</span>
                    </label>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      开启后，回复前会先生成执行计划；流式模式下会实时显示步骤推进状态。
                    </p>
                  </fieldset>
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
                  <fieldset className="space-y-2">
                    <legend className="text-sm text-[var(--color-text)]">工具调用记录</legend>
                    <label className="flex items-center gap-2 cursor-pointer text-[var(--color-text)]">
                      <input
                        type="checkbox"
                        checked={ctx.saveToolMessages ?? true}
                        onChange={(e) => setContext({ saveToolMessages: e.target.checked })}
                        className="border-[var(--color-border)]"
                      />
                      <span>保存完整工具输出到上下文</span>
                    </label>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      <strong>开启</strong>：工具返回的完整内容（如读取的文件、命令输出等）会保存到历史，下一轮对话 agent 可以直接查看。
                      <br />
                      <strong>关闭</strong>：工具结果仅在当前对话展示，不会加入下一轮上下文，agent 需要时会重新调用工具。节省 token 但可能增加工具调用次数。
                    </p>
                  </fieldset>
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
            {activeSection === "codeIndex" && (
              <section aria-labelledby="codeindex-heading" className="space-y-4">
                <h2 id="codeindex-heading" className="text-base font-semibold text-[var(--color-text)] m-0">
                  代码索引
                </h2>
                <p className="text-[13px] text-[var(--color-text-muted)]">
                  选择代码索引策略以提升 Agent 对大型项目的理解能力。不同策略需要不同的依赖包。
                </p>

                {/* Live status panel */}
                {indexStatusLoading ? (
                  <div className="flex items-center gap-2 p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                    <span className="text-[13px] text-[var(--color-text-muted)]">检测依赖中...</span>
                  </div>
                ) : indexStatus && (
                  <div className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] font-medium text-[var(--color-text)]">依赖检测结果</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-accent)]/15 text-[var(--color-accent)]">
                        推荐: {indexStatus.recommended === "none" ? "无索引" : indexStatus.recommended === "repomap" ? "Repo Map" : "向量检索"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {indexStatus.available.map((s) => (
                        <div key={s.type} className="flex items-center gap-2 text-[12px]">
                          {s.ready ? (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] opacity-40 shrink-0" />
                          )}
                          <span className={s.ready ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>
                            {s.type === "none" ? "无索引" : s.type === "repomap" ? "Repo Map" : "向量检索"}
                          </span>
                          {s.ready ? (
                            <span className="text-emerald-400">可用</span>
                          ) : (
                            <span className="text-[var(--color-text-muted)]">
                              缺少: {s.missing.join(", ")}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <fieldset className="space-y-3">
                  <legend className="text-sm text-[var(--color-text)]">索引策略</legend>
                  {([
                    { value: "" as const, label: "自动推荐", desc: "根据已安装的依赖自动选择最优策略。优先 Repo Map，其次向量检索，都不可用时回退到运行时探索。" },
                    { value: "none" as const, label: "无索引（运行时探索）", desc: "不建索引，依赖 ripgrep 实时搜索。零依赖，适合小项目。" },
                    { value: "repomap" as const, label: "Repo Map（AST + PageRank）", desc: "使用 Tree-sitter 解析 AST 提取符号，PageRank 排序重要度。适合中大型项目。" },
                    { value: "vector" as const, label: "向量检索（语义搜索）", desc: "使用本地嵌入模型生成向量，LanceDB 存储。支持语义级搜索，适合超大仓库。" },
                  ]).map((opt) => {
                    const available = opt.value === "" || opt.value === "none" || indexStatus?.available.find((a) => a.type === opt.value)?.ready;
                    return (
                      <label
                        key={opt.value || "auto"}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          (config.codeIndexStrategy ?? "") === opt.value
                            ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5"
                            : "border-[var(--color-border)] hover:border-[var(--color-accent)]/50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="codeIndexStrategy"
                          checked={(config.codeIndexStrategy ?? "") === opt.value}
                          onChange={() => {
                            if (!config) return;
                            setConfig({
                              ...config,
                              codeIndexStrategy: opt.value === "" ? undefined : opt.value as "none" | "repomap" | "vector",
                            });
                          }}
                          className="mt-0.5 border-[var(--color-border)]"
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[var(--color-text)]">{opt.label}</span>
                            {opt.value !== "" && opt.value !== "none" && (
                              available ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">可用</span>
                              ) : (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400">缺少依赖</span>
                              )
                            )}
                          </div>
                          <div className="text-[12px] text-[var(--color-text-muted)] mt-0.5">{opt.desc}</div>
                        </div>
                      </label>
                    );
                  })}
                </fieldset>
                <p className="text-xs text-[var(--color-text-muted)]">
                  保存后生效。如果选择的策略缺少依赖，系统会自动回退到"无索引"模式。索引会在 Agent 首次访问项目时自动构建，也可以在对话界面手动触发。
                </p>
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
                    const hasFailed = status && !status.connected;
                    const isExpanded = mcpExpanded.has(server.name);
                    const hasTools = status?.connected && status.tools && status.tools.length > 0;
                    return (
                      <div
                        key={server.name}
                        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
                      >
                        <div className="flex items-start justify-between gap-3 p-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-[var(--color-text)]">{server.name}</span>
                              {status?.connected ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setMcpExpanded((prev) => {
                                      const next = new Set(prev);
                                      next.has(server.name) ? next.delete(server.name) : next.add(server.name);
                                      return next;
                                    });
                                  }}
                                  className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border-none cursor-pointer hover:bg-emerald-500/25 transition-colors"
                                >
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                  {status.toolCount} tool{status.toolCount !== 1 ? "s" : ""}
                                  <svg
                                    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                                    className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                  >
                                    <polyline points="6 9 12 15 18 9" />
                                  </svg>
                                </button>
                              ) : hasFailed ? (
                                <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400">
                                  <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                                  连接失败
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400">
                                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
                                  未连接
                                </span>
                              )}
                            </div>
                            <p className="m-0 mt-1 text-[12px] text-[var(--color-text-muted)] font-mono">
                              {server.transport === "streamablehttp"
                                ? server.url
                                : `${server.command} ${server.args.join(" ")}`}
                            </p>
                            {hasFailed && status.error && (
                              <p className="m-0 mt-1 text-[12px] text-red-400 break-all">
                                {status.error}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleRestartMcpServer(server.name)}
                              disabled={mcpRestarting === server.name}
                              className="px-2 py-1 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] border border-transparent hover:border-[var(--color-border)] rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="重启"
                            >
                              {mcpRestarting === server.name ? (
                                <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                </svg>
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 2v6h-6" />
                                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                                  <path d="M3 22v-6h6" />
                                  <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                                </svg>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveMcpServer(server.name)}
                              className="px-2 py-1 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-error-text)] border border-transparent hover:border-[var(--color-border)] rounded transition-colors"
                            >
                              删除
                            </button>
                          </div>
                        </div>
                        {isExpanded && hasTools && (
                          <div className="px-3 pb-3 pt-0">
                            <div className="flex flex-col gap-1 p-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)]">
                              {status.tools!.map((t) => (
                                <div key={t.name} className="flex items-center gap-2 text-[12px] min-w-0" title={t.description || undefined}>
                                  <code className="shrink-0 px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-mono text-[11px]">
                                    {t.name}
                                  </code>
                                  {t.description && (
                                    <span className="text-[var(--color-text-muted)] truncate">
                                      {t.description}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {showMcpForm ? (
                  <div className="space-y-3 p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        {(["stdio", "streamablehttp"] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setMcpTransport(t)}
                            className={`px-3 py-1 rounded text-xs border transition-colors ${mcpTransport === t ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]" : "bg-transparent border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"}`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      <label className="block text-sm text-[var(--color-text)]">
                        名称
                        <input
                          type="text"
                          value={mcpName}
                          onChange={(e) => setMcpName(e.target.value)}
                          placeholder="如: context7"
                          className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                        />
                      </label>
                      {mcpTransport === "streamablehttp" ? (
                        <>
                          <label className="block text-sm text-[var(--color-text)]">
                            URL
                            <input
                              type="text"
                              value={mcpUrl}
                              onChange={(e) => setMcpUrl(e.target.value)}
                              placeholder="如: https://mcp.example.com"
                              className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                            />
                          </label>
                          <label className="block text-sm text-[var(--color-text)]">
                            Headers（每行一条，Key: Value 格式）
                            <textarea
                              value={mcpHeaders}
                              onChange={(e) => setMcpHeaders(e.target.value)}
                              placeholder={"如: Authorization: Bearer YOUR_TOKEN"}
                              rows={3}
                              className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm font-mono resize-none"
                            />
                          </label>
                        </>
                      ) : (
                        <>
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
                              placeholder="如: -y @upstash/context7-mcp"
                              className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                            />
                          </label>
                          <label className="block text-sm text-[var(--color-text)]">
                            环境变量（空格分隔，KEY=VALUE 格式）
                            <input
                              type="text"
                              value={mcpEnv}
                              onChange={(e) => setMcpEnv(e.target.value)}
                              placeholder="如: API_KEY=sk-xxx"
                              className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                            />
                          </label>
                        </>
                      )}
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
                        onClick={() => { setShowMcpForm(false); setMcpName(""); setMcpCommand(""); setMcpArgs(""); setMcpEnv(""); setMcpUrl(""); setMcpHeaders(""); }}
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
                            onClick={() => setDeleteSkillTarget(s.name)}
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
            {activeSection === "approval" && (
              <section aria-labelledby="approval-heading" className="space-y-4">
                <h2 id="approval-heading" className="text-base font-semibold text-[var(--color-text)] m-0">
                  审批规则
                </h2>
                <p className="text-[13px] text-[var(--color-text-muted)]">
                  配置团队模式下需要人工审批的命令或文件操作模式。匹配规则的操作将在执行前弹出审批确认。
                </p>

                <div className="flex flex-col gap-2">
                  {(config.approvalRules ?? []).map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-start justify-between gap-3 p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-[var(--color-text)]">{rule.name}</span>
                          {rule.id.startsWith("builtin_") && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]">内置</span>
                          )}
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]">
                            {rule.operationType}
                          </span>
                        </div>
                        <p className="m-0 mt-1 text-[12px] text-[var(--color-text-muted)] font-mono break-all">
                          {rule.pattern}
                        </p>
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setConfig((prev) => {
                              if (!prev) return prev;
                              const rules = (prev.approvalRules ?? []).map((r) =>
                                r.id === rule.id ? { ...r, enabled: !r.enabled } : r
                              );
                              return { ...prev, approvalRules: rules };
                            });
                          }}
                          className={`px-2 py-1 text-[12px] rounded border transition-colors ${
                            rule.enabled
                              ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                              : "bg-transparent text-[var(--color-text-muted)] border-[var(--color-border)]"
                          }`}
                        >
                          {rule.enabled ? "启用" : "禁用"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingRuleId(rule.id);
                            setRuleName(rule.name);
                            setRulePattern(rule.pattern);
                            setRuleOpType(rule.operationType);
                            setRuleEnabled(rule.enabled);
                            setRulePatternError(null);
                            setShowApprovalForm(true);
                          }}
                          className="px-2 py-1 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] border border-transparent hover:border-[var(--color-border)] rounded transition-colors"
                        >
                          编辑
                        </button>
                        {!rule.id.startsWith("builtin_") && (
                          <button
                            type="button"
                            onClick={() => {
                              setConfig((prev) => {
                                if (!prev) return prev;
                                return { ...prev, approvalRules: (prev.approvalRules ?? []).filter((r) => r.id !== rule.id) };
                              });
                            }}
                            className="px-2 py-1 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-error-text)] border border-transparent hover:border-[var(--color-border)] rounded transition-colors"
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {showApprovalForm ? (
                  <div className="space-y-3 p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                    <label className="block text-sm text-[var(--color-text)]">
                      规则名称
                      <input
                        type="text"
                        value={ruleName}
                        onChange={(e) => setRuleName(e.target.value)}
                        placeholder="如: 禁止删除生产数据库"
                        className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                      />
                    </label>
                    <label className="block text-sm text-[var(--color-text)]">
                      正则表达式
                      <input
                        type="text"
                        value={rulePattern}
                        onChange={(e) => {
                          setRulePattern(e.target.value);
                          try {
                            new RegExp(e.target.value);
                            setRulePatternError(null);
                          } catch (err) {
                            setRulePatternError(err instanceof Error ? err.message : "无效正则");
                          }
                        }}
                        placeholder="如: DROP\s+(TABLE|DATABASE)"
                        className={`mt-1 w-full px-3 py-2 rounded-lg border bg-[var(--color-surface)] text-[var(--color-text)] text-sm font-mono ${
                          rulePatternError ? "border-red-500" : "border-[var(--color-border)]"
                        }`}
                      />
                      {rulePatternError && (
                        <p className="mt-1 text-xs text-red-400">{rulePatternError}</p>
                      )}
                    </label>
                    <label className="block text-sm text-[var(--color-text)]">
                      操作类型
                      <select
                        value={ruleOpType}
                        onChange={(e) => setRuleOpType(e.target.value as ApprovalRule["operationType"])}
                        className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-sm"
                      >
                        <option value="run_command">run_command（执行命令）</option>
                        <option value="write_file">write_file（写入文件）</option>
                        <option value="edit_file">edit_file（编辑文件）</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--color-text)]">
                      <input
                        type="checkbox"
                        checked={ruleEnabled}
                        onChange={(e) => setRuleEnabled(e.target.checked)}
                        className="border-[var(--color-border)]"
                      />
                      <span>启用</span>
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={!ruleName.trim() || !rulePattern.trim() || !!rulePatternError}
                        onClick={() => {
                          const newRule: ApprovalRule = {
                            id: editingRuleId ?? `rule_${Date.now()}`,
                            name: ruleName.trim(),
                            pattern: rulePattern.trim(),
                            operationType: ruleOpType,
                            enabled: ruleEnabled,
                          };
                          setConfig((prev) => {
                            if (!prev) return prev;
                            const existing = prev.approvalRules ?? [];
                            if (editingRuleId) {
                              return { ...prev, approvalRules: existing.map((r) => r.id === editingRuleId ? newRule : r) };
                            }
                            return { ...prev, approvalRules: [...existing, newRule] };
                          });
                          setShowApprovalForm(false);
                          setEditingRuleId(null);
                          setRuleName("");
                          setRulePattern("");
                          setRuleOpType("run_command");
                          setRuleEnabled(true);
                          setRulePatternError(null);
                        }}
                        className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium border-none cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed hover:bg-[var(--color-accent-hover)] transition-colors"
                      >
                        {editingRuleId ? "保存修改" : "添加"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowApprovalForm(false);
                          setEditingRuleId(null);
                          setRuleName("");
                          setRulePattern("");
                          setRuleOpType("run_command");
                          setRuleEnabled(true);
                          setRulePatternError(null);
                        }}
                        className="px-4 py-2 rounded-lg bg-transparent border border-[var(--color-border)] text-[var(--color-text)] text-sm cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingRuleId(null);
                      setRuleName("");
                      setRulePattern("");
                      setRuleOpType("run_command");
                      setRuleEnabled(true);
                      setRulePatternError(null);
                      setShowApprovalForm(true);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] text-sm cursor-pointer hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    添加审批规则
                  </button>
                )}
              </section>
            )}
            {activeSection === "claudeCode" && (
              <section aria-labelledby="claudecode-heading" className="space-y-4">
                <h2 id="claudecode-heading" className="text-base font-semibold text-[var(--color-text)] m-0">
                  Claude Code
                </h2>
                <p className="text-[13px] text-[var(--color-text-muted)]">
                  集成 Claude Code Agent SDK，让 Agent 拥有强大的自主编码能力（文件编辑、终端执行、代码搜索等）。需要安装 <code>@anthropic-ai/claude-agent-sdk</code>。
                </p>

                <fieldset className="space-y-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={config.claudeCode?.enabled ?? false}
                      onChange={(e) => setConfig({ ...config, claudeCode: { ...config.claudeCode, enabled: e.target.checked } })}
                      className="border-[var(--color-border)]"
                    />
                    <div>
                      <span className="text-sm font-medium text-[var(--color-text)]">启用 Claude Code 能力</span>
                      <p className="text-xs text-[var(--color-text-muted)] m-0 mt-0.5">
                        全局开关。关闭后所有 Agent（包括 Team 模式子 Agent）都无法使用 Claude Code。
                      </p>
                    </div>
                  </label>
                </fieldset>

                {(config.claudeCode?.enabled) && (
                  <div className="space-y-3 pl-1">
                    <div className="space-y-2">
                      <label className="flex flex-col gap-1 text-sm text-[var(--color-text)]">
                        <span>模型</span>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            placeholder="默认（Sonnet）"
                            value={config.claudeCode?.model ?? ""}
                            onChange={(e) => setConfig({
                              ...config,
                              claudeCode: { ...config.claudeCode, enabled: true, model: e.target.value || undefined }
                            })}
                            className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] w-48"
                          />
                          <DropdownMenu.Root modal={false}>
                            <DropdownMenu.Trigger asChild>
                              <button
                                type="button"
                                className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] text-sm shrink-0 flex items-center gap-1 hover:bg-[var(--color-bg-secondary)]"
                              >
                                预设
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                              </button>
                            </DropdownMenu.Trigger>
                              <DropdownMenu.Content
                                side="bottom"
                                sideOffset={4}
                                align="start"
                                className="min-w-[180px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-lg p-1.5 z-[100]"
                              >
                                {["sonnet", "opus", "haiku", "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"].map((m) => (
                                  <DropdownMenu.Item
                                    key={m}
                                    onSelect={() => setConfig({
                                      ...config,
                                      claudeCode: { ...config.claudeCode, enabled: true, model: m }
                                    })}
                                    className="w-full text-left px-3 py-2 rounded-md text-sm cursor-pointer outline-none hover:bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                                  >
                                    {m}
                                  </DropdownMenu.Item>
                                ))}
                              </DropdownMenu.Content>
                          </DropdownMenu.Root>
                          <button
                            type="button"
                            disabled={ccTesting}
                            onClick={async () => {
                              setCcTesting(true);
                              setCcTestResult(null);
                              try {
                                const result = await testClaudeCode(config.claudeCode?.model);
                                setCcTestResult(result);
                              } catch (err) {
                                setCcTestResult({ success: false, latencyMs: 0, error: String(err) });
                              } finally {
                                setCcTesting(false);
                              }
                            }}
                            className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] text-sm hover:bg-[var(--color-bg-secondary)] disabled:opacity-50 whitespace-nowrap"
                          >
                            {ccTesting ? "测试中..." : "测试连通性"}
                          </button>
                        </div>
                        <span className="text-xs text-[var(--color-text-muted)]">
                          选择预设或输入自定义 model ID，留空使用默认模型。
                        </span>
                      </label>
                      {ccTestResult && (
                        <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${ccTestResult.success ? "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-900/20 dark:text-green-400" : "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400"}`}>
                          <span>{ccTestResult.success ? "\u2713" : "\u2717"}</span>
                          <span>
                            {ccTestResult.success
                              ? `连接成功 — ${ccTestResult.model}, ${ccTestResult.latencyMs}ms`
                              : `连接失败 — ${ccTestResult.error}`
                            }
                          </span>
                        </div>
                      )}
                    </div>

                    <label className="flex flex-col gap-1 text-sm text-[var(--color-text)]">
                      <span>默认最大轮次</span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={config.claudeCode?.maxTurns ?? 15}
                        onChange={(e) => setConfig({
                          ...config,
                          claudeCode: { ...config.claudeCode, enabled: true, maxTurns: Math.max(1, parseInt(e.target.value, 10) || 15) }
                        })}
                        className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] w-32"
                      />
                      <span className="text-xs text-[var(--color-text-muted)]">Claude Code 执行的最大轮次（工具调用循环），默认 15</span>
                    </label>

                    <div className="space-y-2">
                      <span className="text-sm text-[var(--color-text)]">允许的工具</span>
                      <div className="grid grid-cols-3 gap-2">
                        {["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit"].map((t) => {
                          const current = config.claudeCode?.allowedTools ?? ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];
                          const checked = current.includes(t);
                          return (
                            <label key={t} className="flex items-center gap-2 cursor-pointer text-sm text-[var(--color-text)]">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  const next = checked ? current.filter(x => x !== t) : [...current, t];
                                  setConfig({
                                    ...config,
                                    claudeCode: { ...config.claudeCode, enabled: true, allowedTools: next }
                                  });
                                }}
                                className="border-[var(--color-border)]"
                              />
                              {t}
                            </label>
                          );
                        })}
                      </div>
                      <span className="text-xs text-[var(--color-text-muted)]">
                        选择 Claude Code 可以使用的工具。建议至少保留 Read 和 Edit。
                      </span>
                    </div>

                    <p className="text-xs text-[var(--color-text-muted)]">
                      提示：在 Team 模式中，每个子 Agent 还可以单独控制是否启用 Claude Code（在 Agent 管理面板中设置）。全局关闭时，所有子 Agent 的 Claude Code 能力都会被禁用。
                    </p>
                  </div>
                )}
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

    {/* Delete Skill Confirmation Dialog */}
    <AlertDialog.Root open={deleteSkillTarget !== null} onOpenChange={(open) => !open && setDeleteSkillTarget(null)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/60 z-[150] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <AlertDialog.Content className="fixed left-[50%] top-[50%] z-[151] max-h-[85vh] w-full max-w-md translate-x-[-50%] translate-y-[-50%] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <AlertDialog.Title className="text-lg font-semibold text-[var(--color-text)]">
            删除技能
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-[var(--color-text-muted)]">
            确定删除技能「{deleteSkillTarget}」？此操作无法撤销。
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <button className="px-4 py-2 rounded border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors">
                取消
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                onClick={() => deleteSkillTarget && handleDeleteSkill(deleteSkillTarget)}
                className="px-4 py-2 rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                删除
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
    </>
  );
}
