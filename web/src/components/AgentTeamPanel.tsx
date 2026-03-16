import { useState, useEffect, useCallback } from "react";
import type { AgentDef, TeamDef } from "../types";
import {
  listAgentDefs,
  createAgentDef,
  updateAgentDef,
  deleteAgentDef as apiDeleteAgent,
  generateAgentDef,
  listTeamDefs,
  createTeamDef,
  updateTeamDef,
  deleteTeamDef as apiDeleteTeam,
} from "../api";
import { useToast } from "./Toast";
import { refreshRoleCache } from "../constants/roles";

interface Props {
  onClose: () => void;
}

type Tab = "agents" | "teams";

// ─── Agent Form ─────────────────────────────────────────

interface AgentFormData {
  name: string;
  description: string;
  icon: string;
  color: string;
  systemPrompt: string;
  deniedTools: string[];
}

const COMMON_TOOLS = [
  "run_command",
  "write_file",
  "read_file",
  "web_search",
  "calculator",
  "get_time",
];

const emptyAgentForm: AgentFormData = {
  name: "",
  description: "",
  icon: "🤖",
  color: "#6B7280",
  systemPrompt: "",
  deniedTools: [],
};

function AgentForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: AgentFormData;
  onSave: (data: AgentFormData) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<AgentFormData>(initial ?? emptyAgentForm);

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>名称</label>
          <input
            className="w-full px-3 py-2 rounded-lg text-sm"
            style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Agent 名称"
          />
        </div>
        <div className="w-16">
          <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>图标</label>
          <input
            className="w-full px-3 py-2 rounded-lg text-sm text-center"
            style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
            value={form.icon}
            onChange={(e) => setForm({ ...form, icon: e.target.value })}
          />
        </div>
        <div className="w-24">
          <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>颜色</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              className="w-8 h-8 rounded cursor-pointer border-0"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
            />
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{form.color}</span>
          </div>
        </div>
      </div>

      <div>
        <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>描述</label>
        <input
          className="w-full px-3 py-2 rounded-lg text-sm"
          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="简短描述该 Agent 的职责"
        />
      </div>

      <div>
        <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>系统提示词</label>
        <textarea
          className="w-full px-3 py-2 rounded-lg text-sm font-mono resize-y"
          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", minHeight: 120 }}
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          placeholder="定义该 Agent 的角色和行为指令..."
        />
      </div>

      <div>
        <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>禁用的工具</label>
        <div className="flex flex-wrap gap-2">
          {COMMON_TOOLS.map((t) => (
            <label key={t} className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: "var(--color-text)" }}>
              <input
                type="checkbox"
                checked={form.deniedTools.includes(t)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setForm({ ...form, deniedTools: [...form.deniedTools, t] });
                  } else {
                    setForm({ ...form, deniedTools: form.deniedTools.filter((x) => x !== t) });
                  }
                }}
              />
              {t}
            </label>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          className="px-4 py-1.5 rounded-lg text-sm"
          style={{ color: "var(--color-text-muted)" }}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          className="px-4 py-1.5 rounded-lg text-sm text-white"
          style={{ background: "var(--color-accent)" }}
          onClick={() => onSave(form)}
          disabled={!form.name.trim()}
        >
          保存
        </button>
      </div>
    </div>
  );
}

// ─── Team Form ──────────────────────────────────────────

interface TeamFormData {
  name: string;
  description: string;
  agents: string[];
  coordinatorPrompt: string;
}

const emptyTeamForm: TeamFormData = {
  name: "",
  description: "",
  agents: [],
  coordinatorPrompt: "",
};

function TeamForm({
  initial,
  allAgents,
  onSave,
  onCancel,
}: {
  initial?: TeamFormData;
  allAgents: AgentDef[];
  onSave: (data: TeamFormData) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<TeamFormData>(initial ?? emptyTeamForm);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>团队名称</label>
        <input
          className="w-full px-3 py-2 rounded-lg text-sm"
          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Team 名称"
        />
      </div>

      <div>
        <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>描述</label>
        <input
          className="w-full px-3 py-2 rounded-lg text-sm"
          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="简短描述该团队的用途"
        />
      </div>

      <div>
        <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>选择团队成员</label>
        <div className="space-y-1.5 max-h-48 overflow-y-auto rounded-lg p-2" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
          {allAgents.map((agent) => (
            <label
              key={agent.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm"
              style={{
                color: "var(--color-text)",
                background: form.agents.includes(agent.id) ? "var(--color-accent-alpha)" : "transparent",
              }}
            >
              <input
                type="checkbox"
                checked={form.agents.includes(agent.id)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setForm({ ...form, agents: [...form.agents, agent.id] });
                  } else {
                    setForm({ ...form, agents: form.agents.filter((x) => x !== agent.id) });
                  }
                }}
              />
              <span>{agent.icon}</span>
              <span style={{ color: agent.color, fontWeight: 500 }}>{agent.name}</span>
              <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>{agent.description}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>协调者额外指令（可选）</label>
        <textarea
          className="w-full px-3 py-2 rounded-lg text-sm font-mono resize-y"
          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", minHeight: 80 }}
          value={form.coordinatorPrompt}
          onChange={(e) => setForm({ ...form, coordinatorPrompt: e.target.value })}
          placeholder="为协调者添加额外的工作指令..."
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          className="px-4 py-1.5 rounded-lg text-sm"
          style={{ color: "var(--color-text-muted)" }}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          className="px-4 py-1.5 rounded-lg text-sm text-white"
          style={{ background: "var(--color-accent)" }}
          onClick={() => onSave(form)}
          disabled={!form.name.trim() || form.agents.length === 0}
        >
          保存
        </button>
      </div>
    </div>
  );
}

// ─── Main Panel ─────────────────────────────────────────

export default function AgentTeamPanel({ onClose }: Props) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("agents");
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [teams, setTeams] = useState<TeamDef[]>([]);
  const [loading, setLoading] = useState(true);

  // Agent editing
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [creatingAgent, setCreatingAgent] = useState(false);

  // Team editing
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [creatingTeam, setCreatingTeam] = useState(false);

  // AI generation
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiGeneratedData, setAiGeneratedData] = useState<AgentFormData | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([listAgentDefs(), listTeamDefs()]);
      setAgents(a);
      setTeams(t);
      // Refresh the role display cache so TeamPanel/StreamingBubble/MessageBubble
      // pick up newly created or updated agents
      refreshRoleCache();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Agent handlers ───
  const handleSaveAgent = async (data: AgentFormData) => {
    try {
      if (editingAgentId) {
        await updateAgentDef(editingAgentId, data);
        toast("Agent 已更新", "success");
      } else {
        await createAgentDef(data);
        toast("Agent 已创建", "success");
      }
      setEditingAgentId(null);
      setCreatingAgent(false);
      setAiGeneratedData(null);
      loadData();
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const handleDeleteAgent = async (id: string) => {
    try {
      await apiDeleteAgent(id);
      toast("Agent 已删除", "success");
      loadData();
    } catch (e) {
      toast(String(e), "error");
    }
  };

  // ─── Team handlers ───
  const handleSaveTeam = async (data: TeamFormData) => {
    try {
      const payload = {
        ...data,
        coordinatorPrompt: data.coordinatorPrompt || undefined,
      };
      if (editingTeamId) {
        await updateTeamDef(editingTeamId, payload);
        toast("Team 已更新", "success");
      } else {
        await createTeamDef(payload);
        toast("Team 已创建", "success");
      }
      setEditingTeamId(null);
      setCreatingTeam(false);
      loadData();
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const handleDeleteTeam = async (id: string) => {
    try {
      await apiDeleteTeam(id);
      toast("Team 已删除", "success");
      loadData();
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const editingAgent = editingAgentId ? agents.find((a) => a.id === editingAgentId) : null;
  const editingTeam = editingTeamId ? teams.find((t) => t.id === editingTeamId) : null;

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setAiGenerating(true);
    try {
      const generated = await generateAgentDef(aiPrompt.trim());
      // Pre-fill the form with AI-generated data
      setCreatingAgent(true);
      setAiGeneratedData(generated);
      setAiPrompt("");
      toast("AI 已生成 Agent 定义，请确认或微调后保存", "success");
    } catch (e) {
      toast("AI 生成失败: " + String(e), "error");
    } finally {
      setAiGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1" onClick={onClose} />
      {/* Panel */}
      <div
        className="w-[520px] h-full overflow-y-auto shadow-2xl flex flex-col"
        style={{ background: "var(--color-surface)", borderLeft: "1px solid var(--color-border)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--color-border)" }}>
          <h2 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>
            Agent & Team 管理
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b px-5" style={{ borderColor: "var(--color-border)" }}>
          {(["agents", "teams"] as Tab[]).map((t) => (
            <button
              key={t}
              className="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors"
              style={{
                color: tab === t ? "var(--color-accent)" : "var(--color-text-muted)",
                borderColor: tab === t ? "var(--color-accent)" : "transparent",
              }}
              onClick={() => { setTab(t); setEditingAgentId(null); setCreatingAgent(false); setEditingTeamId(null); setCreatingTeam(false); setAiGeneratedData(null); }}
            >
              {t === "agents" ? "Agents" : "Teams"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="text-center py-8" style={{ color: "var(--color-text-muted)" }}>加载中...</div>
          ) : tab === "agents" ? (
            <div className="space-y-3">
              {/* Create / Edit form */}
              {(creatingAgent || editingAgentId) && (
                <div className="rounded-xl p-4" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
                  <h3 className="text-sm font-medium mb-3" style={{ color: "var(--color-text)" }}>
                    {editingAgentId ? "编辑 Agent" : "创建 Agent"}
                  </h3>
                  <AgentForm
                    key={editingAgentId ?? (aiGeneratedData ? "ai" : "manual")}
                    initial={editingAgent ? {
                      name: editingAgent.name,
                      description: editingAgent.description,
                      icon: editingAgent.icon,
                      color: editingAgent.color,
                      systemPrompt: editingAgent.systemPrompt,
                      deniedTools: editingAgent.deniedTools,
                    } : aiGeneratedData ?? undefined}
                    onSave={handleSaveAgent}
                    onCancel={() => { setEditingAgentId(null); setCreatingAgent(false); setAiGeneratedData(null); }}
                  />
                </div>
              )}

              {/* Add buttons */}
              {!creatingAgent && !editingAgentId && (
                <div className="space-y-2">
                  {/* AI Generation input */}
                  <div
                    className="rounded-xl p-3"
                    style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                  >
                    <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--color-accent)" }}>
                      AI 一键生成
                    </label>
                    <div className="flex gap-2">
                      <input
                        className="flex-1 px-3 py-2 rounded-lg text-sm"
                        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                        value={aiPrompt}
                        onChange={(e) => setAiPrompt(e.target.value)}
                        placeholder="描述你想要的 Agent，如：擅长代码审查的高级工程师"
                        onKeyDown={(e) => { if (e.key === "Enter" && !aiGenerating && aiPrompt.trim()) handleAiGenerate(); }}
                        disabled={aiGenerating}
                      />
                      <button
                        className="px-4 py-2 rounded-lg text-sm text-white whitespace-nowrap"
                        style={{ background: aiGenerating ? "var(--color-text-muted)" : "var(--color-accent)" }}
                        onClick={handleAiGenerate}
                        disabled={aiGenerating || !aiPrompt.trim()}
                      >
                        {aiGenerating ? "生成中..." : "生成"}
                      </button>
                    </div>
                  </div>
                  {/* Manual create button */}
                  <button
                    className="w-full py-2 rounded-lg text-sm border-2 border-dashed transition-colors"
                    style={{ color: "var(--color-accent)", borderColor: "var(--color-border)" }}
                    onClick={() => setCreatingAgent(true)}
                  >
                    + 手动创建 Agent
                  </button>
                </div>
              )}

              {/* Agent list */}
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="rounded-xl p-3 flex items-start gap-3"
                  style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                >
                  <span className="text-xl mt-0.5">{agent.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm" style={{ color: agent.color }}>{agent.name}</span>
                      {agent.builtIn && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}>
                          内置
                        </span>
                      )}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: "var(--color-text-muted)" }}>{agent.description}</div>
                    {agent.deniedTools.length > 0 && (
                      <div className="text-[10px] mt-1" style={{ color: "var(--color-text-muted)" }}>
                        禁用: {agent.deniedTools.join(", ")}
                      </div>
                    )}
                  </div>
                  {!agent.builtIn && (
                    <div className="flex gap-1">
                      <button
                        className="text-xs px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]"
                        style={{ color: "var(--color-text-muted)" }}
                        onClick={() => { setEditingAgentId(agent.id); setCreatingAgent(false); }}
                      >
                        编辑
                      </button>
                      <button
                        className="text-xs px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]"
                        style={{ color: "var(--color-error-text)" }}
                        onClick={() => handleDeleteAgent(agent.id)}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Create / Edit form */}
              {(creatingTeam || editingTeamId) && (
                <div className="rounded-xl p-4" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
                  <h3 className="text-sm font-medium mb-3" style={{ color: "var(--color-text)" }}>
                    {editingTeamId ? "编辑 Team" : "创建 Team"}
                  </h3>
                  <TeamForm
                    allAgents={agents}
                    initial={editingTeam ? {
                      name: editingTeam.name,
                      description: editingTeam.description,
                      agents: editingTeam.agents,
                      coordinatorPrompt: editingTeam.coordinatorPrompt ?? "",
                    } : undefined}
                    onSave={handleSaveTeam}
                    onCancel={() => { setEditingTeamId(null); setCreatingTeam(false); }}
                  />
                </div>
              )}

              {/* Add button */}
              {!creatingTeam && !editingTeamId && (
                <button
                  className="w-full py-2 rounded-lg text-sm border-2 border-dashed transition-colors"
                  style={{ color: "var(--color-accent)", borderColor: "var(--color-border)" }}
                  onClick={() => setCreatingTeam(true)}
                >
                  + 新建 Team
                </button>
              )}

              {/* Team list */}
              {teams.map((team) => {
                const teamAgents = team.agents.map((id) => agents.find((a) => a.id === id)).filter(Boolean) as AgentDef[];
                return (
                  <div
                    key={team.id}
                    className="rounded-xl p-3"
                    style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm" style={{ color: "var(--color-text)" }}>{team.name}</span>
                          {team.builtIn && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}>
                              内置
                            </span>
                          )}
                        </div>
                        <div className="text-xs mt-0.5" style={{ color: "var(--color-text-muted)" }}>{team.description}</div>
                      </div>
                      <div className="flex gap-1">
                        <button
                          className="text-xs px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]"
                          style={{ color: "var(--color-text-muted)" }}
                          onClick={() => { setEditingTeamId(team.id); setCreatingTeam(false); }}
                        >
                          编辑
                        </button>
                        {!team.builtIn && (
                          <button
                            className="text-xs px-2 py-1 rounded hover:bg-[var(--color-surface-hover)]"
                            style={{ color: "var(--color-error-text)" }}
                            onClick={() => handleDeleteTeam(team.id)}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Team members */}
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {teamAgents.map((a) => (
                        <span
                          key={a.id}
                          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                          style={{ background: a.color + "20", color: a.color }}
                        >
                          {a.icon} {a.name}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
