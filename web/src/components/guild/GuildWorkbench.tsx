import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useGuild } from "../../hooks/useGuild";
import { useGuildStream } from "../../hooks/useGuildStream";
import { useConfig } from "../../hooks/useConfig";
import GroupList from "./GroupList";
import TaskBoard from "./TaskBoard";
import DetailPanel from "./DetailPanel";
import CreateGroupModal from "./CreateGroupModal";
import CreateAgentModal from "./CreateAgentModal";
import LiveAgentPanel from "./LiveAgentPanel";

interface Props {
  onClose: () => void;
  initialGroupId?: string;
}

type DetailTarget = { type: "agent"; id: string } | { type: "task"; id: string } | null;

export default function GuildWorkbench({ onClose, initialGroupId }: Props) {
  const navigate = useNavigate();
  const guild = useGuild();
  const stream = useGuildStream(guild.selectedGroupId);
  const { models, modelId: globalModelId, setModelId: setGlobalModelId } = useConfig();

  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<DetailTarget>(null);
  const [viewingLogTaskId, setViewingLogTaskId] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: "info" | "error" | "success" } | null>(null);

  const showToast = (text: string, type: "info" | "error" | "success" = "info") => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Set initial group from URL hash
  useEffect(() => {
    if (initialGroupId && !guild.loading && guild.groups.some((g) => g.id === initialGroupId)) {
      guild.setSelectedGroupId(initialGroupId);
    }
  }, [initialGroupId, guild.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync selected group to URL path (only after groups loaded, to avoid wiping initial URL param)
  useEffect(() => {
    if (guild.loading) return;
    const target = guild.selectedGroupId ? `/guild/${guild.selectedGroupId}` : "/guild";
    if (window.location.pathname !== target) {
      navigate(target, { replace: true });
    }
  }, [guild.selectedGroupId, guild.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resizable left panel
  const [leftWidth, setLeftWidth] = useState(224);
  const [leftResizing, setLeftResizing] = useState(false);

  // Resizable right panel
  const [detailWidth, setDetailWidth] = useState(320);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const isLeft = leftResizing;
    const isRight = resizing;
    if (!isLeft && !isRight) return;
    const onMove = (e: MouseEvent) => {
      if (isLeft) {
        setLeftWidth(Math.min(400, Math.max(160, e.clientX)));
      }
      if (isRight) {
        const w = window.innerWidth - e.clientX;
        setDetailWidth(Math.min(600, Math.max(240, w)));
      }
    };
    const onUp = () => { setLeftResizing(false); setResizing(false); };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [leftResizing, resizing]);

  // Merge stream agents with REST agents
  const mergedAgents = guild.agents.map((a) => {
    const streamAgent = stream.agents.find((sa) => sa.id === a.id);
    return streamAgent ?? a;
  });

  // Merge stream tasks with REST tasks
  const mergedTasks = guild.selectedGroupId
    ? (() => {
        const base = guild.tasks.slice();
        for (const st of stream.tasks) {
          const idx = base.findIndex((t) => t.id === st.id);
          if (idx >= 0) base[idx] = st;
          else base.push(st);
        }
        return base;
      })()
    : [];

  const selectedAgent = selectedDetail?.type === "agent"
    ? mergedAgents.find((a) => a.id === selectedDetail.id) ?? null
    : null;

  const selectedTask = selectedDetail?.type === "task"
    ? mergedTasks.find((t) => t.id === selectedDetail.id) ?? null
    : null;

  const handleCreateTask = async (text: string) => {
    if (!guild.selectedGroupId) return;
    setCreatingTask(true);
    try {
      await guild.createTask(guild.selectedGroupId, { title: text, description: text, priority: "medium" });
    } catch {
      // ignore
    } finally {
      setCreatingTask(false);
    }
  };

  const handleAutoBid = async (taskId: string) => {
    if (!guild.selectedGroupId) return;
    try {
      const result = await guild.autoBid(guild.selectedGroupId, taskId);
      if (!result.assigned) {
        showToast(result.message ?? "没有 Agent 达到竞标门槛，请检查小组成员和资产配置", "info");
      }
    } catch (e) {
      showToast(`竞标失败: ${e}`, "error");
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      await guild.deleteTask(taskId);
    } catch {
      // ignore
    }
  };

  const handleAssignTask = async (taskId: string, agentId: string) => {
    if (!guild.selectedGroupId) return;
    try {
      await guild.assignTask(guild.selectedGroupId, taskId, agentId);
    } catch (e) {
      showToast(`分配失败: ${e}`, "error");
    }
  };

  // Check if this is a fresh/empty guild for onboarding
  const isEmpty = guild.agents.length === 0 && guild.groups.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--color-bg)" }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-3 border-b shrink-0"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">⚔️</span>
          <div>
            <h1 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
              {guild.guild?.name ?? "Guild 工作台"}
            </h1>
            {guild.guild?.description && (
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>{guild.guild.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Global model selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>模型</span>
            <select
              className="px-2 py-1 rounded-lg text-xs"
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
                maxWidth: 200,
              }}
              value={globalModelId ?? ""}
              onChange={(e) => setGlobalModelId(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left: group list */}
        <div
          className="shrink-0 overflow-hidden flex flex-col"
          style={{ width: leftWidth, background: "var(--color-surface)", borderRight: "none" }}
        >
          {guild.loading ? (
            <div className="flex-1 flex items-center justify-center text-xs" style={{ color: "var(--color-text-muted)" }}>
              加载中...
            </div>
          ) : (
            <GroupList
              groups={guild.groups}
              agents={mergedAgents}
              selectedGroupId={guild.selectedGroupId}
              onSelectGroup={(id) => {
                guild.setSelectedGroupId(id);
                setSelectedDetail(null);
              }}
              onSelectAgent={(id) => setSelectedDetail({ type: "agent", id })}
              onCreateGroup={() => setShowCreateGroup(true)}
              onCreateAgent={() => setShowCreateAgent(true)}
              onAddAgentToGroup={guild.addAgentToGroup}
              onRemoveAgentFromGroup={guild.removeAgentFromGroup}
              onDeleteGroup={guild.deleteGroup}
            />
          )}
        </div>

        {/* Left resize handle */}
        <div
          className="w-1.5 shrink-0 cursor-col-resize hover:bg-[var(--color-accent)] transition-colors"
          style={{ background: leftResizing ? "var(--color-accent)" : "var(--color-border)" }}
          onMouseDown={(e) => { e.preventDefault(); setLeftResizing(true); }}
        />

        {/* Center: task board or onboarding */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {isEmpty && !guild.loading ? (
            <OnboardingGuide
              onCreateAgent={() => setShowCreateAgent(true)}
              onCreateGroup={() => setShowCreateGroup(true)}
            />
          ) : !guild.selectedGroupId ? (
            <div className="flex-1 flex items-center justify-center flex-col gap-2" style={{ color: "var(--color-text-muted)" }}>
              <div className="text-3xl">🏰</div>
              <div className="text-sm">请从左侧选择一个小组</div>
              {guild.groups.length === 0 && (
                <button
                  className="mt-2 text-sm px-4 py-2 rounded-lg"
                  style={{ background: "var(--color-accent)", color: "white" }}
                  onClick={() => setShowCreateGroup(true)}
                >
                  创建第一个小组
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="flex-1 min-h-0 overflow-hidden">
                <TaskBoard
                  tasks={mergedTasks}
                  agents={mergedAgents}
                  groupAgentIds={guild.selectedGroup?.agents ?? []}
                  selectedTaskId={selectedDetail?.type === "task" ? selectedDetail.id : null}
                  onSelectTask={(id) => setSelectedDetail({ type: "task", id })}
                  onCreateTask={handleCreateTask}
                  onAutoBid={handleAutoBid}
                  onDeleteTask={handleDeleteTask}
                  onAssignTask={handleAssignTask}
                  creating={creatingTask}
                />
              </div>
              <LiveAgentPanel
                agents={mergedAgents}
                taskExecutions={stream.taskExecutions}
                onCloseTab={(taskId) => {
                  stream.removeTaskExecution(taskId);
                  if (viewingLogTaskId === taskId) setViewingLogTaskId(null);
                }}
                activeTaskId={viewingLogTaskId}
              />
            </>
          )}
        </div>

        {/* Resize handle */}
        <div
          className="w-1.5 shrink-0 cursor-col-resize hover:bg-[var(--color-accent)] transition-colors"
          style={{ background: resizing ? "var(--color-accent)" : "var(--color-border)" }}
          onMouseDown={(e) => { e.preventDefault(); setResizing(true); }}
        />

        {/* Right: detail panel */}
        <div
          className="shrink-0 overflow-hidden flex flex-col"
          style={{ width: detailWidth, background: "var(--color-surface)" }}
        >
          <DetailPanel
            selectedAgent={selectedAgent}
            selectedTask={selectedTask}
            agents={mergedAgents}
            agentOutputs={stream.agentOutputs}
            onClose={() => setSelectedDetail(null)}
            onEditAgent={(id) => setEditingAgent(id)}
            onDeleteAgent={async (id) => {
              await guild.deleteAgent(id);
              setSelectedDetail(null);
            }}
            onViewLog={async (taskId) => {
              await stream.loadTaskLog(taskId);
              setViewingLogTaskId(taskId);
            }}
          />
        </div>
      </div>

      {/* Modals */}
      {showCreateGroup && (
        <CreateGroupModal
          onConfirm={guild.createGroup}
          onClose={() => setShowCreateGroup(false)}
        />
      )}
      {(showCreateAgent || editingAgent) && (
        <CreateAgentModal
          editAgent={editingAgent ? mergedAgents.find((a) => a.id === editingAgent) : undefined}
          onConfirm={async (payload) => {
            if (editingAgent) {
              await guild.updateAgent(editingAgent, payload);
            } else {
              await guild.createAgent(payload as Parameters<typeof guild.createAgent>[0]);
            }
          }}
          onClose={() => { setShowCreateAgent(false); setEditingAgent(null); }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] animate-fade-in">
          <div
            className="px-4 py-2.5 rounded-xl shadow-lg text-sm flex items-center gap-2"
            style={{
              background: toast.type === "error" ? "#ef4444" : toast.type === "success" ? "#22c55e" : "var(--color-surface)",
              color: toast.type === "info" ? "var(--color-text)" : "white",
              border: toast.type === "info" ? "1px solid var(--color-border)" : "none",
            }}
          >
            <span>{toast.type === "error" ? "!" : toast.type === "success" ? "OK" : "i"}</span>
            {toast.text}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Onboarding Guide ──────────────────────────────────────────

function OnboardingGuide({ onCreateAgent, onCreateGroup }: { onCreateAgent: () => void; onCreateGroup: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center">
          <div className="text-4xl mb-3">⚔️</div>
          <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--color-text)" }}>
            欢迎使用 Guild 工作台
          </h2>
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            Guild 模式让多个 AI Agent 自治协作，通过竞标制自动匹配最合适的 Agent 执行任务
          </p>
        </div>

        <div className="space-y-3">
          {[
            {
              step: 1,
              title: "创建 Agent",
              desc: "定义 Agent 的角色、技能和资产，Agent 会持久记忆和成长",
              action: onCreateAgent,
              actionLabel: "创建 Agent",
              icon: "🤖",
            },
            {
              step: 2,
              title: "创建小组",
              desc: "小组是协作单元，一组 Agent 围绕目标协同工作",
              action: onCreateGroup,
              actionLabel: "创建小组",
              icon: "👥",
            },
            {
              step: 3,
              title: "分配 Agent 到小组",
              desc: "将 Agent 从池中加入小组，Agent 携带资产和记忆加入",
              action: undefined,
              actionLabel: undefined,
              icon: "🔗",
            },
            {
              step: 4,
              title: "发布任务",
              desc: "在小组中创建任务，Agent 通过竞标自动领取并执行",
              action: undefined,
              actionLabel: undefined,
              icon: "📋",
            },
          ].map((item) => (
            <div
              key={item.step}
              className="flex items-start gap-3 px-4 py-3 rounded-xl"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
                style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}
              >
                {item.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: "var(--color-accent)", color: "white" }}
                  >
                    Step {item.step}
                  </span>
                  <span className="text-sm font-medium" style={{ color: "var(--color-text)" }}>{item.title}</span>
                </div>
                <p className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>{item.desc}</p>
              </div>
              {item.action && (
                <button
                  className="text-xs px-3 py-1.5 rounded-lg shrink-0"
                  style={{ background: "var(--color-accent)", color: "white" }}
                  onClick={item.action}
                >
                  {item.actionLabel}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
