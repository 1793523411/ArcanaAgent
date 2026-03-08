import { useState, useCallback, useRef } from "react";
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

  const clearStreaming = useCallback(() => {
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
      setInput("");
      setFiles([]);
      setLoading(true);
      setSendError(null);
      setStreamingContent("");
      setStreamingReasoning("");
      setStreamingToolLogs([]);
      toolLogsRef.current = [];
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
            setStreamingStatus(s === "tool" ? "tool" : s === "thinking" ? "thinking" : null);
            return;
          }
          if (obj.type === "token" && typeof obj.content === "string") {
            setStreamingStatus(null);
            setStreamingContent((c) => c + obj.content);
            return;
          }
          if (obj.type === "reasoning" && typeof obj.content === "string") {
            setStreamingReasoning((r) => r + obj.content);
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
          if (part?.reasoning) setStreamingReasoning(part.reasoning);
          const ms = part?.messages ?? [];
          const last = ms[ms.length - 1];
          if (last && typeof last.content === "string" && last.content) {
            setStreamingStatus(null);
            setStreamingContent((c) => c + last.content);
          }
          if (key === "toolNode" && ms.length) setStreamingStatus("tool");
        },
        () => {
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
          setSendError(err);
          setLoading(false);
          clearStreaming();
        },
        attachments
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
    [input, files, loading, onAfterSend, setMessages, setCurrent, clearStreaming]
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
  };
}
