import { useEffect, useMemo, useRef, useState } from "react";
import type { GuildAgent } from "../../types/guild";
import type { GroupPlan, AgentPlanItem } from "../../api/guild";
import { generateGroupPlan, applyGroupPlan } from "../../api/guild";
import { friendlyError, trapTabInDialog } from "../../lib/guildErrors";

interface Props {
  agents: GuildAgent[];
  onDone: (groupId: string) => void;
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

/** AI-driven group builder. Flow: prompt → LLM plan → editable preview → apply. */
/** Assign a stable id to each agent plan item so React keys survive edits & removals. */
type AgentPlanItemWithUid = AgentPlanItem & { _uid: string };
type GroupPlanWithUids = Omit<GroupPlan, "agents"> & { agents: AgentPlanItemWithUid[] };

function attachUids(plan: GroupPlan): GroupPlanWithUids {
  return {
    ...plan,
    agents: plan.agents.map((a, i) => ({ ...a, _uid: `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}` })),
  };
}

export default function AIGroupDesignerModal({ agents, onDone, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("prompt");
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState<GroupPlanWithUids | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Snapshot of the AI's original plan, captured when the plan first arrives.
   *  Drives the "重新描述" isDirty check; held as state so the useMemo below
   *  has a reactive dependency rather than a stale-prone ref read.
   *  `originalByUidRef` stays a ref because switchAction reads it imperatively
   *  inside an event handler, never inside a render-time computation. */
  const [originalPlan, setOriginalPlan] = useState<GroupPlan | null>(null);
  const originalByUidRef = useRef<Map<string, AgentPlanItem>>(new Map());

  // Mirror isDirty into a ref so the ESC handler below can read it without
  // re-binding the listener on every keystroke (and without TDZ-referencing
  // the useMemo that's declared further down).
  const isDirtyRef = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // In loading state, ESC cancels the in-flight request rather than
      // closing the modal — that avoids the "modal disappears mid-LLM-call,
      // request silently finishes in the background" UX trap.
      if (e.key === "Escape") {
        if (phase === "loading") {
          abortRef.current?.abort();
        } else if (phase === "preview" && isDirtyRef.current) {
          // Route through the same dirty-check the 重新描述 button uses so a
          // stray ESC while editing a long system prompt doesn't silently
          // discard the user's edits.
          setConfirmReset(true);
        } else if (phase !== "applying") {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase]);

  // Drive the "已等待 Xs" counter so the user knows it's alive and how long
  // LLM calls typically take. Cleared on phase transitions / unmount.
  useEffect(() => {
    if (phase !== "loading") { setElapsedSec(0); return; }
    const t0 = Date.now();
    const iv = setInterval(() => setElapsedSec(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(iv);
  }, [phase]);

  // Abort any in-flight request if the modal unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Applied during apply-plan: if the user force-closes the modal or it
   *  gets unmounted for any other reason before the HTTP call resolves, skip
   *  the setState calls to avoid React warnings / stale-state writes. */
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const handleGenerate = async () => {
    if (!description.trim()) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("loading");
    setError(null);
    try {
      const result = await generateGroupPlan(description.trim(), ctrl.signal);
      // Skip late writes if the user cancelled or the modal was force-unmounted
      // by the parent for any non-abort reason.
      if (ctrl.signal.aborted || !mountedRef.current) return;
      const withUids = attachUids(result);
      // Snapshot AI's original shape — used for dirty-check & switchAction hints.
      setOriginalPlan(JSON.parse(JSON.stringify(result)) as GroupPlan);
      const origMap = new Map<string, AgentPlanItem>();
      for (const a of withUids.agents) {
        const { _uid, ...rest } = a;
        origMap.set(_uid, rest as AgentPlanItem);
      }
      originalByUidRef.current = origMap;
      setPlan(withUids);
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

  /** True when the user has edited any field in the preview since AI returned.
   *  Memoised because the deep-equality walk does a full JSON.stringify of the
   *  plan (agent system prompts included) on every evaluation — without the
   *  memo, every keystroke re-runs it on render. */
  const isDirty = useMemo(() => {
    if (!plan || !originalPlan) return false;
    const stripped: GroupPlan = {
      ...plan,
      agents: plan.agents.map(({ _uid: _u, ...rest }) => rest as AgentPlanItem),
    };
    return JSON.stringify(stripped) !== JSON.stringify(originalPlan);
  }, [plan, originalPlan]);
  // Keep the ref in sync so the ESC listener (declared earlier, can't TDZ-reference
  // the memo above) can read the current dirty state.
  isDirtyRef.current = isDirty;

  const resetToPrompt = () => {
    setPhase("prompt");
    setPlan(null);
    setConfirmReset(false);
    setOriginalPlan(null);
    originalByUidRef.current = new Map();
  };

  const handleResetClick = () => {
    if (isDirty) setConfirmReset(true);
    else resetToPrompt();
  };

  /** Append a new agent-plan item so users aren't stuck when AI returns an
   *  empty members list (or after they've removed everyone by mistake). */
  const handleAddManualMember = () => {
    if (!plan) return;
    const first = agents[0];
    const newItem: AgentPlanItem = first
      ? { action: "reuse", agentId: first.id }
      : {
          action: "create",
          spec: {
            name: "新 Agent",
            description: "",
            icon: "🤖",
            color: "#3B82F6",
            systemPrompt: "",
            allowedTools: ["*"],
          },
        };
    const uid = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setPlan({ ...plan, agents: [...plan.agents, { ...newItem, _uid: uid } as AgentPlanItemWithUid] });
  };

  const handleApply = async () => {
    if (!plan) return;
    setPhase("applying");
    setError(null);
    try {
      // Strip client-only _uid before sending.
      const serverPlan: GroupPlan = {
        ...plan,
        agents: plan.agents.map(({ _uid: _u, ...rest }) => rest as AgentPlanItem),
      };
      const { group } = await applyGroupPlan(serverPlan);
      if (!mountedRef.current) return;
      onDone(group.id);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(friendlyError(e));
      setPhase("preview");
    }
  };

  const updateAgent = (idx: number, next: AgentPlanItem) => {
    if (!plan) return;
    const agents = [...plan.agents];
    agents[idx] = { ...next, _uid: plan.agents[idx]._uid } as AgentPlanItemWithUid;
    setPlan({ ...plan, agents });
  };

  const removeAgent = (idx: number) => {
    if (!plan) return;
    const agents = plan.agents.filter((_, i) => i !== idx);
    const leadIndex = plan.leadIndex === idx ? undefined
      : plan.leadIndex !== undefined && plan.leadIndex > idx ? plan.leadIndex - 1
      : plan.leadIndex;
    setPlan({ ...plan, agents, leadIndex });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={phase !== "loading" && phase !== "applying" ? onClose : undefined} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-group-designer-heading"
        onKeyDown={trapTabInDialog}
        className="relative w-full max-w-2xl rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", maxHeight: "90vh" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
          <div>
            <h3 id="ai-group-designer-heading" className="text-base font-semibold flex items-center gap-2" style={{ color: "var(--color-text)" }}>
              <span>✨</span> AI 建组
            </h3>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
              {phase === "prompt" ? "描述你想要的小组目标，AI 会规划成员与配置" :
               phase === "loading" ? "AI 正在分析..." :
               phase === "preview" ? "审查方案，可调整后一键落盘" :
               // applying: header carries the actionable count, footer the spinner
               // — keeps the two strings from being literally identical.
               `正在写入 ${plan?.agents.length ?? 0} 个 Agent · 1 个小组`}
            </p>
          </div>
          {(() => {
            const closeDisabled = phase === "loading" || phase === "applying";
            return (
              <button
                onClick={onClose}
                disabled={closeDisabled}
                title={phase === "loading" ? "AI 正在生成方案，按 ESC 取消" : phase === "applying" ? "正在写入 — 完成前无法关闭" : "关闭"}
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
              <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>
                描述小组目标（越具体越好，可提及技术栈、资源路径、业务背景）
              </label>
              <textarea
                className="w-full px-3 py-2 rounded-lg text-sm resize-y"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", minHeight: 120 }}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例：给我的 React 电商前端做重构，聚焦于支付流程、组件拆分、性能优化。代码在 /Users/xx/mall-frontend"
                autoFocus
              />
              <div className="text-[11px] rounded-lg px-3 py-2" style={{ background: "var(--color-bg)", border: "1px dashed var(--color-border)", color: "var(--color-text-muted)" }}>
                AI 会参考你现有的 {agents.length} 个 Agent — 优先复用，必要时才新建或派生
              </div>
            </div>
          )}

          {phase === "loading" && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div
                className="w-8 h-8 rounded-full border-[3px] animate-spin"
                style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
                role="status"
                aria-label="AI 正在设计小组"
              />
              <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>AI 正在设计小组...</div>
              <div className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                已等待 {elapsedSec}s · 通常 20-60 秒 · 按 ESC 或下方按钮取消
              </div>
            </div>
          )}

          {(phase === "preview" || phase === "applying") && plan && (
            <PlanPreview
              plan={plan}
              agents={agents}
              originalByUid={originalByUidRef.current}
              onUpdateAgent={updateAgent}
              onRemoveAgent={removeAgent}
              onAddMember={handleAddManualMember}
              onUpdateGroup={(patch) => setPlan({ ...plan, group: { ...plan.group, ...patch } })}
              onSetLead={(idx) => setPlan({ ...plan, leadIndex: idx })}
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
              {/* Anchor the reset slot to a fixed min-width so the inline
                  "确认放弃 / 继续编辑" expansion doesn't shove the primary
                  "一键创建" button sideways and cause mis-clicks. */}
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
                style={{ background: plan.agents.length > 0 ? "var(--color-accent)" : "var(--color-text-muted)" }}
                onClick={handleApply}
                disabled={plan.agents.length === 0}
              >一键创建</button>
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
              保存中…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Plan Preview ─────────────────────────────────────────────

function PlanPreview({
  plan, agents, originalByUid, onUpdateAgent, onRemoveAgent, onAddMember, onUpdateGroup, onSetLead, disabled,
}: {
  plan: GroupPlanWithUids;
  agents: GuildAgent[];
  originalByUid: Map<string, AgentPlanItem>;
  onUpdateAgent: (idx: number, next: AgentPlanItem) => void;
  onRemoveAgent: (idx: number) => void;
  onAddMember: () => void;
  onUpdateGroup: (patch: Partial<GroupPlan["group"]>) => void;
  onSetLead: (idx: number | undefined) => void;
  disabled: boolean;
}) {
  return (
    <div className={`space-y-4 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      {plan.reasoning && (
        <div className="text-xs rounded-lg px-3 py-2" style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}>
          💡 {plan.reasoning}
        </div>
      )}

      {/* Group fields */}
      <div className="space-y-2">
        <div className="text-xs font-semibold" style={{ color: "var(--color-text-muted)" }}>小组信息</div>
        <input
          className="w-full px-3 py-2 rounded-lg text-sm"
          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          value={plan.group.name}
          onChange={(e) => onUpdateGroup({ name: e.target.value })}
          placeholder="小组名称"
        />
        <input
          className="w-full px-3 py-2 rounded-lg text-sm"
          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          value={plan.group.description}
          onChange={(e) => onUpdateGroup({ description: e.target.value })}
          placeholder="小组描述"
        />
        <div className="flex gap-2">
          {(["isolated", "collaborative"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className="flex-1 px-2 py-1.5 rounded-lg text-xs"
              style={{
                background: plan.group.artifactStrategy === s ? "var(--color-accent)" : "var(--color-bg)",
                color: plan.group.artifactStrategy === s ? "white" : "var(--color-text)",
                border: plan.group.artifactStrategy === s ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
              }}
              onClick={() => onUpdateGroup({ artifactStrategy: s })}
            >
              {s === "isolated" ? "🔒 隔离" : "🤝 协作"}
            </button>
          ))}
        </div>
      </div>

      {/* Agents */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold" style={{ color: "var(--color-text-muted)" }}>
            成员 Agent ({plan.agents.length})
          </div>
          <div className="flex items-center gap-2">
            <button
              className="text-[10px] px-2 py-0.5 rounded"
              style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)", border: "1px solid var(--color-accent)" }}
              onClick={onAddMember}
              title="追加一个空白成员槽位；可在下方卡片里切换复用/新建/派生"
            >
              + 添加成员
            </button>
            <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
              点击 👑 指定 Lead
            </div>
          </div>
        </div>
        {plan.agents.length === 0 && (
          <div
            className="text-xs px-3 py-3 rounded-lg text-center space-y-2"
            style={{ background: "var(--color-bg)", border: "1px dashed var(--color-border)", color: "var(--color-text-muted)" }}
          >
            <div>AI 未规划成员，请手动添加或重新描述</div>
            <button
              className="text-xs px-3 py-1 rounded-lg"
              style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)", border: "1px solid var(--color-accent)" }}
              onClick={onAddMember}
            >
              + 手动添加成员
            </button>
          </div>
        )}
        {plan.agents.map((item, idx) => (
          <AgentPlanCard
            key={item._uid}
            item={item}
            originalItem={originalByUid.get(item._uid)}
            isLead={plan.leadIndex === idx}
            existingAgents={agents}
            onUpdate={(next) => onUpdateAgent(idx, next)}
            onRemove={() => onRemoveAgent(idx)}
            onToggleLead={() => onSetLead(plan.leadIndex === idx ? undefined : idx)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Single Agent Plan Card ───────────────────────────────────

function AgentPlanCard({
  item, originalItem, isLead, existingAgents, onUpdate, onRemove, onToggleLead,
}: {
  item: AgentPlanItem;
  /** AI's original item shape for this slot — used so that toggling the
   *  action away and back restores the LLM's recommended source/spec instead
   *  of defaulting to `existingAgents[0]`. */
  originalItem?: AgentPlanItem;
  isLead: boolean;
  existingAgents: GuildAgent[];
  onUpdate: (next: AgentPlanItem) => void;
  onRemove: () => void;
  onToggleLead: () => void;
}) {
  const [expanded, setExpanded] = useState(item.action !== "reuse");

  const source = item.action === "reuse" ? existingAgents.find((a) => a.id === item.agentId)
    : item.action === "fork" ? existingAgents.find((a) => a.id === item.sourceAgentId)
    : null;

  const displayName = item.action === "create" ? item.spec.name
    : item.action === "fork" ? (item.overrides?.name ?? `${source?.name ?? "?"} (派生)`)
    : source?.name ?? "(Agent 已删除)";

  const displayIcon = item.action === "create" ? item.spec.icon
    : item.action === "fork" ? (item.overrides?.icon ?? source?.icon ?? "🤖")
    : source?.icon ?? "🤖";

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: "var(--color-bg)", border: `1px solid ${isLead ? "var(--color-accent)" : "var(--color-border)"}` }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-lg shrink-0">{displayIcon}</span>
        <button
          onClick={onToggleLead}
          title={isLead ? "当前 Lead — 点击取消" : "设为 Lead（小组的领导/协调者）"}
          aria-label={isLead ? "取消 Lead" : "设为 Lead"}
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-sm hover:bg-[var(--color-surface-hover)]"
          style={{ opacity: isLead ? 1 : 0.45 }}
        ><span aria-hidden="true">👑</span></button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>
            {displayName}
          </div>
          {/* Action label badge dropped — the three-way switcher in the
              expanded body already highlights the current action; duplicating
              it as a static badge made the row read like two widgets reporting
              the same state. Mirrors AIPipelineDesignerModal (commit 7471a1b). */}
          {item.reason && (
            <div className="text-[10px] truncate" style={{ color: "var(--color-text-muted)" }}>
              {item.reason}
            </div>
          )}
        </div>
        <button
          className="text-xs px-2 py-1 rounded"
          style={{ color: "var(--color-text-muted)" }}
          onClick={() => setExpanded((v) => !v)}
        >{expanded ? "收起" : "展开"}</button>
        <button
          className="text-xs px-2 py-1 rounded shrink-0"
          style={{ color: "#dc2626", border: "1px solid #fca5a5" }}
          onClick={onRemove}
          title="移除此成员"
          aria-label="移除此成员"
        ><span aria-hidden="true">✕</span></button>
      </div>

      {expanded && (
        <div className="border-t px-3 py-3 space-y-2" style={{ borderColor: "var(--color-border)" }}>
          {/* Action switcher — reuse/fork disabled when agent pool is empty */}
          <div className="flex gap-1 text-[11px]">
            {(["reuse", "create", "fork"] as const).map((a) => {
              const needsExisting = a === "reuse" || a === "fork";
              const disabled = needsExisting && existingAgents.length === 0;
              return (
                <button
                  key={a}
                  disabled={disabled}
                  title={disabled ? "无现有 Agent 可选" : undefined}
                  onClick={() => !disabled && switchAction(item, a, existingAgents, onUpdate, originalItem)}
                  className="flex-1 px-2 py-1 rounded"
                  style={{
                    background: item.action === a ? ACTION_META[a].color : "var(--color-surface)",
                    color: item.action === a ? "white" : "var(--color-text-muted)",
                    border: `1px solid ${item.action === a ? ACTION_META[a].color : "var(--color-border)"}`,
                    opacity: disabled ? 0.4 : 1,
                    cursor: disabled ? "not-allowed" : "pointer",
                  }}
                >
                  {ACTION_META[a].label}
                </button>
              );
            })}
          </div>

          {item.action === "reuse" && (
            <select
              className="w-full px-2 py-1.5 rounded text-xs"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
              value={item.agentId}
              onChange={(e) => onUpdate({ ...item, agentId: e.target.value })}
            >
              {existingAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
              ))}
            </select>
          )}

          {item.action === "fork" && (
            <>
              <div
                className="text-[10px] rounded px-2 py-1"
                style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}
              >
                ⓘ 派生会复制源 agent 的 systemPrompt 和资产作为起点，但不继承其记忆与历史胜率（相当于新员工读过前辈的笔记）
              </div>
              <label className="block text-[10px]" style={{ color: "var(--color-text-muted)" }}>基于哪个 Agent 派生</label>
              <select
                className="w-full px-2 py-1.5 rounded text-xs"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                value={item.sourceAgentId}
                onChange={(e) => onUpdate({ ...item, sourceAgentId: e.target.value })}
              >
                {existingAgents.map((a) => (
                  <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
                ))}
              </select>
              <input
                className="w-full px-2 py-1.5 rounded text-xs"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                value={item.overrides?.name ?? ""}
                onChange={(e) => onUpdate({ ...item, overrides: { ...item.overrides, name: e.target.value } })}
                placeholder={`新名称（默认: ${source?.name ?? "?"} (派生)）`}
              />
              <textarea
                className="w-full px-2 py-1.5 rounded text-xs resize-y font-mono"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)", minHeight: 60 }}
                value={item.overrides?.systemPrompt ?? ""}
                onChange={(e) => onUpdate({ ...item, overrides: { ...item.overrides, systemPrompt: e.target.value } })}
                placeholder="覆盖 systemPrompt（留空则沿用源 agent）"
              />
            </>
          )}

          {item.action === "create" && (
            <>
              <div className="flex gap-2">
                <input
                  className="flex-1 px-2 py-1.5 rounded text-xs"
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                  value={item.spec.name}
                  onChange={(e) => onUpdate({ ...item, spec: { ...item.spec, name: e.target.value } })}
                  placeholder="名称"
                />
                <input
                  className="w-16 px-2 py-1.5 rounded text-xs text-center"
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                  value={item.spec.icon}
                  onChange={(e) => onUpdate({ ...item, spec: { ...item.spec, icon: e.target.value } })}
                  placeholder="🤖"
                />
              </div>
              <input
                className="w-full px-2 py-1.5 rounded text-xs"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                value={item.spec.description}
                onChange={(e) => onUpdate({ ...item, spec: { ...item.spec, description: e.target.value } })}
                placeholder="职责描述"
              />
              <textarea
                className="w-full px-2 py-1.5 rounded text-xs resize-y font-mono"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)", minHeight: 80 }}
                value={item.spec.systemPrompt}
                onChange={(e) => onUpdate({ ...item, spec: { ...item.spec, systemPrompt: e.target.value } })}
                placeholder="systemPrompt"
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function switchAction(
  current: AgentPlanItem,
  next: AgentPlanItem["action"],
  existing: GuildAgent[],
  onUpdate: (n: AgentPlanItem) => void,
  /** AI's original item for this slot, if any. Used as a better default than
   *  `existing[0]` so toggling back to reuse/fork restores the LLM intent. */
  original?: AgentPlanItem,
): void {
  if (next === current.action) return;
  if (next === "reuse") {
    // Prefer the AI's originally recommended agent (if it still exists) over
    // the arbitrary first entry in the pool.
    const preferred = original?.action === "reuse" && existing.some((a) => a.id === original.agentId)
      ? original.agentId
      : existing[0]?.id;
    if (!preferred) return; // nothing to reuse
    onUpdate({ action: "reuse", agentId: preferred, reason: current.reason ?? original?.reason });
  } else if (next === "create") {
    // If AI had a create spec for this slot, restore it. Otherwise start blank.
    const restored = original?.action === "create" ? original.spec : undefined;
    onUpdate({
      action: "create",
      reason: current.reason ?? original?.reason,
      spec: restored ?? {
        name: "新 Agent",
        description: "",
        icon: "🤖",
        color: "#3B82F6",
        systemPrompt: "",
        allowedTools: ["*"],
      },
    });
  } else if (next === "fork") {
    const preferredSource = original?.action === "fork" && existing.some((a) => a.id === original.sourceAgentId)
      ? original.sourceAgentId
      : existing[0]?.id;
    if (!preferredSource) return;
    const preferredOverrides = original?.action === "fork" ? original.overrides : {};
    onUpdate({
      action: "fork",
      sourceAgentId: preferredSource,
      overrides: preferredOverrides ?? {},
      reason: current.reason ?? original?.reason,
    });
  }
}
