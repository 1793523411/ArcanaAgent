import { useState, useEffect, useCallback } from "react";
import { useNavigate, useMatch } from "react-router-dom";
import { createConversation, deleteConversation, getArtifacts, getMessages as fetchConversationMessages } from "./api";
import { Sidebar, ChatPanel, WelcomeBox, SettingsPanel, PromptTemplatesPanel, DeleteConfirmModal, ArtifactPanel } from "./components";
import ScheduledTasksPanel from "./components/ScheduledTasksPanel";
import { useConversations, useSendMessage, useConfig } from "./hooks";
import { useToast } from "./components/Toast";
import { filterVisibleArtifacts } from "./artifactFilters";

export default function App() {
  const match = useMatch("/c/:conversationId");
  const conversationIdFromUrl = match?.params.conversationId;
  const navigate = useNavigate();
  const { toast } = useToast();
  const [showConfig, setShowConfig] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showScheduledTasks, setShowScheduledTasks] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [artifactCount, setArtifactCount] = useState(0);
  const [executingTaskConversations, setExecutingTaskConversations] = useState<Set<string>>(new Set());
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
    sendError,
    usageTokens,
  } = useSendMessage({
    currentConversationId: current?.id,
    onAfterSend: loadList,
    setMessages,
    setCurrent,
  });

  useEffect(() => {
    setShowArtifacts(false);
    setArtifactCount(0);
  }, [current?.id]);

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
    const meta = await createConversation();
    setMessages([]);
    loadList();
    navigate(`/c/${meta.id}`);
    send(meta.id, text, []);
  };

  const handleSelectConversation = (meta: { id: string }) => {
    navigate(`/c/${meta.id}`);
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTargetId(id);
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
      const meta = await createConversation();
      setMessages([]);
      loadList();
      navigate(`/c/${meta.id}`);
      send(meta.id);
    } catch (e) {
      toast(`创建对话失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const handleWelcomeSend = () => {
    if (current) {
      send(current.id);
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

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        conversations={conversations}
        current={current}
        onSelect={handleSelectConversation}
        onDelete={handleDeleteClick}
        onNewConversation={handleNewConversation}
        onOpenTemplates={() => setShowTemplates(true)}
        onOpenConfig={() => setShowConfig(true)}
        onOpenScheduledTasks={() => setShowScheduledTasks(true)}
      />
      <main className="flex-1 flex min-w-0 min-h-0 overflow-hidden">
        <div className={`flex flex-col min-w-0 min-h-0 overflow-hidden ${showArtifacts && current ? "w-1/2" : "flex-1"} transition-all duration-300`}>
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
            />
          ) : (
            <ChatPanel
              messages={messages}
              conversationId={current.id}
              input={input}
              onInputChange={setInput}
              onSend={() => send(current.id)}
              loading={loading}
              streamingContent={streamingContent}
              streamingReasoning={streamingReasoning}
              streamingStatus={streamingStatus}
              streamingToolLogs={streamingToolLogs}
              error={error}
              files={files}
              onFilesChange={setFiles}
              models={models}
              modelId={modelId}
              onModelChange={setModelId}
              artifactCount={artifactCount}
              onToggleArtifacts={() => setShowArtifacts((prev) => !prev)}
              artifactsPanelOpen={showArtifacts}
              isTaskExecuting={executingTaskConversations.has(current.id)}
              usageTokens={usageTokens}
            />
          )}
        </div>
        {showArtifacts && current && (
          <div className="w-1/2 min-w-0 min-h-0 overflow-hidden">
            <ArtifactPanel
              conversationId={current.id}
              onClose={() => setShowArtifacts(false)}
            />
          </div>
        )}
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
      <DeleteConfirmModal
        open={deleteTargetId !== null}
        onOpenChange={(open) => !open && setDeleteTargetId(null)}
        onConfirm={handleDeleteConfirm}
        loading={deleting}
      />
    </div>
  );
}
