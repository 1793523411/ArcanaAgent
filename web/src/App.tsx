import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useMatch } from "react-router-dom";
import { createConversation, deleteConversation, updateConversationTitle, exportConversation, getArtifacts, getMessages as fetchConversationMessages, compressConversation, submitApproval, listTeamDefs, listAgentDefs } from "./api";
import type { TeamDef, AgentDef } from "./types";
import { Sidebar, ToolSidebar, ChatPanel, WelcomeBox, SettingsPanel, PromptTemplatesPanel, DeleteConfirmModal, ArtifactPanel } from "./components";
import TeamPanel from "./components/TeamPanel";
import AgentTeamPanel from "./components/AgentTeamPanel";
import ScheduledTasksPanel from "./components/ScheduledTasksPanel";
import { useConversations, useSendMessage, useConfig } from "./hooks";
import { useToast } from "./components/Toast";
import { filterVisibleArtifacts } from "./artifactFilters";
import type { ConversationMode, SubagentLog } from "./types";

export default function App() {
  const match = useMatch("/c/:conversationId");
  const conversationIdFromUrl = match?.params.conversationId;
  const navigate = useNavigate();
  const { toast } = useToast();
  const [showConfig, setShowConfig] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showScheduledTasks, setShowScheduledTasks] = useState(false);
  const [showAgentTeam, setShowAgentTeam] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [showTeamPanel, setShowTeamPanel] = useState(false);
  const [artifactCount, setArtifactCount] = useState(0);
  const [executingTaskConversations, setExecutingTaskConversations] = useState<Set<string>>(new Set());
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [artifactPaneWidth, setArtifactPaneWidth] = useState(50);
  const [teamPaneWidth, setTeamPaneWidth] = useState(280);
  const [resizeTarget, setResizeTarget] = useState<"artifact" | "team" | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [draftMode, setDraftMode] = useState<ConversationMode>("default");
  const [draftTeamId, setDraftTeamId] = useState("default");
  const [teams, setTeams] = useState<TeamDef[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const mainRef = useRef<HTMLElement | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (typeof localStorage !== "undefined" && localStorage.getItem("rule-agent-theme") === "light" ? "light" : "dark")
  );
  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("rule-agent-theme", next);
    if (next === "light") document.documentElement.classList.add("theme-light");
    else document.documentElement.classList.remove("theme-light");
  }, [theme]);
  const { setModelId, models, modelId } = useConfig();
  const {
    conversations,
    current,
    setCurrent,
    messages,
    setMessages,
    loadList,
    loadError,
  } = useConversations(conversationIdFromUrl);
  const filteredConversations = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, sidebarSearch]);

  // Simplified teams for WelcomeBox selector
  const simplifiedTeams = useMemo(() => {
    return teams.map((t) => ({ id: t.id, name: t.name }));
  }, [teams]);

  // Current team info for the active conversation
  const currentTeam = useMemo(() => {
    if (!current?.teamId) return null;
    return teams.find((t) => t.id === current.teamId) ?? null;
  }, [current?.teamId, teams]);

  const {
    input,
    setInput,
    files,
    setFiles,
    send,
    loading,
    streamingContent,
    streamingReasoning,
    streamingStatus,
    streamingToolLogs,
    streamingSubagents,
    streamingPlan,
    pendingApprovals,
    sendError,
    usageTokens,
    contextUsage,
  } = useSendMessage({
    currentConversationId: current?.id,
    onAfterSend: loadList,
    setMessages,
    setCurrent,
  });

  // Shared approval state to prevent duplicate submissions from StreamingBubble + TeamPanel
  const [processingApprovals, setProcessingApprovals] = useState<Set<string>>(new Set());
  const handleApproval = useCallback(async (requestId: string, approved: boolean) => {
    if (!current?.id) return;
    if (processingApprovals.has(requestId)) return; // already processing
    setProcessingApprovals((prev) => new Set(prev).add(requestId));
    try {
      await submitApproval(current.id, requestId, approved);
    } catch {
      // approval removed via SSE approval_response event
    } finally {
      setProcessingApprovals((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  }, [current?.id, processingApprovals]);

  useEffect(() => {
    setShowArtifacts(false);
    setArtifactCount(0);
  }, [current?.id]);

  // Load teams list and agents list for team selector and member display
  useEffect(() => {
    Promise.all([listTeamDefs(), listAgentDefs()])
      .then(([teamsList, agentsList]) => {
        setTeams(teamsList);
        setAgents(agentsList);
      })
      .catch(() => {});
  }, [showAgentTeam]);

  useEffect(() => {
    if (!showArtifacts && resizeTarget === "artifact") setResizeTarget(null);
  }, [showArtifacts, resizeTarget]);

  useEffect(() => {
    if (!showTeamPanel && resizeTarget === "team") setResizeTarget(null);
  }, [showTeamPanel, resizeTarget]);

  const refreshArtifactCount = useCallback(() => {
    if (!current) return;
    getArtifacts(current.id).then((list) => setArtifactCount(filterVisibleArtifacts(list).length)).catch(() => {});
  }, [current]);

  useEffect(() => {
    refreshArtifactCount();
  }, [messages.length, loading, refreshArtifactCount]);

  const handleNewConversation = () => {
    navigate("/");
  };

  const handleLaunchFromTemplate = async (prompt: string) => {
    const text = prompt.trim();
    if (!text) {
      throw new Error("模板渲染结果为空");
    }
    const meta = await createConversation(undefined, draftMode, draftMode === "team" ? draftTeamId : undefined);
    setMessages([]);
    loadList();
    navigate(`/c/${meta.id}`);
    send(meta.id, text, [], meta.mode ?? draftMode);
  };

  const handleSelectConversation = (meta: { id: string }) => {
    navigate(`/c/${meta.id}`);
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTargetId(id);
  };

  const handleRename = async (id: string, title: string) => {
    await updateConversationTitle(id, title);
    loadList();
    if (current?.id === id) setCurrent((prev) => (prev ? { ...prev, title } : null));
  };

  const handleExport = async (id: string, format: "markdown" | "json") => {
    const blob = await exportConversation(id, format);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `conversation-${id}.${format === "json" ? "json" : "md"}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCompress = async () => {
    if (!current?.id || compressing) return;
    setCompressing(true);

    // 立即显示压缩提示
    toast("正在处理上下文，请稍候...", "info");

    try {
      const result = await compressConversation(current.id);

      // 根据结果显示不同的提示
      if (result.strategy === "compress" && result.olderCount && result.olderCount > 0) {
        toast(`压缩成功！已将 ${result.olderCount} 条旧消息压缩为摘要，保留 ${result.recentCount} 条最近消息`, "success");
      } else if (result.strategy === "trim" && result.trimToLast) {
        toast(`截断成功！已保留最近 ${result.trimToLast} 条消息`, "success");
      } else if (result.strategy === "compress" && (!result.olderCount || result.olderCount === 0)) {
        toast("消息数量较少，暂无需压缩", "info");
      } else {
        toast(`处理完成（策略：${result.strategy}）`, "success");
      }

      // 刷新消息列表以反映压缩后的效果
      await refreshConversationMessages(current.id);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (errorMsg.includes("至少需要5条消息")) {
        toast("消息数量太少，暂无需处理", "info");
      } else {
        toast(`处理失败: ${errorMsg}`, "error");
      }
    } finally {
      setCompressing(false);
    }
  };

  const [deleting, setDeleting] = useState(false);

  const handleDeleteConfirm = async () => {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    setDeleting(true);
    try {
      await deleteConversation(id);
      setDeleteTargetId(null);
      loadList();
      if (current?.id === id) {
        navigate("/");
        setCurrent(null);
        setMessages([]);
      }
      toast("对话已删除", "success");
    } catch (e) {
      toast(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setDeleting(false);
    }
  };

  const handleStartFromWelcome = async () => {
    try {
      const meta = await createConversation(undefined, draftMode, draftMode === "team" ? draftTeamId : undefined);
      setMessages([]);
      loadList();
      navigate(`/c/${meta.id}`);
      send(meta.id, undefined, undefined, meta.mode ?? draftMode);
    } catch (e) {
      toast(`创建对话失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const handleWelcomeSend = () => {
    if (current) {
      send(current.id, undefined, undefined, current.mode ?? "default");
    } else {
      handleStartFromWelcome();
    }
  };

  const error = sendError ?? loadError;

  const refreshConversationMessages = useCallback(async (conversationId: string) => {
    if (current?.id !== conversationId) return;
    try {
      const latestMessages = await fetchConversationMessages(conversationId);
      setMessages(Array.isArray(latestMessages) ? latestMessages : []);

      // 检查是否有AI回复，如果有则移除执行中状态
      if (executingTaskConversations.has(conversationId)) {
        const hasAiReply = Array.isArray(latestMessages) && latestMessages.some(m => m.type === 'ai');
        if (hasAiReply) {
          setExecutingTaskConversations(prev => {
            const next = new Set(prev);
            next.delete(conversationId);
            return next;
          });
        }
      }
    } catch {
      // ignore
    }
  }, [current?.id, setMessages, executingTaskConversations]);

  // 自动刷新当前会话（检测定时任务更新）
  useEffect(() => {
    if (!current?.id || loading) return;

    // 如果当前会话在执行任务，每3秒检查一次；否则每10秒
    const interval = executingTaskConversations.has(current.id) ? 3000 : 10000;

    const timer = setInterval(async () => {
      try {
        const latestMessages = await fetchConversationMessages(current.id);
        const newMessages = Array.isArray(latestMessages) ? latestMessages : [];

        // 如果消息数量不同，说明有更新
        if (newMessages.length !== messages.length) {
          setMessages(newMessages);

          // 如果这个对话在执行任务，检查是否有AI回复了
          if (executingTaskConversations.has(current.id)) {
            const hasAiReply = newMessages.some(m => m.type === 'ai');
            if (hasAiReply) {
              // 任务执行完成，移除执行中状态
              setExecutingTaskConversations(prev => {
                const next = new Set(prev);
                next.delete(current.id);
                return next;
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }, interval);

    return () => clearInterval(timer);
  }, [current?.id, messages.length, loading, setMessages, executingTaskConversations]);

  // 超时保护：2分钟后自动清除所有执行中状态（防止卡住）
  useEffect(() => {
    if (executingTaskConversations.size === 0) return;

    const timeout = setTimeout(() => {
      setExecutingTaskConversations(new Set());
      console.warn('Task execution timeout (120s), cleared all executing states');
    }, 120000); // 改为2分钟

    return () => clearTimeout(timeout);
  }, [executingTaskConversations]);

  // 键盘快捷键：Cmd/Ctrl+N 新对话，Cmd/Ctrl+K 聚焦输入框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleNewConversation();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        (document.querySelector("textarea") as HTMLTextAreaElement | null)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!resizeTarget) return;
    const onMove = (e: MouseEvent) => {
      const el = mainRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (resizeTarget === "artifact") {
        const leftPx = e.clientX - rect.left;
        const leftPercent = (leftPx / rect.width) * 100;
        const rightPercent = 100 - leftPercent;
        const clampedRight = Math.min(75, Math.max(25, rightPercent));
        setArtifactPaneWidth(clampedRight);
        return;
      }
      const nextTeamWidth = rect.right - e.clientX;
      const clampedTeamWidth = Math.min(520, Math.max(220, nextTeamWidth));
      setTeamPaneWidth(clampedTeamWidth);
    };
    const onUp = () => setResizeTarget(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizeTarget]);

  useEffect(() => {
    if (!resizeTarget) return;
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [resizeTarget]);

  return (
    <div className="flex h-screen overflow-hidden">
      <ToolSidebar
        onOpenTemplates={() => setShowTemplates(true)}
        onOpenConfig={() => setShowConfig(true)}
        onOpenScheduledTasks={() => setShowScheduledTasks(true)}
        onOpenAgentTeam={() => setShowAgentTeam(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <Sidebar
        conversations={filteredConversations}
        current={current}
        searchQuery={sidebarSearch}
        onSearchChange={setSidebarSearch}
        onSelect={handleSelectConversation}
        onDelete={handleDeleteClick}
        onRename={handleRename}
        onExport={handleExport}
        onNewConversation={handleNewConversation}
      />
      <main ref={mainRef} className="flex-1 flex min-w-0 min-h-0 overflow-hidden relative">
        <div
          className="flex flex-col min-w-0 min-h-0 overflow-hidden"
          style={showArtifacts && current ? { width: `${100 - artifactPaneWidth}%` } : { flex: 1 }}
        >
          {!current || messages.length === 0 ? (
            <WelcomeBox
              input={input}
              onInputChange={setInput}
              onSend={handleWelcomeSend}
              loading={loading}
              files={files}
              onFilesChange={setFiles}
              models={models}
              modelId={modelId}
              onModelChange={setModelId}
              mode={draftMode}
              onModeChange={setDraftMode}
              teams={simplifiedTeams}
              teamId={draftTeamId}
              onTeamChange={setDraftTeamId}
            />
          ) : (
            <ChatPanel
              messages={messages}
              conversationId={current.id}
              input={input}
              onInputChange={setInput}
              onSend={() => send(current.id, undefined, undefined, current.mode ?? "default")}
              loading={loading}
              streamingContent={streamingContent}
              streamingReasoning={streamingReasoning}
              streamingStatus={streamingStatus}
              streamingToolLogs={streamingToolLogs}
              streamingSubagents={streamingSubagents}
              streamingPlan={streamingPlan}
              pendingApprovals={pendingApprovals}
              onApproval={handleApproval}
              processingApprovals={processingApprovals}
              error={error}
              files={files}
              onFilesChange={setFiles}
              models={models}
              modelId={modelId}
              onModelChange={setModelId}
              mode={current.mode ?? "default"}
              onModeChange={() => undefined}
              modeLocked
              artifactCount={artifactCount}
              onToggleArtifacts={() => {
                setShowArtifacts((prev) => {
                  const next = !prev;
                  if (next) setShowTeamPanel(false);
                  return next;
                });
              }}
              artifactsPanelOpen={showArtifacts}
              showTeamPanel={showTeamPanel}
              onToggleTeamPanel={() => {
                setShowTeamPanel((prev) => {
                  const next = !prev;
                  if (next) setShowArtifacts(false);
                  return next;
                });
              }}
              isTaskExecuting={executingTaskConversations.has(current.id)}
              usageTokens={usageTokens}
              contextUsage={contextUsage}
              onCompress={handleCompress}
              compressing={compressing}
              team={currentTeam}
              agents={agents}
            />
          )}
        </div>
        {showArtifacts && current && (
          <>
            <div
              className="w-1.5 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors shrink-0"
              onMouseDown={(e) => {
                e.preventDefault();
                setResizeTarget("artifact");
              }}
              title="拖拽调整宽度"
            />
            <div className="min-w-0 min-h-0 overflow-hidden" style={{ width: `${artifactPaneWidth}%` }}>
            <ArtifactPanel
              conversationId={current.id}
              onClose={() => setShowArtifacts(false)}
            />
            </div>
          </>
        )}
        {showTeamPanel && current && (current.mode ?? "default") === "team" && (
          <>
            <div
              className="w-1.5 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors shrink-0"
              onMouseDown={(e) => {
                e.preventDefault();
                setResizeTarget("team");
              }}
              title="拖拽调整宽度"
            />
            <div className="min-w-0 min-h-0 overflow-hidden shrink-0" style={{ width: `${teamPaneWidth}px` }}>
              <TeamPanel
                streamingSubagents={streamingSubagents}
                historicalRounds={(() => {
                  const rounds: Array<{ label: string; subagents: SubagentLog[] }> = [];
                  let lastHumanContent = "";
                  for (const m of messages) {
                    if (m.type === "human") {
                      lastHumanContent = (m.content || "").trim();
                    } else if (m.type === "ai" && m.subagents?.length) {
                      const label = lastHumanContent.length > 30
                        ? lastHumanContent.slice(0, 30) + "…"
                        : lastHumanContent || `Round ${rounds.length + 1}`;
                      rounds.push({ label, subagents: m.subagents });
                    }
                  }
                  return rounds;
                })()}
                pendingApprovals={pendingApprovals}
                onApproval={handleApproval}
                processingApprovals={processingApprovals}
                conversationId={current.id}
                onClose={() => setShowTeamPanel(false)}
              />
            </div>
          </>
        )}
        {resizeTarget && <div className="absolute inset-0 z-20 cursor-col-resize" />}
      </main>
      {showConfig && (
        <SettingsPanel
          onClose={() => setShowConfig(false)}
          onSaved={() => setShowConfig(false)}
        />
      )}
      {showTemplates && (
        <PromptTemplatesPanel
          onClose={() => setShowTemplates(false)}
          onLaunch={handleLaunchFromTemplate}
        />
      )}
      {showScheduledTasks && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1" onClick={() => setShowScheduledTasks(false)} />
          <div className="w-2/3 max-w-4xl">
            <ScheduledTasksPanel
              onClose={() => setShowScheduledTasks(false)}
              onConversationListRefresh={loadList}
              onNavigateToConversation={(id) => navigate(`/c/${id}`)}
              currentConversationId={current?.id}
              onRefreshCurrentConversation={refreshConversationMessages}
              onTaskExecutionStart={(conversationId) => {
                setExecutingTaskConversations(prev => new Set(prev).add(conversationId));
              }}
            />
          </div>
        </div>
      )}
      {showAgentTeam && (
        <AgentTeamPanel onClose={() => setShowAgentTeam(false)} />
      )}
      <DeleteConfirmModal
        open={deleteTargetId !== null}
        onOpenChange={(open) => !open && setDeleteTargetId(null)}
        onConfirm={handleDeleteConfirm}
        loading={deleting}
      />
    </div>
  );
}
