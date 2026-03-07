import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createConversation, deleteConversation } from "./api";
import { Sidebar, ChatPanel, WelcomeBox, ConfigModal, DeleteConfirmModal } from "./components";
import { useConversations, useSendMessage, useConfig } from "./hooks";

export default function App() {
  const { conversationId: conversationIdFromUrl } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [showConfig, setShowConfig] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
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
    streamingStatus,
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
  }, [current?.id, clearStreaming]);

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
      <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
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
            input={input}
            onInputChange={setInput}
            onSend={() => send(current.id)}
            loading={loading}
            streamingContent={streamingContent}
            streamingStatus={streamingStatus}
            error={error}
            files={files}
            onFilesChange={setFiles}
            models={models}
            modelId={modelId}
            onModelChange={setModelId}
          />
        )}
      </main>
      {showConfig && (
        <ConfigModal
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
