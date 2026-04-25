import { useEffect, useRef, useState } from "react";
import type { PipelineTemplate, PipelineStepSpec, PipelineInputSpec, PipelineRetryPolicy, PipelineStepKind, PipelineArtifactSpec, PipelineArtifactKind, AcceptanceAssertion } from "../../types/guild";
import {
  listPipelines,
  createPipeline,
  updatePipeline,
  deletePipeline,
} from "../../api/guild";
import PipelineCanvas from "./PipelineCanvas";
import ConfirmDialog from "./ConfirmDialog";
import AIPipelineDesignerModal from "./AIPipelineDesignerModal";
import { trapTabInDialog } from "../../lib/guildErrors";

interface Props {
  open: boolean;
  onClose: () => void;
  onChange?: () => void;
}

type Draft = PipelineTemplate;

const BLANK: Draft = { id: "", name: "", description: "", inputs: [], steps: [] };

export default function PipelineEditorModal({ open, onClose, onChange }: Props) {
  const [list, setList] = useState<PipelineTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "canvas" | "json">("list");
  const [copied, setCopied] = useState<"ok" | "err" | null>(null);
  const [canvasSelected, setCanvasSelected] = useState<number | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const refresh = async () => {
    try {
      const tpls = await listPipelines();
      setList(tpls);
      if (selectedId) {
        const match = tpls.find((t) => t.id === selectedId);
        if (match) setDraft(clone(match));
      }
    } catch (e) {
      setError(`加载失败: ${e}`);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setCopied(null);
  }, [view, selectedId, isNew]);

  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  if (!open) return null;

  const openExisting = (tpl: PipelineTemplate) => {
    setSelectedId(tpl.id);
    setDraft(clone(tpl));
    setIsNew(false);
    setError(null);
    setCanvasSelected(null);
  };

  const openNew = () => {
    setSelectedId(null);
    setDraft({ ...BLANK, steps: [{ title: "", description: "", dependsOn: [] }] });
    setIsNew(true);
    setError(null);
    setCanvasSelected(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (isNew) await createPipeline(draft);
      else if (selectedId) await updatePipeline(selectedId, draft);
      await refresh();
      setSelectedId(draft.id);
      setIsNew(false);
      onChange?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!selectedId) return;
    setConfirmingRemove(true);
  };

  const doRemove = async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      await deletePipeline(selectedId);
      // Dialog closes as soon as the delete call succeeds so the user sees
      // success immediately. Any follow-up (refresh / onChange) that throws
      // surfaces via setError but can't leave the dialog stuck in "处理中…".
      setConfirmingRemove(false);
      setSelectedId(null);
      setDraft(BLANK);
      setCanvasSelected(null);
      try {
        await refresh();
      } catch (e) {
        setError(`删除成功但刷新失败: ${e}`);
      }
      onChange?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pipeline 编辑器"
        onKeyDown={trapTabInDialog}
        className="rounded-xl overflow-hidden flex"
        style={{
          width: "min(1080px, 92vw)",
          height: "min(720px, 88vh)",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: list */}
        <div
          className="w-56 flex flex-col border-r"
          style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}
        >
          {/* AI generator slot — visually set apart so it doesn't read as a
              sibling of "+ 新建" (which it was mistakenly doing in a way that
              invited miss-clicks). */}
          <button
            className="mx-2 mt-2 mb-1 px-2 py-2 rounded-lg text-xs flex items-center justify-between"
            style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)", border: "1px solid var(--color-accent)" }}
            onClick={() => setAiOpen(true)}
            title="用 AI 描述一句话，自动生成模板 + 配套 Agent"
          >
            <span className="flex flex-col items-start leading-tight">
              <span className="flex items-center gap-1 font-semibold">✨ 用 AI 生成模板</span>
              <span className="text-[10px]" style={{ opacity: 0.75 }}>一句话生成流水线</span>
            </span>
            <span aria-hidden="true">→</span>
          </button>
          <div className="px-3 py-2 text-sm font-medium flex items-center justify-between gap-1 border-t" style={{ color: "var(--color-text)", borderColor: "var(--color-border)" }}>
            <span>手工模板</span>
            <button
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: "var(--color-accent)", color: "white" }}
              onClick={openNew}
            >
              + 新建
            </button>
          </div>
          <div className="flex-1 overflow-y-auto text-sm">
            {list.length === 0 && (
              <div className="px-3 py-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                暂无模板
              </div>
            )}
            {list.map((t) => (
              <button
                key={t.id}
                onClick={() => openExisting(t)}
                className="w-full text-left px-3 py-2 border-b"
                style={{
                  borderColor: "var(--color-border)",
                  background: selectedId === t.id && !isNew ? "var(--color-accent-alpha)" : "transparent",
                  color: selectedId === t.id && !isNew ? "var(--color-accent)" : "var(--color-text)",
                }}
              >
                <div className="truncate">{t.name}</div>
                <div className="text-[10px] truncate" style={{ color: "var(--color-text-muted)" }}>
                  {t.id} · {t.steps.length} 步
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: editor */}
        <div className="flex-1 flex flex-col min-w-0">
          <div
            className="px-4 py-2 flex items-center justify-between border-b text-sm"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
          >
            <span>{isNew ? "新建模板" : selectedId ? `编辑 ${selectedId}` : "选择模板或新建"}</span>
            <div className="flex items-center gap-2">
              {(isNew || selectedId) && (
                <div className="flex text-xs rounded overflow-hidden" style={{ border: "1px solid var(--color-border)" }}>
                  <button
                    onClick={() => setView("list")}
                    className="px-2 py-0.5"
                    style={{
                      background: view === "list" ? "var(--color-accent)" : "transparent",
                      color: view === "list" ? "white" : "var(--color-text-muted)",
                    }}
                  >列表</button>
                  <button
                    onClick={() => setView("canvas")}
                    className="px-2 py-0.5"
                    style={{
                      background: view === "canvas" ? "var(--color-accent)" : "transparent",
                      color: view === "canvas" ? "white" : "var(--color-text-muted)",
                    }}
                  >画布</button>
                  <button
                    onClick={() => setView("json")}
                    className="px-2 py-0.5"
                    style={{
                      background: view === "json" ? "var(--color-accent)" : "transparent",
                      color: view === "json" ? "white" : "var(--color-text-muted)",
                      borderLeft: "1px solid var(--color-border)",
                    }}
                  >JSON</button>
                </div>
              )}
              <button onClick={onClose} className="text-lg leading-none px-2" style={{ color: "var(--color-text-muted)" }}>
                ✕
              </button>
            </div>
          </div>

          {!isNew && !selectedId ? (
            <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "var(--color-text-muted)" }}>
              从左侧选择一个模板编辑，或点击「新建」
            </div>
          ) : view === "json" ? (
            <div className="flex-1 flex flex-col min-h-0" style={{ background: "var(--color-bg)" }}>
              <div
                className="px-3 py-2 flex items-center justify-between border-b text-xs"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
              >
                <span>只读预览 · 保存后将写入 {draft.id || "(未命名)"}.json</span>
                <button
                  onClick={async () => {
                    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
                    try {
                      await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
                      setCopied("ok");
                    } catch {
                      setCopied("err");
                    }
                    copyTimerRef.current = window.setTimeout(() => setCopied(null), 1800);
                  }}
                  className="px-2 py-0.5 rounded text-xs"
                  style={{
                    background:
                      copied === "ok" ? "#10b98122" : copied === "err" ? "#fee2e2" : "var(--color-surface)",
                    color:
                      copied === "ok" ? "#059669" : copied === "err" ? "#991b1b" : "var(--color-text)",
                    border: `1px solid ${copied === "ok" ? "#10b981" : copied === "err" ? "#fca5a5" : "var(--color-border)"}`,
                  }}
                >
                  {copied === "ok" ? "已复制" : copied === "err" ? "复制失败" : "复制"}
                </button>
              </div>
              <pre
                className="flex-1 overflow-auto p-4 text-xs font-mono leading-relaxed m-0"
                style={{ color: "var(--color-text)" }}
              >
                {JSON.stringify(draft, null, 2)}
              </pre>
            </div>
          ) : view === "canvas" ? (
            <div className="flex-1 flex min-h-0">
              <div className="flex-1 min-w-0" style={{ background: "var(--color-bg)" }}>
                <PipelineCanvas
                  key={selectedId ?? "__new__"}
                  steps={draft.steps}
                  selectedIndex={canvasSelected}
                  onSelect={setCanvasSelected}
                  onChangeSteps={(steps) => setDraft({ ...draft, steps })}
                  onAddStep={() => {
                    const next = [...draft.steps, { title: "", description: "", dependsOn: [] } as PipelineStepSpec];
                    setDraft({ ...draft, steps: next });
                    setCanvasSelected(next.length - 1);
                  }}
                />
              </div>
              <div
                className="w-[340px] flex flex-col border-l overflow-y-auto"
                style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
              >
                <div className="px-3 py-2 text-xs border-b" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>
                  {canvasSelected === null ? "选中节点以编辑" : `编辑 Step [${canvasSelected}]`}
                </div>
                {canvasSelected !== null && draft.steps[canvasSelected] && (
                  <div className="p-3">
                    <StepCard
                      step={draft.steps[canvasSelected]}
                      label={`Step [${canvasSelected}]`}
                      canMoveUp={canvasSelected > 0}
                      canMoveDown={canvasSelected < draft.steps.length - 1}
                      onMoveUp={() => {
                        moveStep(draft, setDraft, canvasSelected, -1);
                        setCanvasSelected(canvasSelected - 1);
                      }}
                      onMoveDown={() => {
                        moveStep(draft, setDraft, canvasSelected, 1);
                        setCanvasSelected(canvasSelected + 1);
                      }}
                      onRemove={() => {
                        removeStep(draft, setDraft, canvasSelected);
                        setCanvasSelected(null);
                      }}
                      onChange={(patch) => updateStep(draft, setDraft, canvasSelected, patch)}
                      showDependsOn={false}
                      flush
                    />
                  </div>
                )}
                {canvasSelected === null && (
                  <div className="p-4 text-xs leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
                    <div className="mb-2 font-medium" style={{ color: "var(--color-text)" }}>快捷操作</div>
                    <ul className="space-y-1.5 list-disc pl-4">
                      <li>点击节点 — 在此编辑</li>
                      <li>拖节点底部 ● 到另一节点顶部 ● — 建立依赖</li>
                      <li>选中连线按 Delete — 解除依赖</li>
                      <li>选中节点按 Delete — 删除步骤</li>
                      <li>右下角 + — 新建步骤</li>
                    </ul>
                  </div>
                )}
                {error && (
                  <div className="m-3 text-xs px-3 py-2 rounded" style={{ background: "#fee2e2", color: "#991b1b" }}>
                    {error}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 text-sm" style={{ color: "var(--color-text)" }}>
              {error && (
                <div className="text-xs px-3 py-2 rounded" style={{ background: "#fee2e2", color: "#991b1b" }}>
                  {error}
                </div>
              )}
              <Field label="ID（小写字母数字，用于文件名）">
                <input
                  className={inputCls}
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  disabled={!isNew}
                  placeholder="my-pipeline"
                />
              </Field>
              <Field label="名称">
                <input
                  className={inputCls}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field label="描述（可选）">
                <input
                  className={inputCls}
                  value={draft.description ?? ""}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </Field>

              <SectionHeader
                title="Inputs"
                hint="用户创建任务时填写，步骤里可用 ${name} 引用"
                onAdd={() =>
                  setDraft({
                    ...draft,
                    inputs: [...(draft.inputs ?? []), { name: "", required: false } as PipelineInputSpec],
                  })
                }
              />
              {(draft.inputs ?? []).length === 0 && (
                <div className="text-xs italic px-3 py-2 rounded" style={{ color: "var(--color-text-muted)", background: "var(--color-bg)", border: "1px dashed var(--color-border)" }}>
                  暂无输入参数
                </div>
              )}
              {(draft.inputs ?? []).map((inp, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-2 p-3 rounded-lg"
                  style={{ border: "1px solid var(--color-border)", background: "var(--color-bg)" }}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] px-1.5 py-0.5 rounded" style={{ background: "var(--color-border)", color: "var(--color-text-muted)" }}>
                      Input [{i}]
                    </span>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer" style={{ color: "var(--color-text-muted)" }}>
                        <input
                          type="checkbox"
                          checked={!!inp.required}
                          onChange={(e) => updateInput(draft, setDraft, i, { required: e.target.checked })}
                        />
                        必填
                      </label>
                      <button
                        className="w-6 h-6 rounded flex items-center justify-center text-xs"
                        title="删除此输入"
                        style={{ border: "1px solid #fca5a5", color: "#dc2626" }}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            inputs: (draft.inputs ?? []).filter((_, j) => j !== i),
                          })
                        }
                      >✕</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-2">
                    <Field label="name" hint="${name} 引用">
                      <input
                        className={inputCls}
                        placeholder="e.g. url"
                        value={inp.name}
                        onChange={(e) => updateInput(draft, setDraft, i, { name: e.target.value })}
                      />
                    </Field>
                    <Field label="label" hint="UI 显示名">
                      <input
                        className={inputCls}
                        placeholder="e.g. 目标网址"
                        value={inp.label ?? ""}
                        onChange={(e) => updateInput(draft, setDraft, i, { label: e.target.value })}
                      />
                    </Field>
                    <Field label="default" hint="默认值（可选）">
                      <input
                        className={inputCls}
                        placeholder="e.g. https://…"
                        value={inp.default ?? ""}
                        onChange={(e) => updateInput(draft, setDraft, i, { default: e.target.value })}
                      />
                    </Field>
                  </div>
                </div>
              ))}

              <OutputsEditor
                outputs={draft.outputs}
                onChange={(next) => setDraft({ ...draft, outputs: next })}
                forceFinal
                title="最终交付产物"
                hint="模板级产物自动视为 isFinal — pipeline 完成时会对账"
              />

              <SectionHeader
                title="Steps"
                hint="dependsOn 填前面 step 的下标（0 起）"
                onAdd={() =>
                  setDraft({
                    ...draft,
                    steps: [
                      ...draft.steps,
                      { title: "", description: "", dependsOn: [] } as PipelineStepSpec,
                    ],
                  })
                }
              />
              {draft.steps.map((step, i) => (
                <StepCard
                  key={i}
                  step={step}
                  label={`Step [${i}]`}
                  canMoveUp={i > 0}
                  canMoveDown={i < draft.steps.length - 1}
                  onMoveUp={() => moveStep(draft, setDraft, i, -1)}
                  onMoveDown={() => moveStep(draft, setDraft, i, 1)}
                  onRemove={() => removeStep(draft, setDraft, i)}
                  onChange={(patch) => updateStep(draft, setDraft, i, patch)}
                  showDependsOn
                />
              ))}
            </div>
          )}

          {(isNew || selectedId) && (
            <div
              className="px-4 py-2 border-t flex items-center gap-2"
              style={{ borderColor: "var(--color-border)" }}
            >
              {!isNew && (
                <button
                  className="px-3 py-1 rounded text-xs"
                  style={{ color: "#dc2626", border: "1px solid #dc2626" }}
                  onClick={remove}
                  disabled={saving}
                >
                  删除
                </button>
              )}
              <div className="flex-1" />
              <button
                className="px-3 py-1 rounded text-xs"
                style={{ border: "1px solid var(--color-border)", color: "var(--color-text-muted)" }}
                onClick={onClose}
              >
                取消
              </button>
              <button
                className="px-4 py-1 rounded text-xs text-white"
                style={{ background: saving ? "var(--color-text-muted)" : "var(--color-accent)" }}
                onClick={save}
                disabled={saving}
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={(o) => { if (!o && !saving) setConfirmingRemove(false); }}
        onConfirm={doRemove}
        title={`删除模板「${draft.name || "未命名"}」?`}
        description="删除后无法恢复。仍在使用该模板的任务不受影响，但新建任务时将找不到该模板。"
        confirmLabel="删除"
        variant="danger"
        loading={saving}
      />
      {aiOpen && (
        <AIPipelineDesignerModal
          onDone={async (templateId) => {
            setAiOpen(false);
            await refresh();
            const match = list.find((t) => t.id === templateId)
              ?? (await listPipelines()).find((t) => t.id === templateId);
            if (match) openExisting(match);
            onChange?.();
          }}
          onClose={() => setAiOpen(false)}
        />
      )}
    </div>
  );
}

const inputCls =
  "px-2 py-1 rounded text-sm w-full bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)]";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs min-w-0">
      <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0">
        <span className="whitespace-nowrap" style={{ color: "var(--color-text)", fontWeight: 500 }}>{label}</span>
        {hint && <span style={{ color: "var(--color-text-muted)" }} className="text-[10px]">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function SectionHeader({ title, hint, onAdd }: { title: string; hint?: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between mt-2">
      <div>
        <span className="text-sm font-medium" style={{ color: "var(--color-text)" }}>{title}</span>
        {hint && <span className="ml-2 text-xs" style={{ color: "var(--color-text-muted)" }}>{hint}</span>}
      </div>
      <button
        className="text-xs px-2 py-0.5 rounded"
        style={{ border: "1px solid var(--color-border)", color: "var(--color-text)" }}
        onClick={onAdd}
      >
        + 添加
      </button>
    </div>
  );
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

interface StepCardProps {
  step: PipelineStepSpec;
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onChange: (patch: Partial<PipelineStepSpec>) => void;
  showDependsOn?: boolean;
  flush?: boolean;
}

const KIND_META: Record<PipelineStepKind, { label: string; color: string; desc: string }> = {
  task: { label: "任务", color: "#3b82f6", desc: "单个可执行的步骤" },
  branch: { label: "分支", color: "#8b5cf6", desc: "按 when 条件走 then / else" },
  foreach: { label: "循环", color: "#f59e0b", desc: "遍历数组，body 多次展开" },
};

function StepCard({
  step,
  label,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemove,
  onChange,
  showDependsOn,
  flush,
}: StepCardProps) {
  const kind: PipelineStepKind = step.kind ?? "task";
  const [whenText, setWhenText] = useState(() =>
    step.when ? JSON.stringify(step.when, null, 2) : "",
  );
  const [whenErr, setWhenErr] = useState<string | null>(null);
  // Tracks the last `when` value we wrote — so we only resync whenText when
  // step.when changes from the outside (e.g. switching to a different step
  // card in the drawer), not when our own applyWhen just wrote it.
  const lastWroteWhenRef = useRef<unknown>(step.when);

  useEffect(() => {
    if (step.when !== lastWroteWhenRef.current) {
      setWhenText(step.when ? JSON.stringify(step.when, null, 2) : "");
      setWhenErr(null);
      lastWroteWhenRef.current = step.when;
    }
  }, [step.when]);

  const changeKind = (k: PipelineStepKind) => {
    const patch: Partial<PipelineStepSpec> = { kind: k };
    if (k !== "branch") {
      patch.when = undefined;
      patch.then = undefined;
      patch.else = undefined;
    }
    if (k !== "foreach") {
      patch.items = undefined;
      patch.as = undefined;
      patch.body = undefined;
      patch.join = undefined;
    }
    onChange(patch);
  };

  const applyWhen = (text: string) => {
    setWhenText(text);
    if (!text.trim()) {
      setWhenErr(null);
      lastWroteWhenRef.current = undefined;
      onChange({ when: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setWhenErr("必须是对象");
        return;
      }
      setWhenErr(null);
      lastWroteWhenRef.current = parsed;
      onChange({ when: parsed });
    } catch (e) {
      setWhenErr(String(e));
    }
  };

  const updateNestedList = (
    key: "then" | "else" | "body",
    idx: number,
    patch: Partial<PipelineStepSpec>,
  ) => {
    const list = [...((step[key] ?? []) as PipelineStepSpec[])];
    list[idx] = { ...list[idx], ...patch };
    onChange({ [key]: list } as Partial<PipelineStepSpec>);
  };
  const addNested = (key: "then" | "else" | "body") => {
    const list = [...((step[key] ?? []) as PipelineStepSpec[])];
    list.push({ title: "", description: "", dependsOn: [] });
    onChange({ [key]: list } as Partial<PipelineStepSpec>);
  };
  const removeNested = (key: "then" | "else" | "body", idx: number) => {
    const list = ((step[key] ?? []) as PipelineStepSpec[]).filter((_, j) => j !== idx);
    onChange({ [key]: list } as Partial<PipelineStepSpec>);
  };
  const moveNested = (key: "then" | "else" | "body", idx: number, delta: -1 | 1) => {
    const list = [...((step[key] ?? []) as PipelineStepSpec[])];
    const j = idx + delta;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    onChange({ [key]: list } as Partial<PipelineStepSpec>);
  };

  const meta = KIND_META[kind];
  const wrapperStyle: React.CSSProperties = flush
    ? { background: "transparent" }
    : {
        border: "1px solid var(--color-border)",
        background: "var(--color-bg)",
        borderLeft: `3px solid ${meta.color}`,
      };

  return (
    <div className="flex flex-col gap-3 p-3 rounded-lg" style={wrapperStyle}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[11px] px-1.5 py-0.5 rounded"
            style={{ background: `${meta.color}1A`, color: meta.color }}
          >{label}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            disabled={!canMoveUp}
            onClick={onMoveUp}
            className="w-6 h-6 rounded flex items-center justify-center text-xs"
            title="上移"
            style={{
              opacity: canMoveUp ? 1 : 0.3,
              border: "1px solid var(--color-border)",
              color: "var(--color-text-muted)",
            }}
          >↑</button>
          <button
            disabled={!canMoveDown}
            onClick={onMoveDown}
            className="w-6 h-6 rounded flex items-center justify-center text-xs"
            title="下移"
            style={{
              opacity: canMoveDown ? 1 : 0.3,
              border: "1px solid var(--color-border)",
              color: "var(--color-text-muted)",
            }}
          >↓</button>
          <button
            className="w-6 h-6 rounded flex items-center justify-center text-xs"
            title="删除此步骤"
            style={{ border: "1px solid #fca5a5", color: "#dc2626" }}
            onClick={onRemove}
          >✕</button>
        </div>
      </div>

      <Field label="类型" hint={meta.desc}>
        <KindTabs value={kind} onChange={changeKind} />
      </Field>

      <Field label="标题">
        <input
          className={inputCls}
          placeholder="简短命名，会作为子任务标题"
          value={step.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </Field>

      <Field label="描述" hint="支持 ${var} 变量插值，作为子任务描述传给 agent">
        <textarea
          className={inputCls}
          placeholder={kind === "branch" ? "说明此分支的判定逻辑" : "让 agent 知道要做什么"}
          rows={2}
          value={step.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Field>

      {kind === "task" && (
        <>
          <div className={flush ? "flex flex-col gap-3" : "grid grid-cols-2 gap-2"}>
            <Field label="建议技能" hint="逗号分隔；用于匹配 agent">
              <input
                className={inputCls}
                placeholder="e.g. playwright, markdown"
                value={(step.suggestedSkills ?? []).join(", ")}
                onChange={(e) =>
                  onChange({
                    suggestedSkills: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
            {showDependsOn && (
              <Field label="依赖步骤" hint="填前面 step 的下标，逗号分隔">
                <input
                  className={inputCls}
                  placeholder="0, 1"
                  value={(step.dependsOn ?? []).join(", ")}
                  onChange={(e) =>
                    onChange({
                      dependsOn: e.target.value
                        .split(",")
                        .map((s) => parseInt(s.trim(), 10))
                        .filter((n) => !Number.isNaN(n)),
                    })
                  }
                />
              </Field>
            )}
          </div>
          <Field label="验收标准（可选）" hint="agent 完成时用此判断（prose，供 agent 阅读）">
            <input
              className={inputCls}
              placeholder="e.g. 产出一份 markdown 报告，包含至少 5 个章节"
              value={step.acceptanceCriteria ?? ""}
              onChange={(e) => onChange({ acceptanceCriteria: e.target.value })}
            />
          </Field>
          <AssertionsEditor
            assertions={step.acceptanceAssertions}
            onChange={(next) => onChange({ acceptanceAssertions: next })}
          />
          <OutputsEditor
            outputs={step.outputs}
            onChange={(next) => onChange({ outputs: next })}
            title="产物声明（可选）"
            hint="此步骤期望产出的文件/URL/数据；勾选「终稿」让它 bubble 到 pipeline 最终产物"
          />
          <RetrySubEditor step={step} onChange={onChange} />
        </>
      )}

      {kind === "branch" && (
        <>
          {showDependsOn && (
            <Field label="依赖步骤" hint="分支入口的外部依赖">
              <input
                className={inputCls}
                placeholder="0, 1"
                value={(step.dependsOn ?? []).join(", ")}
                onChange={(e) =>
                  onChange({
                    dependsOn: e.target.value
                      .split(",")
                      .map((s) => parseInt(s.trim(), 10))
                      .filter((n) => !Number.isNaN(n)),
                  })
                }
              />
            </Field>
          )}
          <Field label="when 条件" hint='JSON 表达式，例：{"eq":["${format}","pdf"]}'>
            <textarea
              className={inputCls + " font-mono text-xs"}
              rows={3}
              value={whenText}
              onChange={(e) => applyWhen(e.target.value)}
              placeholder='{"eq":["${var}","value"]}'
            />
            {whenErr && <span className="text-xs" style={{ color: "#dc2626" }}>{whenErr}</span>}
          </Field>
          <NestedStepList
            title="then 分支"
            hint="when=true 时展开"
            accent="#10B981"
            steps={(step.then ?? []) as PipelineStepSpec[]}
            onAdd={() => addNested("then")}
            onRemove={(idx) => removeNested("then", idx)}
            onMoveUp={(idx) => moveNested("then", idx, -1)}
            onMoveDown={(idx) => moveNested("then", idx, 1)}
            onChange={(idx, patch) => updateNestedList("then", idx, patch)}
          />
          <NestedStepList
            title="else 分支"
            hint="when=false 时展开（可选）"
            accent="#9ca3af"
            steps={(step.else ?? []) as PipelineStepSpec[]}
            onAdd={() => addNested("else")}
            onRemove={(idx) => removeNested("else", idx)}
            onMoveUp={(idx) => moveNested("else", idx, -1)}
            onMoveDown={(idx) => moveNested("else", idx, 1)}
            onChange={(idx, patch) => updateNestedList("else", idx, patch)}
          />
        </>
      )}

      {kind === "foreach" && (
        <>
          {showDependsOn && (
            <Field label="依赖步骤" hint="循环的外部依赖">
              <input
                className={inputCls}
                placeholder="0, 1"
                value={(step.dependsOn ?? []).join(", ")}
                onChange={(e) =>
                  onChange({
                    dependsOn: e.target.value
                      .split(",")
                      .map((s) => parseInt(s.trim(), 10))
                      .filter((n) => !Number.isNaN(n)),
                  })
                }
              />
            </Field>
          )}
          <div className={flush ? "flex flex-col gap-3" : "grid grid-cols-[1fr_120px] gap-2"}>
            <Field label="items" hint="JSON 数组或逗号分隔；支持 ${var}">
              <input
                className={inputCls}
                placeholder="${kps}"
                value={step.items ?? ""}
                onChange={(e) => onChange({ items: e.target.value })}
              />
            </Field>
            <Field label="as" hint="循环变量名">
              <input
                className={inputCls}
                placeholder="item"
                value={step.as ?? ""}
                onChange={(e) => onChange({ as: e.target.value })}
              />
            </Field>
          </div>
          <NestedStepList
            title="body"
            hint="对每个元素重复展开"
            accent="#f59e0b"
            steps={(step.body ?? []) as PipelineStepSpec[]}
            onAdd={() => addNested("body")}
            onRemove={(idx) => removeNested("body", idx)}
            onMoveUp={(idx) => moveNested("body", idx, -1)}
            onMoveDown={(idx) => moveNested("body", idx, 1)}
            onChange={(idx, patch) => updateNestedList("body", idx, patch)}
          />
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-xs font-medium" style={{ color: "var(--color-text)" }}>join（可选）</span>
              <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>循环结束后的汇总步骤</span>
            </div>
            {step.join ? (
              <button
                className="text-xs px-2 py-1 rounded"
                style={{ border: "1px solid #fca5a5", color: "#dc2626" }}
                onClick={() => onChange({ join: undefined })}
              >移除 join</button>
            ) : (
              <button
                className="text-xs px-2 py-1 rounded"
                style={{ border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                onClick={() => onChange({ join: { title: "", description: "", dependsOn: [] } })}
              >+ 添加 join</button>
            )}
          </div>
          {step.join && (
            <StepCard
              step={step.join}
              label="join"
              canMoveUp={false}
              canMoveDown={false}
              onMoveUp={() => {}}
              onMoveDown={() => {}}
              onRemove={() => onChange({ join: undefined })}
              onChange={(patch) => onChange({ join: { ...step.join!, ...patch } })}
            />
          )}
        </>
      )}
    </div>
  );
}

function KindTabs({ value, onChange }: { value: PipelineStepKind; onChange: (k: PipelineStepKind) => void }) {
  const kinds: PipelineStepKind[] = ["task", "branch", "foreach"];
  return (
    <div className="inline-flex rounded overflow-hidden" style={{ border: "1px solid var(--color-border)" }}>
      {kinds.map((k) => {
        const m = KIND_META[k];
        const active = value === k;
        return (
          <button
            key={k}
            onClick={() => onChange(k)}
            className="px-2.5 py-1 text-xs flex items-center gap-1"
            style={{
              background: active ? `${m.color}1A` : "transparent",
              color: active ? m.color : "var(--color-text-muted)",
              borderRight: k !== "foreach" ? "1px solid var(--color-border)" : "none",
              fontWeight: active ? 600 : 400,
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.color, opacity: active ? 1 : 0.5 }} />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function NestedStepList({
  title,
  hint,
  accent = "var(--color-border)",
  steps,
  onAdd,
  onRemove,
  onMoveUp,
  onMoveDown,
  onChange,
}: {
  title: string;
  hint?: string;
  accent?: string;
  steps: PipelineStepSpec[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  onMoveUp: (idx: number) => void;
  onMoveDown: (idx: number) => void;
  onChange: (idx: number, patch: Partial<PipelineStepSpec>) => void;
}) {
  return (
    <div className="flex flex-col gap-2 pl-3" style={{ borderLeft: `2px solid ${accent}` }}>
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-xs font-medium" style={{ color: "var(--color-text)" }}>{title}</span>
          {hint && <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{hint}</span>}
        </div>
        <button
          className="text-xs px-2 py-0.5 rounded"
          style={{ border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          onClick={onAdd}
        >+ 添加</button>
      </div>
      {steps.length === 0 && (
        <div className="text-xs italic" style={{ color: "var(--color-text-muted)" }}>（空）</div>
      )}
      {steps.map((s, i) => (
        <StepCard
          key={i}
          step={s}
          label={`${title}[${i}]`}
          canMoveUp={i > 0}
          canMoveDown={i < steps.length - 1}
          onMoveUp={() => onMoveUp(i)}
          onMoveDown={() => onMoveDown(i)}
          onRemove={() => onRemove(i)}
          onChange={(patch) => onChange(i, patch)}
        />
      ))}
    </div>
  );
}

function RetrySubEditor({
  step,
  onChange,
}: {
  step: PipelineStepSpec;
  onChange: (patch: Partial<PipelineStepSpec>) => void;
}) {
  const r = step.retry;
  const enabled = !!r;
  const update = (patch: Partial<NonNullable<PipelineStepSpec["retry"]>>) => {
    onChange({ retry: { ...(r ?? { max: 1 }), ...patch } });
  };
  const fb = r?.fallback;
  const updateFb = (patch: Partial<PipelineStepSpec>) => {
    onChange({
      retry: {
        ...(r ?? { max: 1 }),
        fallback: { ...(fb ?? { title: "", description: "" }), ...patch },
      },
    });
  };
  const needsFallback = r?.onExhausted === "fallback";

  return (
    <div className="mt-1 flex flex-col gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ retry: e.target.checked ? { max: 2, onExhausted: "fail" } : undefined })}
        />
        <span>启用重试（retry）</span>
      </label>
      {enabled && r && (
        <div className="flex flex-col gap-2 pl-5">
          <div className="flex gap-2 items-center flex-wrap">
            <label className="flex items-center gap-1">
              <span>max</span>
              <input
                type="number"
                min={1}
                max={10}
                className={inputCls + " w-20"}
                value={r.max}
                onChange={(e) => update({ max: Math.min(10, Math.max(1, parseInt(e.target.value || "1", 10))) })}
              />
            </label>
            <label className="flex items-center gap-1">
              <span>backoffMs</span>
              <input
                type="number"
                min={0}
                className={inputCls + " w-24"}
                value={r.backoffMs ?? 0}
                onChange={(e) => update({ backoffMs: Math.max(0, parseInt(e.target.value || "0", 10)) })}
              />
            </label>
            <label className="flex items-center gap-1">
              <span>onExhausted</span>
              <select
                className={inputCls + " w-28"}
                value={r.onExhausted ?? "fail"}
                onChange={(e) => update({ onExhausted: e.target.value as PipelineRetryPolicy["onExhausted"] })}
              >
                <option value="fail">fail</option>
                <option value="skip">skip</option>
                <option value="fallback">fallback</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={!!r.preferSameAgent}
                onChange={(e) => update({ preferSameAgent: e.target.checked })}
              />
              <span>preferSameAgent</span>
            </label>
          </div>
          {needsFallback && (
            <div className="flex flex-col gap-1 p-2 rounded" style={{ border: "1px dashed var(--color-border)" }}>
              <div style={{ color: "var(--color-text)" }}>Fallback step</div>
              <input
                className={inputCls}
                placeholder="fallback.title"
                value={fb?.title ?? ""}
                onChange={(e) => updateFb({ title: e.target.value })}
              />
              <input
                className={inputCls}
                placeholder="fallback.description"
                value={fb?.description ?? ""}
                onChange={(e) => updateFb({ description: e.target.value })}
              />
              <input
                className={inputCls}
                placeholder="fallback.suggestedAgentId（可选，如 human-op）"
                value={fb?.suggestedAgentId ?? ""}
                onChange={(e) => updateFb({ suggestedAgentId: e.target.value })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function updateInput(draft: Draft, set: (d: Draft) => void, i: number, patch: Partial<PipelineInputSpec>) {
  const next = [...(draft.inputs ?? [])];
  next[i] = { ...next[i], ...patch };
  set({ ...draft, inputs: next });
}

function updateStep(draft: Draft, set: (d: Draft) => void, i: number, patch: Partial<PipelineStepSpec>) {
  const next = [...draft.steps];
  next[i] = { ...next[i], ...patch };
  set({ ...draft, steps: next });
}

function removeStep(draft: Draft, set: (d: Draft) => void, i: number) {
  const steps = draft.steps.filter((_, j) => j !== i);
  // fix up dependsOn references
  const fixed = steps.map((s, idx) => ({
    ...s,
    dependsOn: (s.dependsOn ?? [])
      .filter((d) => d !== i)
      .map((d) => (d > i ? d - 1 : d))
      .filter((d) => d < idx),
  }));
  set({ ...draft, steps: fixed });
}

function moveStep(draft: Draft, set: (d: Draft) => void, i: number, delta: -1 | 1) {
  const j = i + delta;
  if (j < 0 || j >= draft.steps.length) return;
  const steps = [...draft.steps];
  [steps[i], steps[j]] = [steps[j], steps[i]];
  // moving can break dependsOn — let validation on save catch it
  set({ ...draft, steps });
}

// ─── Outputs editor ───────────────────────────────────────────

const ARTIFACT_KINDS: PipelineArtifactKind[] = ["file", "url", "data", "commit"];

function OutputsEditor({
  outputs,
  onChange,
  /** When true, the outputs are pipeline-level — always final, no isFinal checkbox. */
  forceFinal,
  title = "产物 Outputs",
  hint,
}: {
  outputs: PipelineArtifactSpec[] | undefined;
  onChange: (next: PipelineArtifactSpec[] | undefined) => void;
  forceFinal?: boolean;
  title?: string;
  hint?: string;
}) {
  const list = outputs ?? [];
  const patch = (i: number, p: Partial<PipelineArtifactSpec>) => {
    const next = list.map((o, j) => (j === i ? { ...o, ...p } : o));
    onChange(next);
  };
  const add = () => {
    onChange([...list, { ref: "", kind: "file" as PipelineArtifactKind }]);
  };
  const remove = (i: number) => {
    const next = list.filter((_, j) => j !== i);
    onChange(next.length === 0 ? undefined : next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-xs font-medium" style={{ color: "var(--color-text)" }}>
            🎯 {title}
          </span>
          {hint && (
            <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{hint}</span>
          )}
        </div>
        <button
          className="text-xs px-2 py-0.5 rounded"
          style={{ border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          onClick={add}
        >+ 添加</button>
      </div>
      {list.length === 0 && (
        <div className="text-xs italic px-3 py-2 rounded" style={{ color: "var(--color-text-muted)", background: "var(--color-bg)", border: "1px dashed var(--color-border)" }}>
          暂未声明产物
        </div>
      )}
      {list.map((o, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 p-3 rounded-lg"
          style={{ border: "1px solid var(--color-border)", background: "var(--color-bg)" }}
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded" style={{ background: "var(--color-border)", color: "var(--color-text-muted)" }}>
              Output [{i}]
            </span>
            <div className="flex items-center gap-2">
              {!forceFinal && (
                <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: "var(--color-text-muted)" }}>
                  <input
                    type="checkbox"
                    checked={!!o.isFinal}
                    onChange={(e) => patch(i, { isFinal: e.target.checked })}
                  />
                  ⭐ 终稿
                </label>
              )}
              <button
                className="w-6 h-6 rounded flex items-center justify-center text-xs"
                title="删除此产物"
                style={{ border: "1px solid #fca5a5", color: "#dc2626" }}
                onClick={() => remove(i)}
              >✕</button>
            </div>
          </div>
          <div className="grid grid-cols-[1.4fr_0.6fr_1fr] gap-2">
            <Field label="ref" hint="文件名/URL，支持 ${var}">
              <input
                className={inputCls}
                placeholder="e.g. final.md"
                value={o.ref}
                onChange={(e) => patch(i, { ref: e.target.value })}
              />
            </Field>
            <Field label="kind">
              <select
                className={inputCls}
                value={o.kind ?? "file"}
                onChange={(e) => patch(i, { kind: e.target.value as PipelineArtifactKind })}
              >
                {ARTIFACT_KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </Field>
            <Field label="label" hint="UI 显示名（可选）">
              <input
                className={inputCls}
                placeholder="e.g. 博客终稿"
                value={o.label ?? ""}
                onChange={(e) => patch(i, { label: e.target.value })}
              />
            </Field>
          </div>
          <Field label="description" hint="描述（可选）">
            <input
              className={inputCls}
              placeholder="e.g. 发布使用的完整博客"
              value={o.description ?? ""}
              onChange={(e) => patch(i, { description: e.target.value })}
            />
          </Field>
        </div>
      ))}
    </div>
  );
}

// ─── Acceptance assertions editor ─────────────────────────────

function AssertionsEditor({
  assertions,
  onChange,
}: {
  assertions: AcceptanceAssertion[] | undefined;
  onChange: (next: AcceptanceAssertion[] | undefined) => void;
}) {
  const list = assertions ?? [];
  const patch = (i: number, next: AcceptanceAssertion) => {
    const copy = list.slice();
    copy[i] = next;
    onChange(copy);
  };
  const add = () => {
    onChange([...list, { type: "file_exists", ref: "" }]);
  };
  const remove = (i: number) => {
    const copy = list.filter((_, j) => j !== i);
    onChange(copy.length === 0 ? undefined : copy);
  };
  const changeType = (i: number, type: AcceptanceAssertion["type"]) => {
    const cur = list[i];
    if (cur.type === type) return;
    if (type === "file_exists") {
      patch(i, { type: "file_exists", ref: cur.ref, description: cur.description });
    } else {
      patch(i, { type: "file_contains", ref: cur.ref, pattern: "", regex: false, description: cur.description });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-xs font-medium flex items-center gap-1.5" style={{ color: "var(--color-text)" }}>
            🛡 验收断言（可选）
          </span>
          <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
            Harness 机器校验；agent 声称完成后不过这些就不算完成
          </span>
        </div>
        <button
          className="text-xs px-2 py-0.5 rounded"
          style={{ border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          onClick={add}
          type="button"
        >+ 添加</button>
      </div>
      {list.length === 0 && (
        <div
          className="text-xs italic px-3 py-2 rounded"
          style={{ color: "var(--color-text-muted)", background: "var(--color-bg)", border: "1px dashed var(--color-border)" }}
        >
          未声明断言（agent 完成即完成，不做机器校验）
        </div>
      )}
      {list.map((a, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 p-3 rounded-lg"
          style={{ border: "1px solid var(--color-border)", background: "var(--color-bg)" }}
        >
          <div className="flex items-center justify-between">
            <div className="inline-flex rounded overflow-hidden text-xs" style={{ border: "1px solid var(--color-border)" }}>
              {(["file_exists", "file_contains"] as const).map((t) => {
                const active = a.type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => changeType(i, t)}
                    className="px-2 py-0.5"
                    style={{
                      background: active ? "#dcfce7" : "transparent",
                      color: active ? "#166534" : "var(--color-text-muted)",
                      fontWeight: active ? 600 : 400,
                      borderRight: t === "file_exists" ? "1px solid var(--color-border)" : "none",
                    }}
                  >
                    {t === "file_exists" ? "文件存在" : "文件包含"}
                  </button>
                );
              })}
            </div>
            <button
              className="w-6 h-6 rounded flex items-center justify-center text-xs"
              type="button"
              title="删除此断言"
              style={{ border: "1px solid #fca5a5", color: "#dc2626" }}
              onClick={() => remove(i)}
            >✕</button>
          </div>
          <Field label="ref" hint="文件路径，支持 ${var}">
            <input
              className={inputCls}
              placeholder="e.g. ${filename}.md"
              value={a.ref}
              onChange={(e) => patch(i, { ...a, ref: e.target.value })}
            />
          </Field>
          {a.type === "file_contains" && (
            <>
              <Field label="pattern" hint={a.regex ? "正则表达式" : "子串"}>
                <input
                  className={inputCls}
                  placeholder={a.regex ? '"price"\\\\s*:\\\\s*\\\\d+' : "## 结论"}
                  value={a.pattern}
                  onChange={(e) => patch(i, { ...a, pattern: e.target.value })}
                />
              </Field>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: "var(--color-text-muted)" }}>
                <input
                  type="checkbox"
                  checked={!!a.regex}
                  onChange={(e) => patch(i, { ...a, regex: e.target.checked })}
                />
                按正则匹配（RegExp）
              </label>
            </>
          )}
          <Field label="description" hint="（可选）说明这条断言的意图">
            <input
              className={inputCls}
              placeholder="e.g. 博客必须包含结论章节"
              value={a.description ?? ""}
              onChange={(e) => patch(i, { ...a, description: e.target.value || undefined })}
            />
          </Field>
        </div>
      ))}
    </div>
  );
}
