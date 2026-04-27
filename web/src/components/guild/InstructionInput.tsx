import { useEffect, useState } from "react";
import type { TaskPriority, TaskKind, PipelineTemplate } from "../../types/guild";
import { listPipelines } from "../../api/guild";
import Select from "./Select";
import PipelineEditorModal from "./PipelineEditorModal";
import Chevron from "./Chevron";

type Mode = "text" | "pipeline";

interface Props {
  onSubmit: (text: string, priority: TaskPriority, kind: TaskKind) => void;
  onSubmitPipeline?: (payload: {
    pipelineId: string;
    inputs: Record<string, string>;
    priority: TaskPriority;
    title?: string;
  }) => void;
  loading?: boolean;
  placeholder?: string;
  showPriority?: boolean;
  /** Current group context — used to filter the pipeline picker so users
   *  only see templates that belong here (plus globals). Templates created
   *  inline via the editor inherit this id by default. */
  currentGroupId?: string;
  /** All known groups, surfaced in the editor's group picker. */
  groups?: { id: string; name: string }[];
}

const PRIORITY_OPTIONS: Array<{ value: TaskPriority; label: string; icon: string }> = [
  { value: "low", label: "低", icon: "○" },
  { value: "medium", label: "中", icon: "◐" },
  { value: "high", label: "高", icon: "●" },
  { value: "urgent", label: "紧急", icon: "⚡" },
];

export default function InstructionInput({
  onSubmit, onSubmitPipeline, loading, placeholder, showPriority, currentGroupId, groups,
}: Props) {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [asRequirement, setAsRequirement] = useState(true);
  // Collapse the form to a one-line header so the user can hide it when
  // they're heads-down on watching tasks run. Persisted across sessions.
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try { return localStorage.getItem("guild.instructionCollapsed") === "1"; } catch { return false; }
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try { localStorage.setItem("guild.instructionCollapsed", v ? "1" : "0"); } catch {}
  };

  const [pipelines, setPipelines] = useState<PipelineTemplate[]>([]);
  const [pipelinesLoaded, setPipelinesLoaded] = useState(false);
  const [pipelineId, setPipelineId] = useState<string>("");
  const [pipelineInputs, setPipelineInputs] = useState<Record<string, string>>({});
  const [editorOpen, setEditorOpen] = useState(false);

  // Templates visible to *this* group: globals (no groupId) + ones explicitly
  // bound to currentGroupId. We compute it lazily off `pipelines` so changes
  // to currentGroupId don't trigger a network refetch.
  const visiblePipelines = pipelines.filter(
    (p) => !p.groupId || p.groupId === currentGroupId,
  );

  const reloadPipelines = () => {
    listPipelines()
      .then((tpls) => {
        setPipelines(tpls);
        const visible = tpls.filter((p) => !p.groupId || p.groupId === currentGroupId);
        if (visible.length > 0 && !visible.find((p) => p.id === pipelineId)) {
          setPipelineId(visible[0].id);
          setPipelineInputs(defaultInputs(visible[0]));
        } else if (visible.length === 0) {
          setPipelineId("");
          setPipelineInputs({});
        }
      })
      .catch(() => undefined)
      .finally(() => setPipelinesLoaded(true));
  };

  useEffect(() => {
    if (mode !== "pipeline" || pipelinesLoaded) return;
    reloadPipelines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pipelinesLoaded]);

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId) ?? null;

  // When the active group changes (or pipelines are loaded with a stale
  // pipelineId from a previous group), reset to the first visible template
  // so the user doesn't see "selected: <something hidden>" weirdness.
  useEffect(() => {
    if (!pipelinesLoaded) return;
    if (selectedPipeline && (!selectedPipeline.groupId || selectedPipeline.groupId === currentGroupId)) return;
    if (visiblePipelines.length > 0) {
      setPipelineId(visiblePipelines[0].id);
      setPipelineInputs(defaultInputs(visiblePipelines[0]));
    } else {
      setPipelineId("");
      setPipelineInputs({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGroupId, pipelinesLoaded, pipelines]);

  const handleSelectPipeline = (id: string) => {
    setPipelineId(id);
    const tpl = pipelines.find((p) => p.id === id);
    if (tpl) setPipelineInputs(defaultInputs(tpl));
  };

  const handleSend = () => {
    if (loading) return;
    if (mode === "text") {
      const trimmed = text.trim();
      if (!trimmed) return;
      onSubmit(trimmed, priority, asRequirement ? "requirement" : "adhoc");
      setText("");
      return;
    }
    if (!onSubmitPipeline || !selectedPipeline) return;
    const missing = missingRequired(selectedPipeline, pipelineInputs);
    if (missing.length > 0) return;
    onSubmitPipeline({
      pipelineId: selectedPipeline.id,
      inputs: pipelineInputs,
      priority,
      title: text.trim() || undefined,
    });
    setText("");
    setPipelineInputs(defaultInputs(selectedPipeline));
  };

  const pipelineMissing = selectedPipeline ? missingRequired(selectedPipeline, pipelineInputs) : [];
  const pipelineSendDisabled = loading || !selectedPipeline || pipelineMissing.length > 0;
  // Surface the disabled reason as a string the button title + an inline
  // hint can both reuse — without this users see a greyed button and don't
  // know whether it's loading, no template, or a missing required input.
  const pipelineDisabledReason = (() => {
    if (loading) return "正在创建…";
    if (!selectedPipeline) return "请先选择一个流水线模板";
    if (pipelineMissing.length === 0) return "";
    const labels = pipelineMissing.map((name) => {
      const spec = selectedPipeline.inputs?.find((i) => i.name === name);
      return spec?.label ?? name;
    });
    return `缺少必填项：${labels.join("、")}`;
  })();

  return (
    <div
      className="flex flex-col gap-2 p-3 border-t"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="flex items-center gap-1 text-[11px]">
        <ModeTab active={mode === "text"} onClick={() => setMode("text")}>指令</ModeTab>
        {onSubmitPipeline && (
          <ModeTab active={mode === "pipeline"} onClick={() => setMode("pipeline")}>流水线模板</ModeTab>
        )}
        <div className="flex-1" />
        {!collapsed && mode === "pipeline" && onSubmitPipeline && (
          <button
            className="text-[11px] px-2 py-1 rounded"
            style={{ border: "1px solid var(--color-border)", color: "var(--color-text-muted)" }}
            onClick={() => setEditorOpen(true)}
          >
            管理流水线模板
          </button>
        )}
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-1 rounded hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          style={{ color: "var(--color-text-muted)" }}
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? "展开输入区" : "收起输入区"}
          aria-label={collapsed ? "展开输入区" : "收起输入区"}
          aria-expanded={!collapsed}
        >
          <Chevron direction={collapsed ? "up" : "down"} size={12} />
          {collapsed ? "展开" : "收起"}
        </button>
      </div>
      <PipelineEditorModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onChange={reloadPipelines}
        currentGroupId={currentGroupId}
        groups={groups}
      />

      {!collapsed && (<>
      {mode === "pipeline" && (
        <div className="flex flex-col gap-2">
          {visiblePipelines.length === 0 && pipelinesLoaded ? (
            <div className="text-[11px] px-2 py-1 rounded" style={{ color: "var(--color-text-muted)", background: "var(--color-bg)" }}>
              {pipelines.length === 0
                ? "暂无流水线模板。将 JSON 放到 data/guild/pipelines/ 或点「管理流水线模板」新建。"
                : "当前小组没有可用的流水线模板（共有 " + pipelines.length + " 个，但都属于其他小组）。点「管理流水线模板」新建或调整归属。"}
            </div>
          ) : (
            <>
              <Select<string>
                value={pipelineId}
                onChange={handleSelectPipeline}
                disabled={loading}
                title="选择流水线模板"
                leadingLabel="模板"
                options={visiblePipelines.map((p) => ({
                  value: p.id,
                  // Globals get a 🌐 prefix so users can tell at a glance which
                  // templates are this-group-only vs cross-group.
                  label: <span>{!p.groupId ? "🌐 " : ""}{p.name}</span>,
                }))}
              />
              {selectedPipeline?.description && (
                <div className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                  {selectedPipeline.description}（{selectedPipeline.steps.length} 步）
                </div>
              )}
              {selectedPipeline?.inputs?.map((spec) => {
                // Highlight missing required inputs with a red border so the
                // user can locate the field that's blocking submission without
                // having to scan the asterisks. Calmer style once filled.
                const isMissing = pipelineMissing.includes(spec.name);
                return (
                  <label key={spec.name} className="flex flex-col gap-1 text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                    <span>
                      {spec.label ?? spec.name}
                      {spec.required && <span style={{ color: "var(--color-accent)" }}> *</span>}
                      {isMissing && (
                        <span className="ml-1 text-[10px]" style={{ color: "var(--color-error-text, #dc2626)" }}>必填</span>
                      )}
                    </span>
                    <input
                      className="px-2 py-1 rounded text-sm"
                      style={{
                        background: "var(--color-bg)",
                        border: `1px solid ${isMissing ? "#dc2626" : "var(--color-border)"}`,
                        color: "var(--color-text)",
                      }}
                      value={pipelineInputs[spec.name] ?? ""}
                      onChange={(e) => setPipelineInputs({ ...pipelineInputs, [spec.name]: e.target.value })}
                      placeholder={spec.default ?? ""}
                      disabled={loading}
                    />
                  </label>
                );
              })}
            </>
          )}
        </div>
      )}

      <textarea
        className="w-full px-3 py-2 rounded-lg text-sm resize-y"
        style={{
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text)",
          minHeight: mode === "pipeline" ? 48 : 72,
          maxHeight: 200,
        }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          mode === "pipeline"
            ? "可选：自定义任务标题（留空则使用流水线模板名）"
            : placeholder ?? "输入指令创建任务…（Shift+Enter 换行，Enter 发送）"
        }
        rows={mode === "pipeline" ? 2 : 3}
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
        {mode === "text" && (
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
        )}
        <div className="flex-1" />
        {mode === "pipeline" && pipelineSendDisabled && pipelineDisabledReason && (
          <span className="text-[11px]" style={{ color: "#dc2626" }}>
            ⚠ {pipelineDisabledReason}
          </span>
        )}
        <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
          {text.length > 0 ? `${text.length} 字` : ""}
        </span>
        <button
          className="px-4 py-1.5 rounded-lg text-sm text-white shrink-0 transition-colors disabled:cursor-not-allowed"
          style={{
            background:
              (mode === "text" ? loading || !text.trim() : pipelineSendDisabled)
                ? "var(--color-text-muted)"
                : "var(--color-accent)",
          }}
          onClick={handleSend}
          disabled={mode === "text" ? loading || !text.trim() : pipelineSendDisabled}
          title={
            mode === "pipeline"
              ? (pipelineSendDisabled ? pipelineDisabledReason : "按当前模板和参数创建任务")
              : (loading ? "正在发送…" : !text.trim() ? "请输入指令" : "发送指令")
          }
        >
          {loading ? "发送中…" : mode === "pipeline" ? "按流水线模板创建" : "发送"}
        </button>
      </div>
      </>)}
    </div>
  );
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 rounded"
      style={{
        background: active ? "var(--color-accent-alpha)" : "transparent",
        color: active ? "var(--color-accent)" : "var(--color-text-muted)",
        border: "1px solid var(--color-border)",
      }}
    >
      {children}
    </button>
  );
}

function defaultInputs(tpl: PipelineTemplate): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of tpl.inputs ?? []) {
    if (spec.default !== undefined) out[spec.name] = spec.default;
  }
  return out;
}

function missingRequired(tpl: PipelineTemplate, inputs: Record<string, string>): string[] {
  const missing: string[] = [];
  for (const spec of tpl.inputs ?? []) {
    if (!spec.required) continue;
    const v = inputs[spec.name];
    if (!v || v.trim() === "") missing.push(spec.name);
  }
  return missing;
}
