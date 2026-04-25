import { useEffect, useMemo, useRef, useState } from "react";
import type { GuildAgent } from "../../types/guild";
import type { PipelinePlan, AgentPlanItem } from "../../api/guild";
import { generatePipelinePlan, applyPipelinePlan, listGuildAgents } from "../../api/guild";
import { friendlyError, trapTabInDialog } from "../../lib/guildErrors";

interface Props {
  onDone: (templateId: string) => void;
  onClose: () => void;
}

type Phase = "prompt" | "loading" | "preview" | "applying";

/** Badge metadata for the three plan-item action types. Hoisted to module
 *  scope so the object isn't reallocated on every AgentRow render. */
const ACTION_META: Record<AgentPlanItem["action"], { label: string; color: string; bg: string }> = {
  reuse: { label: "复用", color: "#059669", bg: "#10b98122" },
  create: { label: "新建", color: "#2563eb", bg: "#3b82f622" },
  fork: { label: "派生", color: "#9333ea", bg: "#a855f722" },
};

/** Keyboard of agent plan items — key is planKey ("K0", "K1"...) */
export default function AIPipelineDesignerModal({ onDone, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("prompt");
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState<PipelinePlan | null>(null);
  /** Snapshot of the AI's original plan, captured when it first arrives. Drives
   *  the "重新描述" dirty-check so a user with edits gets a confirm step
   *  instead of silently losing them — mirrors AIGroupDesignerModal. */
  const [originalPlan, setOriginalPlan] = useState<PipelinePlan | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [agents, setAgents] = useState<GuildAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Separate from `error` so a failed agent-fetch doesn't get clobbered by
   *  later generate/apply errors and vice-versa. The fetch is non-blocking —
   *  the user can still generate a brand-new pipeline without existing agents. */
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    listGuildAgents()
      .then((list) => { if (!cancelled) setAgents(list); })
      .catch((e) => {
        if (!cancelled) setAgentsError(friendlyError(e));
      });
    return () => { cancelled = true; };
  }, []);

  // Mirror isDirty into a ref so the ESC handler can read it without re-binding
  // on every keystroke and without TDZ-referencing the useMemo declared further
  // down.
  const isDirtyRef = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (phase === "loading") {
          abortRef.current?.abort();
        } else if (phase === "preview" && isDirtyRef.current) {
          // ESC routes through the dirty-check confirmation so editing a long
          // step description isn't silently lost on a stray keypress.
          setConfirmReset(true);
        } else if (phase !== "applying") {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase]);

  useEffect(() => {
    if (phase !== "loading") { setElapsedSec(0); return; }
    const t0 = Date.now();
    const iv = setInterval(() => setElapsedSec(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(iv);
  }, [phase]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** Skip setState after unmount if apply-plan is still in flight when the
   *  modal closes — avoids a stale React warning. */
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const handleGenerate = async () => {
    if (!description.trim()) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("loading");
    setError(null);
    try {
      const result = await generatePipelinePlan(description.trim(), ctrl.signal);
      // Skip late writes if the user cancelled or the parent force-unmounted us.
      if (ctrl.signal.aborted || !mountedRef.current) return;
      setPlan(result);
      // Deep clone so later edits to `plan` don't mutate the original snapshot.
      setOriginalPlan(JSON.parse(JSON.stringify(result)) as PipelinePlan);
      setPhase("preview");
    } catch (e) {
      if (!mountedRef.current) return;
      if (ctrl.signal.aborted) {
        setPhase("prompt");
        return;
      }
      setError(friendlyError(e));
      setPhase("prompt");
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  const handleCancelGeneration = () => {
    abortRef.current?.abort();
  };

  const handleApply = async () => {
    if (!plan) return;
    setPhase("applying");
    setError(null);
    try {
      const { template } = await applyPipelinePlan(plan);
      if (!mountedRef.current) return;
      onDone(template.id);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(friendlyError(e));
      setPhase("preview");
    }
  };

  const isDirty = useMemo(() => {
    if (!plan || !originalPlan) return false;
    return JSON.stringify(plan) !== JSON.stringify(originalPlan);
  }, [plan, originalPlan]);
  isDirtyRef.current = isDirty;

  const resetToPrompt = () => {
    setPhase("prompt");
    setPlan(null);
    setOriginalPlan(null);
    setConfirmReset(false);
  };

  const handleResetClick = () => {
    if (isDirty) setConfirmReset(true);
    else resetToPrompt();
  };

  return (
    // Stop click propagation at the outermost wrapper. This modal renders
    // inside PipelineEditorModal's DOM tree, and that parent puts an
    // onClick={onClose} handler on ITS outermost div — without stopProp,
    // clicking ✕ or 取消 here bubbles up and closes the parent modal too.
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/50" onClick={phase !== "loading" && phase !== "applying" ? onClose : undefined} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-pipeline-designer-heading"
        onKeyDown={trapTabInDialog}
        className="relative w-full max-w-3xl rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", maxHeight: "92vh" }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
          <div>
            <h3 id="ai-pipeline-designer-heading" className="text-base font-semibold flex items-center gap-2" style={{ color: "var(--color-text)" }}>
              <span>✨</span> AI 生成流水线模板
            </h3>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
              {phase === "prompt" ? "描述工作流，AI 会规划步骤与合适的 Agent" :
               phase === "loading" ? "正在设计..." :
               phase === "preview" ? "审查方案，可调整后保存为模板" :
               // applying: header carries actionable counts, footer carries the spinner.
               (() => {
                 const stepCount = plan?.template.steps.length ?? 0;
                 const newAgentCount = plan?.agents.filter((a) => a.action !== "reuse").length ?? 0;
                 return newAgentCount > 0
                   ? `正在写入 ${stepCount} 个步骤 · ${newAgentCount} 个新 Agent`
                   : `正在写入 ${stepCount} 个步骤`;
               })()}
            </p>
          </div>
          {(() => {
            const closeDisabled = phase === "loading" || phase === "applying";
            return (
              <button
                onClick={onClose}
                disabled={closeDisabled}
                title={phase === "loading" ? "AI 正在生成模板，按 ESC 取消" : phase === "applying" ? "正在保存 — 完成前无法关闭" : "关闭"}
                aria-label="关闭"
                className={`w-7 h-7 flex items-center justify-center rounded-lg ${closeDisabled ? "cursor-not-allowed" : "hover:bg-[var(--color-surface-hover)]"}`}
                style={{ color: "var(--color-text-muted)", opacity: closeDisabled ? 0.45 : 1 }}
              >✕</button>
            );
          })()}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {phase === "prompt" && (
            <div className="space-y-3">
              {agentsError && (
                <div
                  className="text-xs rounded-lg px-3 py-2 flex items-start gap-2"
                  style={{ background: "var(--color-warning-bg)", border: "1px solid var(--color-warning-border)", color: "var(--color-warning-text)" }}
                  role="alert"
                >
                  <span aria-hidden="true">⚠️</span>
                  <span>
                    无法获取已有 Agent（{agentsError}）— 仍可继续生成全新方案，AI 将默认全部新建。
                  </span>
                </div>
              )}
              <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>
                描述工作流 — 包括输入、步骤、依赖、最终交付物
              </label>
              <textarea
                className="w-full px-3 py-2 rounded-lg text-sm resize-y"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", minHeight: 140 }}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例：输入一个 YouTube 播客链接，先抓取字幕，然后总结为大纲，按大纲生成博客初稿，最后配图并导出 markdown"
                autoFocus
              />
              <div className="text-[11px] rounded-lg px-3 py-2" style={{ background: "var(--color-bg)", border: "1px dashed var(--color-border)", color: "var(--color-text-muted)" }}>
                {agentsError
                  ? "AI 将根据你的描述提议新 Agent（无法引用现有 Agent）"
                  : `AI 会参考你现有的 ${agents.length} 个 Agent — 优先复用，必要时提议新建或派生`}
              </div>
            </div>
          )}

          {phase === "loading" && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div
                className="w-8 h-8 rounded-full border-[3px] animate-spin"
                style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
                role="status"
                aria-label="AI 正在设计模板"
              />
              <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>AI 正在设计模板...</div>
              <div className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                已等待 {elapsedSec}s · 通常 20-60 秒 · 按 ESC 或下方按钮取消
              </div>
            </div>
          )}

          {(phase === "preview" || phase === "applying") && plan && (
            <PipelinePreview
              plan={plan}
              agents={agents}
              onPatchTemplate={(patch) => setPlan({ ...plan, template: { ...plan.template, ...patch } })}
              onPatchAgent={(idx, next) => {
                const a = [...plan.agents];
                a[idx] = { ...next, planKey: a[idx].planKey };
                setPlan({ ...plan, agents: a });
              }}
              disabled={phase === "applying"}
            />
          )}

          {error && (
            <div
              className="mt-3 text-xs px-3 py-2 rounded max-h-32 overflow-y-auto whitespace-pre-wrap break-words"
              style={{ background: "#fee2e2", color: "#991b1b" }}
              role="alert"
            >
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t shrink-0" style={{ borderColor: "var(--color-border)" }}>
          {phase === "prompt" && (
            <>
              <button className="px-4 py-1.5 rounded-lg text-sm" style={{ color: "var(--color-text-muted)" }} onClick={onClose}>取消</button>
              <button
                className="px-4 py-1.5 rounded-lg text-sm text-white"
                style={{ background: description.trim() ? "var(--color-accent)" : "var(--color-text-muted)" }}
                onClick={handleGenerate}
                disabled={!description.trim()}
              >✨ 生成方案</button>
            </>
          )}
          {phase === "preview" && plan && (
            <>
              {/* Anchor the reset slot at a fixed min-width so the inline
                  "确认放弃 / 继续编辑" expansion doesn't shove the primary
                  "保存模板" button sideways and cause mis-clicks. */}
              <div className="flex items-center min-w-[14rem]">
                {confirmReset ? (
                  <span className="text-xs flex items-center gap-2" style={{ color: "#dc2626" }}>
                    当前编辑将丢失
                    <button
                      className="underline px-1"
                      onClick={resetToPrompt}
                    >确认放弃</button>
                    <button
                      className="px-1"
                      style={{ color: "var(--color-text-muted)" }}
                      onClick={() => setConfirmReset(false)}
                    >继续编辑</button>
                  </span>
                ) : (
                  <button
                    className="px-4 py-1.5 rounded-lg text-sm"
                    style={{ color: "var(--color-text-muted)" }}
                    onClick={handleResetClick}
                  >
                    重新描述
                  </button>
                )}
              </div>
              <button
                className="px-4 py-1.5 rounded-lg text-sm text-white"
                style={{ background: "var(--color-accent)" }}
                onClick={handleApply}
              >保存模板</button>
            </>
          )}
          {phase === "loading" && (
            <>
              <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>生成中...</div>
              <button
                className="px-4 py-1.5 rounded-lg text-sm"
                style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)" }}
                onClick={handleCancelGeneration}
              >取消</button>
            </>
          )}
          {phase === "applying" && (
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
              <span
                className="inline-block w-3 h-3 rounded-full border-2 animate-spin"
                style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
                aria-hidden="true"
              />
              正在保存模板…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Pipeline preview ─────────────────────────────────────────

function PipelinePreview({
  plan, agents, onPatchTemplate, onPatchAgent, disabled,
}: {
  plan: PipelinePlan;
  agents: GuildAgent[];
  onPatchTemplate: (patch: Partial<PipelinePlan["template"]>) => void;
  onPatchAgent: (idx: number, next: AgentPlanItem) => void;
  disabled: boolean;
}) {
  const tpl = plan.template;
  const [showAdvanced, setShowAdvanced] = useState(false);
  return (
    <div className={`space-y-4 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      {plan.reasoning && (
        <div className="text-xs rounded-lg px-3 py-2" style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}>
          💡 {plan.reasoning}
        </div>
      )}

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <label className="block text-[10px]" style={{ color: "var(--color-text-muted)" }}>名称</label>
          <button
            className="text-[10px] underline"
            style={{ color: "var(--color-text-muted)" }}
            onClick={() => setShowAdvanced((v) => !v)}
            type="button"
          >
            {showAdvanced ? "收起高级选项" : "高级选项"}
          </button>
        </div>
        <input
          className="w-full px-2 py-1.5 rounded-lg text-xs"
          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          value={tpl.name}
          onChange={(e) => onPatchTemplate({ name: e.target.value })}
        />
        {showAdvanced && (
          <div className="mt-2">
            <label className="block text-[10px] mb-1" style={{ color: "var(--color-text-muted)" }}>
              ID <span style={{ color: "#d97706" }}>（系统标识，改动后旧引用会失效）</span>
            </label>
            <input
              className="w-full px-2 py-1.5 rounded-lg text-xs font-mono"
              style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
              value={tpl.id}
              onChange={(e) => onPatchTemplate({ id: e.target.value })}
            />
          </div>
        )}
      </div>
      <input
        className="w-full px-2 py-1.5 rounded-lg text-xs"
        style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
        value={tpl.description ?? ""}
        onChange={(e) => onPatchTemplate({ description: e.target.value })}
        placeholder="描述"
      />

      {/* Inputs summary */}
      {(tpl.inputs ?? []).length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-1.5" style={{ color: "var(--color-text-muted)" }}>Inputs</div>
          <div className="flex flex-wrap gap-1.5">
            {tpl.inputs!.map((i, k) => (
              <span key={k} className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}>
                {i.name}{i.required ? " *" : ""}{i.default ? ` = "${i.default}"` : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Agents block — reuse/create/fork badges */}
      <div>
        <div className="text-xs font-semibold mb-1.5" style={{ color: "var(--color-text-muted)" }}>
          Agent 规划 ({plan.agents.length})
        </div>
        <div className="space-y-1.5">
          {plan.agents.map((a, idx) => (
            <AgentRow key={a.planKey} item={a} existing={agents} onUpdate={(n) => onPatchAgent(idx, n)} />
          ))}
        </div>
      </div>

      {/* Steps — title & description inline-editable; dependency / branching
          logic still lives in the canvas view (left as a progressive-disclosure). */}
      <div>
        <div className="text-xs font-semibold mb-1.5" style={{ color: "var(--color-text-muted)" }}>
          步骤 ({tpl.steps.length}) — 依赖关系与分支逻辑可在画布中调整
        </div>
        <div className="space-y-1">
          {tpl.steps.map((s, i) => (
            <StepRow
              key={i}
              step={s}
              index={i}
              allAgents={plan.agents}
              existing={agents}
              onPatch={(patch) => {
                const next = [...tpl.steps];
                next[i] = { ...next[i], ...patch };
                onPatchTemplate({ steps: next });
              }}
            />
          ))}
        </div>
      </div>

      {/* Outputs */}
      {(tpl.outputs ?? []).length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-1.5" style={{ color: "var(--color-text-muted)" }}>🎯 最终产物</div>
          <div className="flex flex-wrap gap-1.5">
            {tpl.outputs!.map((o, k) => (
              <span key={k} className="text-[10px] px-2 py-0.5 rounded" style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}>
                {o.ref} · {o.kind ?? "file"}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentRow({
  item, existing, onUpdate,
}: {
  item: AgentPlanItem & { planKey: string };
  existing: GuildAgent[];
  onUpdate: (n: AgentPlanItem & { planKey: string }) => void;
}) {
  const source = item.action === "reuse" ? existing.find((a) => a.id === item.agentId)
    : item.action === "fork" ? existing.find((a) => a.id === item.sourceAgentId)
    : null;
  const name = item.action === "create" ? item.spec.name
    : item.action === "fork" ? (item.overrides?.name ?? `${source?.name ?? "?"} (派生)`)
    : source?.name ?? "(已丢失)";
  const icon = item.action === "create" ? item.spec.icon
    : item.action === "fork" ? (item.overrides?.icon ?? source?.icon ?? "🤖")
    : source?.icon ?? "🤖";

  const switchTo = (next: AgentPlanItem["action"]) => {
    if (next === item.action) return;
    if (next === "reuse") {
      const first = existing[0]?.id;
      if (!first) return;
      onUpdate({ action: "reuse", agentId: first, planKey: item.planKey, reason: item.reason });
    } else if (next === "create") {
      onUpdate({
        action: "create",
        planKey: item.planKey,
        reason: item.reason,
        spec: { name: "新 Agent", description: "", icon: "🤖", color: "#3B82F6", systemPrompt: "", allowedTools: ["*"] },
      });
    } else if (next === "fork") {
      const s = existing[0];
      if (!s) return;
      onUpdate({ action: "fork", sourceAgentId: s.id, overrides: {}, planKey: item.planKey, reason: item.reason });
    }
  };

  return (
    <div className="rounded-lg px-2 py-1.5 flex items-center gap-2" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
      <span className="text-xs font-mono w-7 text-center shrink-0" style={{ color: "var(--color-text-muted)" }}>{item.planKey}</span>
      <span className="text-base shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs truncate" style={{ color: "var(--color-text)" }}>{name}</div>
        {item.reason && <div className="text-[10px] truncate" style={{ color: "var(--color-text-muted)" }}>{item.reason}</div>}
      </div>
      <div className="flex gap-0.5 shrink-0">
        {(["reuse", "create", "fork"] as const).map((k) => {
          const needsExisting = k === "reuse" || k === "fork";
          const disabled = needsExisting && existing.length === 0;
          return (
            <button
              key={k}
              disabled={disabled}
              title={disabled ? "无现有 Agent 可选" : undefined}
              onClick={() => !disabled && switchTo(k)}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                background: item.action === k ? ACTION_META[k].color : "transparent",
                color: item.action === k ? "white" : "var(--color-text-muted)",
                border: `1px solid ${item.action === k ? ACTION_META[k].color : "var(--color-border)"}`,
                opacity: disabled ? 0.4 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              {ACTION_META[k].label}
            </button>
          );
        })}
      </div>
      {item.action === "reuse" && (
        <select
          className="text-[10px] px-1 py-0.5 rounded shrink-0 max-w-[100px]"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          value={item.agentId}
          onChange={(e) => onUpdate({ ...item, agentId: e.target.value })}
        >
          {existing.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      )}
      {item.action === "fork" && (
        <select
          className="text-[10px] px-1 py-0.5 rounded shrink-0 max-w-[100px]"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          value={item.sourceAgentId}
          onChange={(e) => onUpdate({ ...item, sourceAgentId: e.target.value })}
        >
          {existing.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function StepRow({
  step, index, allAgents, existing, onPatch,
}: {
  step: {
    title: string;
    description: string;
    suggestedAgentId?: string;
    dependsOn?: number[];
    kind?: string;
    acceptanceAssertions?: import("../../types/guild").AcceptanceAssertion[];
  };
  index: number;
  allAgents: (AgentPlanItem & { planKey: string })[];
  existing: GuildAgent[];
  onPatch: (patch: { title?: string; description?: string }) => void;
}) {
  const sid = step.suggestedAgentId;
  let agentLabel: string | null = null;
  if (sid?.startsWith("plan:")) {
    const key = sid.slice(5);
    const plan = allAgents.find((a) => a.planKey === key);
    if (plan) {
      const name = plan.action === "create" ? plan.spec.name
        : plan.action === "fork" ? (plan.overrides?.name ?? existing.find(a => a.id === plan.sourceAgentId)?.name ?? "?") + " (派生)"
        : existing.find(a => a.id === plan.agentId)?.name ?? "?";
      agentLabel = `${plan.planKey} · ${name}`;
    }
  } else if (sid) {
    agentLabel = existing.find(a => a.id === sid)?.name ?? sid;
  }

  return (
    <div className="rounded px-2 py-1 text-xs flex items-start gap-2" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
      <span className="font-mono shrink-0 pt-0.5" style={{ color: "var(--color-text-muted)" }}>[{index}]</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <input
            className="flex-1 min-w-0 bg-transparent font-medium focus:outline-none focus:bg-[var(--color-surface)] rounded px-1"
            style={{ color: "var(--color-text)" }}
            value={step.title}
            placeholder="(未命名)"
            onChange={(e) => onPatch({ title: e.target.value })}
          />
          {step.kind && step.kind !== "task" && (
            <span className="text-[10px] px-1 rounded shrink-0" style={{ background: step.kind === "branch" ? "#8b5cf622" : "#f59e0b22", color: step.kind === "branch" ? "#8b5cf6" : "#f59e0b" }}>
              {step.kind}
            </span>
          )}
          {(step.dependsOn ?? []).length > 0 && (
            <span className="text-[10px] shrink-0" style={{ color: "var(--color-text-muted)" }}>← {step.dependsOn!.join(",")}</span>
          )}
          {(step.acceptanceAssertions?.length ?? 0) > 0 && (
            <span
              className="text-[10px] shrink-0 px-1 py-0.5 rounded"
              style={{ background: "#dcfce7", color: "#166534" }}
              title={`Harness 会机器校验 ${step.acceptanceAssertions!.length} 条验收断言`}
            >
              🛡 {step.acceptanceAssertions!.length}
            </span>
          )}
          {agentLabel && (
            <span className="text-[10px] ml-auto px-1.5 py-0.5 rounded shrink-0" style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}>
              🤖 {agentLabel}
            </span>
          )}
        </div>
        <input
          className="w-full mt-0.5 bg-transparent text-[10px] focus:outline-none focus:bg-[var(--color-surface)] rounded px-1"
          style={{ color: "var(--color-text-muted)" }}
          value={step.description}
          placeholder="步骤描述"
          onChange={(e) => onPatch({ description: e.target.value })}
        />
      </div>
    </div>
  );
}
