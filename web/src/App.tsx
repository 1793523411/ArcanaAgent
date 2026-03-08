import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createConversation, deleteConversation, getArtifacts } from "./api";
import { Sidebar, ChatPanel, WelcomeBox, SettingsPanel, DeleteConfirmModal, ArtifactPanel } from "./components";
import { useConversations, useSendMessage, useConfig } from "./hooks";

export default function App() {
  const { conversationId: conversationIdFromUrl } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [showConfig, setShowConfig] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [artifactCount, setArtifactCount] = useState(0);
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
    clearStreaming,
  } = useSendMessage({
    onAfterSend: loadList,
    setMessages,
    setCurrent,
  });

  useEffect(() => {
    if (!current) return;
    clearStreaming();
    setShowArtifacts(false);
    setArtifactCount(0);
  }, [current?.id, clearStreaming]);

  const refreshArtifactCount = useCallback(() => {
    if (!current) return;
    getArtifacts(current.id).then((list) => setArtifactCount(list.length)).catch(() => {});
  }, [current]);

  useEffect(() => {
    refreshArtifactCount();
  }, [messages.length, loading, refreshArtifactCount]);

  const handleNewConversation = () => {
    navigate("/");
  };

  const handleSelectConversation = (meta: { id: string }) => {
    navigate(`/c/${meta.id}`);
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTargetId(id);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    setDeleteTargetId(null);
    try {
      await deleteConversation(id);
      loadList();
      if (current?.id === id) {
        navigate("/");
        setCurrent(null);
        setMessages([]);
      }
    } catch {
      // could toast
    }
  };

  const handleStartFromWelcome = async () => {
    try {
      const meta = await createConversation();
      setMessages([]);
      loadList();
      navigate(`/c/${meta.id}`);
      send(meta.id);
    } catch {
      // handled
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

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        conversations={conversations}
        current={current}
        onSelect={handleSelectConversation}
        onDelete={handleDeleteClick}
        onNewConversation={handleNewConversation}
        onOpenConfig={() => setShowConfig(true)}
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
      <DeleteConfirmModal
        open={deleteTargetId !== null}
        onOpenChange={(open) => !open && setDeleteTargetId(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}
