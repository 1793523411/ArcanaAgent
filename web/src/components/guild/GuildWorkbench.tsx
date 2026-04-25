import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useGuild } from "../../hooks/useGuild";
import { useGuildStream } from "../../hooks/useGuildStream";
import { useConfig } from "../../hooks/useConfig";
import GroupList from "./GroupList";
import TaskBoard from "./TaskBoard";
import DetailPanel from "./DetailPanel";
import Chevron from "./Chevron";
import CreateGroupModal from "./CreateGroupModal";
import CreateAgentModal from "./CreateAgentModal";
import LiveAgentPanel from "./LiveAgentPanel";
import GuildArtifactPanel from "./GuildArtifactPanel";
import GroupAssetPanel from "./GroupAssetPanel";
import Select from "./Select";
import type { GuildTask, Group } from "../../types/guild";

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
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<DetailTarget>(null);
  const [viewingLogTaskId, setViewingLogTaskId] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [showGroupAssets, setShowGroupAssets] = useState(false);
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
  // Collapsible left panel — persisted; mirrors detailCollapsed pattern.
  const [leftCollapsed, setLeftCollapsedState] = useState<boolean>(() => {
    try { return localStorage.getItem("guild.leftCollapsed") === "1"; } catch { return false; }
  });
  const setLeftCollapsed = (v: boolean) => {
    setLeftCollapsedState(v);
    try { localStorage.setItem("guild.leftCollapsed", v ? "1" : "0"); } catch {}
  };

  // Resizable right panel
  const [detailWidth, setDetailWidth] = useState(320);
  const [resizing, setResizing] = useState(false);
  // Collapsible right panel — persisted so users don't have to re-close each session
  const [detailCollapsed, setDetailCollapsedState] = useState<boolean>(() => {
    try { return localStorage.getItem("guild.detailCollapsed") === "1"; } catch { return false; }
  });
  const setDetailCollapsed = (v: boolean) => {
    setDetailCollapsedState(v);
    try { localStorage.setItem("guild.detailCollapsed", v ? "1" : "0"); } catch {}
  };

  // Resizable artifact panel
  const [artifactWidth, setArtifactWidth] = useState(340);
  const [artifactResizing, setArtifactResizing] = useState(false);

  useEffect(() => {
    const isLeft = leftResizing;
    const isRight = resizing;
    const isArtifact = artifactResizing;
    if (!isLeft && !isRight && !isArtifact) return;
    const onMove = (e: MouseEvent) => {
      if (isLeft) {
        setLeftWidth(Math.min(400, Math.max(160, e.clientX)));
      }
      if (isRight && !isArtifact) {
        const w = window.innerWidth - e.clientX;
        setDetailWidth(Math.min(600, Math.max(240, w)));
      }
      if (isArtifact) {
        const w = window.innerWidth - e.clientX;
        setArtifactWidth(Math.min(700, Math.max(260, w)));
      }
    };
    const onUp = () => { setLeftResizing(false); setResizing(false); setArtifactResizing(false); };
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
  }, [leftResizing, resizing, artifactResizing]);

  // Auto-expand the detail panel when user selects something while collapsed —
  // otherwise the click appears to do nothing.
  useEffect(() => {
    if (selectedDetail && detailCollapsed) setDetailCollapsed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDetail]);

  // Prefer REST-backed guild.agents as the source of truth for identity and
  // group membership (groupId, updatedAt, etc). Only overlay live-execution
  // fields from the SSE stream — those flip rapidly during a run and aren't
  // reflected in the REST snapshot until the next loadAll(). This prevents a
  // stale stream copy from shadowing the fresh REST data after a membership
  // change (e.g. after removing an agent from a group).
  const mergedAgents = guild.agents.map((a) => {
    const sa = stream.agents.find((s) => s.id === a.id);
    if (!sa) return a;
    return { ...a, status: sa.status, currentTaskId: sa.currentTaskId };
  });

  // Merge stream tasks with REST tasks — deduplicate by task id using a Map.
  // REST is the baseline; SSE overwrites with fresher state for the same id.
  // This prevents duplicates from the REST+SSE race on task creation.
  const mergedTasks = guild.selectedGroupId
    ? (() => {
        const gid = guild.selectedGroupId;
        const map = new Map<string, typeof guild.tasks[number]>();
        for (const t of guild.tasks) {
          if (t.groupId === gid) map.set(t.id, t);
        }
        for (const st of stream.tasks) {
          if (st.groupId && st.groupId !== gid) continue;
          map.set(st.id, st);
        }
        return Array.from(map.values());
      })()
    : [];

  const selectedAgent = selectedDetail?.type === "agent"
    ? mergedAgents.find((a) => a.id === selectedDetail.id) ?? null
    : null;

  const selectedTask = selectedDetail?.type === "task"
    ? mergedTasks.find((t) => t.id === selectedDetail.id) ?? null
    : null;

  /** Wrap a mutation with success / error toasts. Returns whatever the op returns (or undefined on failure). */
  async function withToast<T>(
    op: () => Promise<T>,
    successMsg: string,
    errorPrefix: string,
  ): Promise<T | undefined> {
    try {
      const result = await op();
      showToast(successMsg, "success");
      return result;
    } catch (e) {
      showToast(`${errorPrefix}: ${e}`, "error");
      return undefined;
    }
  }

  const handleCreateTask = async (
    text: string,
    priority: "low" | "medium" | "high" | "urgent",
    kind: NonNullable<GuildTask["kind"]>,
  ) => {
    if (!guild.selectedGroupId) return;
    setCreatingTask(true);
    try {
      await guild.createTask(guild.selectedGroupId, { title: text, description: text, priority, kind });
      showToast(kind === "requirement" ? "需求已提交，Lead 将开始分解" : "任务已创建", "success");
    } catch (e) {
      showToast(`创建任务失败: ${e}`, "error");
    } finally {
      setCreatingTask(false);
    }
  };

  const handleCreateTaskFromPipeline = async (payload: {
    pipelineId: string;
    inputs: Record<string, string>;
    priority: GuildTask["priority"];
    title?: string;
  }) => {
    if (!guild.selectedGroupId) return;
    setCreatingTask(true);
    try {
      await guild.createTaskFromPipeline(guild.selectedGroupId, payload);
      showToast(`已按流水线模板创建任务`, "success");
    } catch (e) {
      showToast(`创建任务失败: ${e}`, "error");
    } finally {
      setCreatingTask(false);
    }
  };

  const handleSetGroupLead = async (groupId: string, agentId: string | null) => {
    await withToast(() => guild.setGroupLead(groupId, agentId), agentId ? "Lead 已设置" : "已清除 Lead", "设置 Lead 失败");
  };

  const handleUpdateGroup = async (groupId: string, payload: { name?: string; description?: string; artifactStrategy?: "isolated" | "collaborative" }) => {
    await withToast(() => guild.updateGroup(groupId, payload), "小组已更新", "更新小组失败");
  };

  const handleAutoBid = async (taskId: string) => {
    if (!guild.selectedGroupId) return;
    try {
      const result = await guild.autoBid(guild.selectedGroupId, taskId);
      if (!result.assigned) {
        showToast(result.message ?? "没有 Agent 达到竞标门槛，请检查小组成员和资产配置", "info");
      } else {
        showToast("已自动分配给最合适的 Agent", "success");
      }
    } catch (e) {
      showToast(`竞标失败: ${e}`, "error");
    }
  };

  const handleDeleteTask = async (taskId: string) =>
    void withToast(() => guild.deleteTask(taskId), "任务已删除", "删除任务失败");

  const handleAssignTask = async (taskId: string, agentId: string) => {
    if (!guild.selectedGroupId) return;
    await withToast(
      () => guild.assignTask(guild.selectedGroupId!, taskId, agentId),
      "任务已分配",
      "分配失败",
    );
  };

  const handleCreateGroup = async (payload: { name: string; description: string; sharedContext?: string; artifactStrategy?: "isolated" | "collaborative" }) => {
    await withToast(() => guild.createGroup(payload), "小组已创建", "创建小组失败");
  };

  const handleDeleteGroup = async (groupId: string) => {
    await withToast(() => guild.deleteGroup(groupId), "小组已删除", "删除小组失败");
  };

  const handleAddAgentToGroup = async (groupId: string, agentId: string) => {
    await withToast(() => guild.addAgentToGroup(groupId, agentId), "已添加成员", "添加成员失败");
  };

  const handleRemoveAgentFromGroup = async (groupId: string, agentId: string) => {
    await withToast(() => guild.removeAgentFromGroup(groupId, agentId), "已移除成员", "移除成员失败");
  };

  const handleSaveAgent = async (payload: Parameters<typeof guild.createAgent>[0]) => {
    if (editingAgent) {
      await withToast(() => guild.updateAgent(editingAgent, payload), "Agent 已更新", "更新 Agent 失败");
    } else {
      await withToast(() => guild.createAgent(payload), "Agent 已创建", "创建 Agent 失败");
    }
  };

  const handleDeleteAgent = async (agentId: string) => {
    const ok = await withToast(() => guild.deleteAgent(agentId), "Agent 已删除", "删除 Agent 失败");
    if (ok !== undefined) setSelectedDetail(null);
  };

  const handleReleaseAgent = async (agentId: string) => {
    await withToast(() => guild.releaseAgent(agentId), "Agent 已释放", "释放 Agent 失败");
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
          <Select
            value={globalModelId ?? ""}
            onChange={setGlobalModelId}
            leadingLabel="模型"
            title="全局执行模型"
            options={models.map((m) => ({
              value: m.id,
              label: m.name,
              hint: m.provider,
            }))}
          />
          {/* Group asset panel toggle */}
          {guild.selectedGroupId && (
            <button
              onClick={() => setShowGroupAssets((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
              style={{
                background: showGroupAssets ? "var(--color-accent)" : "transparent",
                color: showGroupAssets ? "white" : "var(--color-text-muted)",
                border: showGroupAssets ? "none" : "1px solid var(--color-border)",
              }}
              title="管理小组资产"
            >
              🗂️ 资产
            </button>
          )}
          {/* Artifact panel toggle */}
          {guild.selectedGroupId && (
            <button
              onClick={() => setShowArtifacts((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
              style={{
                background: showArtifacts ? "var(--color-accent)" : "transparent",
                color: showArtifacts ? "white" : "var(--color-text-muted)",
                border: showArtifacts ? "none" : "1px solid var(--color-border)",
              }}
              title="查看 Agent 声明的交付清单（Handoff artifacts）"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              交付
              {mergedTasks.filter((t) => t.result?.handoff?.artifacts?.length).length > 0 && (
                <span
                  className="text-[10px] px-1 rounded-full"
                  style={{
                    background: showArtifacts ? "rgba(255,255,255,0.25)" : "var(--color-accent-alpha)",
                    color: showArtifacts ? "white" : "var(--color-accent)",
                  }}
                >
                  {mergedTasks.reduce((n, t) => n + (t.result?.handoff?.artifacts?.length ?? 0), 0)}
                </span>
              )}
            </button>
          )}
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
            title="退出 Guild 模式，返回普通对话"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>返回普通模式</span>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left: group list — collapsible. When collapsed, renders a thin
            vertical strip mirroring the right detail-panel collapse pattern.
            Saves the user ~220px of horizontal real estate when they're
            heads-down on a single group. */}
        {leftCollapsed ? (
          <button
            className="w-7 shrink-0 flex flex-col items-center justify-center gap-2 border-r transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
            onClick={() => setLeftCollapsed(false)}
            title="展开小组列表"
            aria-label="展开小组列表"
          >
            <Chevron direction="right" size={14} />
            <span className="text-[10px]" style={{ writingMode: "vertical-rl" }}>小组</span>
          </button>
        ) : (
          <>
            <div
              className="shrink-0 overflow-hidden flex flex-col"
              style={{ width: leftWidth, background: "var(--color-surface)", borderRight: "none" }}
            >
              {/* Inline collapse trigger sits above the list — small, unobtrusive,
                  doesn't interfere with the existing GroupList chrome. */}
              <div className="flex items-center justify-end px-2 py-1 border-b" style={{ borderColor: "var(--color-border)" }}>
                <button
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                  style={{ color: "var(--color-text-muted)" }}
                  onClick={() => setLeftCollapsed(true)}
                  title="收起小组列表"
                  aria-label="收起小组列表"
                >
                  <Chevron direction="left" size={12} />
                  收起
                </button>
              </div>
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
                  onAddAgentToGroup={handleAddAgentToGroup}
                  onRemoveAgentFromGroup={handleRemoveAgentFromGroup}
                  onDeleteGroup={handleDeleteGroup}
                  onSetGroupLead={handleSetGroupLead}
                  onEditGroup={setEditingGroup}
                />
              )}
            </div>

            {/* Left resize handle */}
            <div
              className="w-1.5 shrink-0 cursor-col-resize hover:bg-[var(--color-accent)] transition-colors"
              style={{ background: leftResizing ? "var(--color-accent)" : "var(--color-border)" }}
              onMouseDown={(e) => { e.preventDefault(); setLeftResizing(true); }}
            />
          </>
        )}

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
                  onCreateTaskFromPipeline={handleCreateTaskFromPipeline}
                  onAutoBid={handleAutoBid}
                  onDeleteTask={handleDeleteTask}
                  onAssignTask={handleAssignTask}
                  onStopTask={async (taskId) => {
                    const t = mergedTasks.find((x) => x.id === taskId);
                    if (!t?.assignedAgentId) {
                      showToast("任务未分配 Agent，无法停止", "info");
                      return;
                    }
                    await withToast(
                      () => guild.releaseAgent(t.assignedAgentId!),
                      "任务已停止，Agent 已释放",
                      "停止任务失败",
                    );
                  }}
                  creating={creatingTask}
                />
              </div>
              <LiveAgentPanel
                agents={mergedAgents}
                taskExecutions={stream.taskExecutions}
                schedulerLog={stream.schedulerLog}
                onClearSchedulerLog={stream.clearSchedulerLog}
                onCloseTab={(taskId) => {
                  stream.removeTaskExecution(taskId);
                  if (viewingLogTaskId === taskId) setViewingLogTaskId(null);
                }}
                activeTaskId={viewingLogTaskId}
              />
            </>
          )}
        </div>

        {/* Collapsed: thin vertical expand strip. Expanded: resize handle + full panel. */}
        {detailCollapsed ? (
          <button
            className="w-7 shrink-0 flex flex-col items-center justify-center gap-2 border-l transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
            onClick={() => setDetailCollapsed(false)}
            title="展开详情面板"
            aria-label="展开详情面板"
          >
            <Chevron direction="right" size={14} />
            <span className="text-[10px]" style={{ writingMode: "vertical-rl" }}>详情</span>
          </button>
        ) : (
          <>
            <div
              className="w-1.5 shrink-0 cursor-col-resize hover:bg-[var(--color-accent)] transition-colors"
              style={{ background: resizing ? "var(--color-accent)" : "var(--color-border)" }}
              onMouseDown={(e) => { e.preventDefault(); setResizing(true); }}
            />
            <div
              className="shrink-0 overflow-hidden flex flex-col"
              style={{ width: detailWidth, background: "var(--color-surface)" }}
            >
              <DetailPanel
                selectedAgent={selectedAgent}
                selectedTask={selectedTask}
                agents={mergedAgents}
                tasks={mergedTasks}
                agentOutputs={stream.agentOutputs}
                staleTaskIds={stream.staleTaskIds}
                onClose={() => setSelectedDetail(null)}
                onCollapse={() => setDetailCollapsed(true)}
                onEditAgent={(id) => setEditingAgent(id)}
                onDeleteAgent={handleDeleteAgent}
                onReleaseAgent={handleReleaseAgent}
                onAgentForked={async (newId) => {
                  await guild.loadAll();
                  setSelectedDetail({ type: "agent", id: newId });
                  setEditingAgent(newId);
                  showToast("已派生新 Agent，打开编辑", "success");
                }}
                onViewLog={async (taskId) => {
                  await stream.loadTaskLog(taskId);
                  setViewingLogTaskId(taskId);
                }}
                onSelectTask={(id) => setSelectedDetail({ type: "task", id })}
                onOpenWorkspace={() => {
                  setShowArtifacts(true);
                }}
              />
            </div>
          </>
        )}

        {/* Artifact panel (toggled, resizable) */}
        {showArtifacts && (
          <>
            <div
              className="w-1.5 shrink-0 cursor-col-resize hover:bg-[var(--color-accent)] transition-colors"
              style={{ background: artifactResizing ? "var(--color-accent)" : "var(--color-border)" }}
              onMouseDown={(e) => { e.preventDefault(); setArtifactResizing(true); }}
            />
            <div className="shrink-0 overflow-hidden flex flex-col" style={{ width: artifactWidth }}>
              <GuildArtifactPanel
                tasks={mergedTasks}
                agents={mergedAgents}
                groupId={guild.selectedGroupId}
                artifactStrategy={guild.groups.find(g => g.id === guild.selectedGroupId)?.artifactStrategy}
                onClose={() => setShowArtifacts(false)}
                onSelectTask={(id) => {
                  setSelectedDetail({ type: "task", id });
                  setShowArtifacts(false);
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      {showCreateGroup && (
        <CreateGroupModal
          agents={mergedAgents}
          onAIDone={async (groupId) => {
            // Reload REST snapshot so the newly-created group + agents show up,
            // then focus the new group.
            await guild.loadAll();
            guild.setSelectedGroupId(groupId);
            showToast("AI 已创建小组与成员", "success");
          }}
          onConfirm={handleCreateGroup}
          onClose={() => setShowCreateGroup(false)}
        />
      )}
      {editingGroup && (
        <CreateGroupModal
          key={editingGroup.id}
          initial={{
            name: editingGroup.name,
            description: editingGroup.description,
            artifactStrategy: editingGroup.artifactStrategy,
          }}
          onConfirm={(payload) => handleUpdateGroup(editingGroup.id, payload)}
          onClose={() => setEditingGroup(null)}
        />
      )}
      {(showCreateAgent || editingAgent) && (
        <CreateAgentModal
          editAgent={editingAgent ? mergedAgents.find((a) => a.id === editingAgent) : undefined}
          onConfirm={(payload) => handleSaveAgent(payload as Parameters<typeof guild.createAgent>[0])}
          onClose={() => { setShowCreateAgent(false); setEditingAgent(null); }}
        />
      )}

      {/* Group Asset Panel */}
      {showGroupAssets && guild.selectedGroupId && (
        <GroupAssetPanel
          groupId={guild.selectedGroupId}
          agents={mergedAgents}
          onClose={() => setShowGroupAssets(false)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] animate-fade-in">
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
