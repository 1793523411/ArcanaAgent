import { useState, useCallback, useRef, useEffect } from "react";
import { sendMessageStream, getMessages, getConversation, type Attachment } from "../api";
import type { ConversationMeta, StoredMessage, StreamingStatus, ToolLog } from "../types";
import type { FileWithData } from "../components/ChatInputBar";

type ConversationStreamState = {
  loading: boolean;
  streamingContent: string;
  streamingReasoning: string;
  streamingStatus: StreamingStatus;
  streamingToolLogs: ToolLog[];
  sendError: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
};

const EMPTY_STATE: ConversationStreamState = {
  loading: false,
  streamingContent: "",
  streamingReasoning: "",
  streamingStatus: null,
  streamingToolLogs: [],
  sendError: null,
  usage: null,
};

function createState(): ConversationStreamState {
  return {
    loading: false,
    streamingContent: "",
    streamingReasoning: "",
    streamingStatus: null,
    streamingToolLogs: [],
    sendError: null,
    usage: null,
  };
}

export function useSendMessage(options: {
  currentConversationId?: string;
  onAfterSend: (convId: string) => void;
  setMessages: (fn: (prev: StoredMessage[]) => StoredMessage[] | StoredMessage[]) => void;
  setCurrent: (meta: ConversationMeta | null) => void;
}) {
  const { currentConversationId, onAfterSend, setMessages, setCurrent } = options;
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileWithData[]>([]);
  const [conversationStates, setConversationStates] = useState<Record<string, ConversationStreamState>>({});
  const abortControllersRef = useRef<Record<string, AbortController>>({});
  const currentConversationIdRef = useRef<string | undefined>(currentConversationId);

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  useEffect(() => {
    return () => {
      for (const controller of Object.values(abortControllersRef.current)) {
        controller.abort();
      }
      abortControllersRef.current = {};
    };
  }, []);

  const setConversationState = useCallback((convId: string, updater: (prev: ConversationStreamState) => ConversationStreamState) => {
    setConversationStates((prev) => {
      const base = prev[convId] ?? createState();
      const nextState = updater(base);
      return {
        ...prev,
        [convId]: nextState,
      };
    });
  }, []);

  const clearConversationState = useCallback((convId: string) => {
    setConversationStates((prev) => {
      if (!prev[convId]) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
  }, []);

  const abortStreaming = useCallback((convId?: string) => {
    const targetId = convId ?? currentConversationIdRef.current;
    if (!targetId) return;
    const controller = abortControllersRef.current[targetId];
    if (controller) {
      controller.abort();
      delete abortControllersRef.current[targetId];
    }
  }, []);

  const clearStreaming = useCallback((convId?: string) => {
    const targetId = convId ?? currentConversationIdRef.current;
    if (!targetId) return;
    clearConversationState(targetId);
  }, [clearConversationState]);

  const send = useCallback(
    (convId: string, overrideText?: string, overrideFiles?: FileWithData[]) => {
      const text = (overrideText ?? input).trim();
      const toSend = overrideFiles ?? files;
      if ((!text && toSend.length === 0) || (conversationStates[convId]?.loading ?? false)) return;

      abortStreaming(convId);
      const controller = new AbortController();
      abortControllersRef.current[convId] = controller;

      setInput("");
      setFiles([]);
      setConversationState(convId, () => ({
        loading: true,
        streamingContent: "",
        streamingReasoning: "",
        streamingStatus: "thinking",
        streamingToolLogs: [],
        sendError: null,
        usage: null,
      }));

      const attachments: Attachment[] | undefined = toSend.length
        ? toSend.map((f) => ({ type: "image" as const, mimeType: f.mimeType, data: f.data }))
        : undefined;

      sendMessageStream(
        convId,
        text || " ",
        (chunk) => {
          const obj = chunk as Record<string, unknown>;
          if (obj.type === "status") {
            const s = obj.status as string;
            setConversationState(convId, (prev) => ({
              ...prev,
              streamingStatus: s === "tool" ? "tool" : s === "thinking" ? "thinking" : null,
            }));
            return;
          }
          if (obj.type === "usage") {
            const { promptTokens, completionTokens, totalTokens } = obj as {
              promptTokens?: number;
              completionTokens?: number;
              totalTokens?: number;
            };
            setConversationState(convId, (prev) => {
              const p = typeof promptTokens === "number" ? promptTokens : 0;
              const c = typeof completionTokens === "number" ? completionTokens : 0;
              const t =
                typeof totalTokens === "number"
                  ? totalTokens
                  : p > 0 || c > 0
                    ? p + c
                    : 0;
              return {
                ...prev,
                usage: t > 0 ? { promptTokens: p, completionTokens: c, totalTokens: t } : prev.usage,
              };
            });
            return;
          }
          if (obj.type === "token" && typeof obj.content === "string") {
            setConversationState(convId, (prev) => ({
              ...prev,
              streamingStatus: null,
              streamingContent: prev.streamingContent + obj.content,
            }));
            return;
          }
          if (obj.type === "reasoning" && typeof obj.content === "string") {
            setConversationState(convId, (prev) => ({
              ...prev,
              streamingReasoning: prev.streamingReasoning + obj.content,
            }));
            return;
          }
          if (obj.type === "tool_call" && typeof (obj as { name?: string }).name === "string") {
            const { name, input } = obj as { name: string; input?: string };
            setConversationState(convId, (prev) => ({
              ...prev,
              streamingToolLogs: [...prev.streamingToolLogs, { name, input: input ?? "", output: "" }],
            }));
            return;
          }
          if (obj.type === "tool_result" && typeof (obj as { name?: string }).name === "string") {
            const { name, output } = obj as { name: string; output?: string };
            setConversationState(convId, (prev) => {
              const logs = [...prev.streamingToolLogs];
              const idx = logs.findIndex((tl) => tl.name === name && !tl.output);
              if (idx >= 0) logs[idx] = { ...logs[idx], output: output ?? "" };
              return {
                ...prev,
                streamingToolLogs: logs,
              };
            });
            return;
          }
        },
        () => {
          delete abortControllersRef.current[convId];
          setConversationState(convId, (prev) => ({
            ...prev,
            loading: false,
            streamingStatus: null,
          }));
          onAfterSend(convId);
          if (currentConversationIdRef.current !== convId) {
            clearConversationState(convId);
            return;
          }
          getConversation(convId).then((meta) => meta && setCurrent(meta));
          getMessages(convId)
            .then((list) => {
              const arr = Array.isArray(list) ? list : [];
              setMessages((prev) => (arr.length > 0 ? arr : prev));
              clearConversationState(convId);
            })
            .catch(() => clearConversationState(convId));
        },
        (err) => {
          delete abortControllersRef.current[convId];
          setConversationState(convId, (prev) => ({
            ...prev,
            loading: false,
            streamingStatus: null,
            sendError: err,
          }));
        },
        attachments,
        controller.signal
      );

      const displayText = text || "[图片]";
      const optimisticHuman = {
        type: "human" as const,
        content: displayText,
        ...(attachments?.length
          ? {
              attachments: attachments.map((a) => ({
                type: "image" as const,
                mimeType: a.mimeType,
                data: a.data,
              })),
            }
          : {}),
      };
      setMessages((prev) => [...prev, optimisticHuman]);
    },
    [input, files, conversationStates, onAfterSend, setMessages, setCurrent, abortStreaming, setConversationState, clearConversationState]
  );

  const activeState = currentConversationId ? (conversationStates[currentConversationId] ?? EMPTY_STATE) : EMPTY_STATE;

  return {
    input,
    setInput,
    files,
    setFiles,
    send,
    loading: activeState.loading,
    streamingContent: activeState.streamingContent,
    streamingReasoning: activeState.streamingReasoning,
    streamingStatus: activeState.streamingStatus,
    streamingToolLogs: activeState.streamingToolLogs,
    sendError: activeState.sendError,
    usageTokens: activeState.usage,
    clearStreaming,
    abortStreaming,
  };
}
