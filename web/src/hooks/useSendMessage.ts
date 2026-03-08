import { useState, useCallback, useRef, useEffect } from "react";
import { sendMessageStream, getMessages, getConversation, type Attachment } from "../api";
import type { ConversationMeta, StoredMessage, StreamingStatus, ToolLog } from "../types";
import type { FileWithData } from "../components/ChatInputBar";

export function useSendMessage(options: {
  onAfterSend: (convId: string) => void;
  setMessages: (fn: (prev: StoredMessage[]) => StoredMessage[] | StoredMessage[]) => void;
  setCurrent: (meta: ConversationMeta | null) => void;
}) {
  const { onAfterSend, setMessages, setCurrent } = options;
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileWithData[]>([]);
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingStatus, setStreamingStatus] = useState<StreamingStatus>(null);
  const [streamingToolLogs, setStreamingToolLogs] = useState<ToolLog[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const toolLogsRef = useRef<ToolLog[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const pendingContentRef = useRef("");
  const pendingReasoningRef = useRef("");
  const pendingStatusRef = useRef<StreamingStatus | undefined>(undefined);
  const rafRef = useRef<number | null>(null);

  const flushPending = useCallback(() => {
    rafRef.current = null;
    if (pendingStatusRef.current !== undefined) {
      setStreamingStatus(pendingStatusRef.current);
      pendingStatusRef.current = undefined;
    }
    if (pendingContentRef.current) {
      const batch = pendingContentRef.current;
      pendingContentRef.current = "";
      setStreamingContent((c) => c + batch);
    }
    if (pendingReasoningRef.current) {
      const batch = pendingReasoningRef.current;
      pendingReasoningRef.current = "";
      setStreamingReasoning((r) => r + batch);
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flushPending);
    }
  }, [flushPending]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const abortStreaming = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const clearStreaming = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingContentRef.current = "";
    pendingReasoningRef.current = "";
    pendingStatusRef.current = undefined;
    setStreamingContent("");
    setStreamingReasoning("");
    setStreamingStatus(null);
    setStreamingToolLogs([]);
    toolLogsRef.current = [];
  }, []);

  const send = useCallback(
    (convId: string, overrideText?: string, overrideFiles?: FileWithData[]) => {
      const text = (overrideText ?? input).trim();
      const toSend = overrideFiles ?? files;
      if ((!text && toSend.length === 0) || loading) return;

      abortStreaming();
      const controller = new AbortController();
      abortRef.current = controller;

      setInput("");
      setFiles([]);
      setLoading(true);
      setSendError(null);
      setStreamingContent("");
      setStreamingReasoning("");
      setStreamingToolLogs([]);
      toolLogsRef.current = [];
      pendingContentRef.current = "";
      pendingReasoningRef.current = "";
      pendingStatusRef.current = undefined;
      setStreamingStatus("thinking");

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
            pendingStatusRef.current = s === "tool" ? "tool" : s === "thinking" ? "thinking" : null;
            scheduleFlush();
            return;
          }
          if (obj.type === "token" && typeof obj.content === "string") {
            pendingStatusRef.current = null;
            pendingContentRef.current += obj.content;
            scheduleFlush();
            return;
          }
          if (obj.type === "reasoning" && typeof obj.content === "string") {
            pendingReasoningRef.current += obj.content;
            scheduleFlush();
            return;
          }
          if (obj.type === "tool_call" && typeof (obj as { name?: string }).name === "string") {
            const { name, input } = obj as { name: string; input?: string };
            const newLog: ToolLog = { name, input: input ?? "", output: "" };
            toolLogsRef.current = [...toolLogsRef.current, newLog];
            setStreamingToolLogs([...toolLogsRef.current]);
            return;
          }
          if (obj.type === "tool_result" && typeof (obj as { name?: string }).name === "string") {
            const { name, output } = obj as { name: string; output?: string };
            const logs = [...toolLogsRef.current];
            const idx = logs.findIndex((tl) => tl.name === name && !tl.output);
            if (idx >= 0) logs[idx] = { ...logs[idx], output: output ?? "" };
            toolLogsRef.current = logs;
            setStreamingToolLogs([...logs]);
            return;
          }
          const key = Object.keys(obj)[0];
          const part = key ? (obj[key] as { messages?: Array<{ type?: string; content?: string }>; reasoning?: string }) : undefined;
          if (part?.reasoning) {
            pendingReasoningRef.current += part.reasoning;
            scheduleFlush();
          }
          const ms = part?.messages ?? [];
          const last = ms[ms.length - 1];
          if (last && typeof last.content === "string" && last.content) {
            pendingStatusRef.current = null;
            pendingContentRef.current += last.content;
            scheduleFlush();
          }
          if (key === "toolNode" && ms.length) {
            pendingStatusRef.current = "tool";
            scheduleFlush();
          }
        },
        () => {
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          flushPending();
          abortRef.current = null;
          setLoading(false);
          setStreamingStatus(null);
          onAfterSend(convId);
          getConversation(convId).then((meta) => meta && setCurrent(meta));
          getMessages(convId)
            .then((list) => {
              const arr = Array.isArray(list) ? list : [];
              setMessages((prev) => (arr.length > 0 ? arr : prev));
              clearStreaming();
            })
            .catch(() => clearStreaming());
        },
        (err) => {
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          flushPending();
          abortRef.current = null;
          setSendError(err);
          setLoading(false);
          clearStreaming();
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
    [input, files, loading, onAfterSend, setMessages, setCurrent, clearStreaming, abortStreaming, scheduleFlush, flushPending]
  );

  return {
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
    abortStreaming,
  };
}
