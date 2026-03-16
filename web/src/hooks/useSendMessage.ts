import { useState, useCallback, useRef, useEffect } from "react";
import { sendMessageStream, getMessages, getConversation, type Attachment } from "../api";
import type { AgentRole, ConversationMeta, ConversationMode, StoredMessage, StreamingStatus, ToolLog } from "../types";
import type { FileWithData } from "../components/ChatInputBar";

type StreamingSubagent = {
  subagentId: string;
  subagentName?: string;
  role?: AgentRole;
  dependsOn?: string[];
  depth: number;
  prompt: string;
  phase: "started" | "completed" | "failed";
  status: StreamingStatus;
  content: string;
  reasoning: string;
  toolLogs: ToolLog[];
  plan: {
    phase: "created" | "running" | "completed";
    steps: Array<{
      title: string;
      acceptance_checks: string[];
      evidences: string[];
      completed: boolean;
    }>;
    currentStep: number;
    toolName?: string;
  } | null;
  summary?: string;
  error?: string;
};

type ConversationStreamState = {
  loading: boolean;
  streamingContent: string;
  streamingReasoning: string;
  streamingStatus: StreamingStatus;
  streamingToolLogs: ToolLog[];
  streamingSubagents: StreamingSubagent[];
  streamingPlan: {
    phase: "created" | "running" | "completed";
    steps: Array<{
      title: string;
      acceptance_checks: string[];
      evidences: string[];
      completed: boolean;
    }>;
    currentStep: number;
    toolName?: string;
  } | null;
  pendingApprovals: Array<{
    requestId: string;
    subagentId: string;
    operationType: string;
    operationDescription: string;
    details: Record<string, unknown>;
  }>;
  sendError: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  contextUsage: {
    strategy: "full" | "trim" | "compress";
    contextWindow: number;
    thresholdTokens: number;
    tokenThresholdPercent: number;
    contextMessageCount: number;
    estimatedTokens?: number;
    promptTokens?: number;
    trimToLast?: number;
    olderCount?: number;
    recentCount?: number;
  } | null;
};

const EMPTY_STATE: ConversationStreamState = {
  loading: false,
  streamingContent: "",
  streamingReasoning: "",
  streamingStatus: null,
  streamingToolLogs: [],
  streamingSubagents: [],
  streamingPlan: null,
  pendingApprovals: [],
  sendError: null,
  usage: null,
  contextUsage: null,
};

function createState(): ConversationStreamState {
  return {
    loading: false,
    streamingContent: "",
    streamingReasoning: "",
    streamingStatus: null,
    streamingToolLogs: [],
    streamingSubagents: [],
    streamingPlan: null,
    pendingApprovals: [],
    sendError: null,
    usage: null,
    contextUsage: null,
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
  const conversationStatesRef = useRef(conversationStates);

  useEffect(() => {
    conversationStatesRef.current = conversationStates;
  }, [conversationStates]);

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
    (convId: string, overrideText?: string, overrideFiles?: FileWithData[], mode?: ConversationMode) => {
      const text = (overrideText ?? input).trim();
      const toSend = overrideFiles ?? files;
      if ((!text && toSend.length === 0) || (conversationStatesRef.current[convId]?.loading ?? false)) return;

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
        streamingSubagents: [],
        streamingPlan: null,
        pendingApprovals: [],
        sendError: null,
        usage: null,
        contextUsage: null,
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
            const rawContext = (obj as { context?: Record<string, unknown> }).context;
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
                contextUsage: rawContext && typeof rawContext === "object"
                  ? {
                      strategy: (rawContext.strategy as "full" | "trim" | "compress") ?? (prev.contextUsage?.strategy ?? "full"),
                      contextWindow: typeof rawContext.contextWindow === "number" ? rawContext.contextWindow : (prev.contextUsage?.contextWindow ?? 0),
                      thresholdTokens: typeof rawContext.thresholdTokens === "number" ? rawContext.thresholdTokens : (prev.contextUsage?.thresholdTokens ?? 0),
                      tokenThresholdPercent: typeof rawContext.tokenThresholdPercent === "number" ? rawContext.tokenThresholdPercent : (prev.contextUsage?.tokenThresholdPercent ?? 75),
                      contextMessageCount: typeof rawContext.contextMessageCount === "number" ? rawContext.contextMessageCount : (prev.contextUsage?.contextMessageCount ?? 0),
                      estimatedTokens: typeof rawContext.estimatedTokens === "number" ? rawContext.estimatedTokens : prev.contextUsage?.estimatedTokens,
                      promptTokens: typeof rawContext.promptTokens === "number" ? rawContext.promptTokens : p || prev.contextUsage?.promptTokens,
                      trimToLast: typeof rawContext.trimToLast === "number" ? rawContext.trimToLast : prev.contextUsage?.trimToLast,
                      olderCount: typeof rawContext.olderCount === "number" ? rawContext.olderCount : prev.contextUsage?.olderCount,
                      recentCount: typeof rawContext.recentCount === "number" ? rawContext.recentCount : prev.contextUsage?.recentCount,
                    }
                  : prev.contextUsage,
              };
            });
            return;
          }
          if (obj.type === "context") {
            const payload = obj as {
              strategy?: "full" | "trim" | "compress";
              contextWindow?: number;
              thresholdTokens?: number;
              tokenThresholdPercent?: number;
              contextMessageCount?: number;
              estimatedTokens?: number;
              trimToLast?: number;
              olderCount?: number;
              recentCount?: number;
            };
            if (typeof payload.contextWindow !== "number" || payload.contextWindow <= 0) return;
            const contextWindow = payload.contextWindow;
            setConversationState(convId, (prev) => ({
              ...prev,
              contextUsage: {
                strategy: payload.strategy ?? "full",
                contextWindow,
                thresholdTokens: payload.thresholdTokens ?? Math.floor(contextWindow * ((payload.tokenThresholdPercent ?? 75) / 100)),
                tokenThresholdPercent: payload.tokenThresholdPercent ?? 75,
                contextMessageCount: payload.contextMessageCount ?? prev.contextUsage?.contextMessageCount ?? 0,
                estimatedTokens: payload.estimatedTokens,
                promptTokens: prev.contextUsage?.promptTokens,  // 保留上一轮的 promptTokens，避免显示跳变
                trimToLast: payload.trimToLast,
                olderCount: payload.olderCount,
                recentCount: payload.recentCount,
              },
            }));
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
          if (obj.type === "subagent" && typeof (obj as { subagentId?: string }).subagentId === "string") {
            const payload = obj as {
              kind?: "lifecycle" | "token" | "reasoning" | "plan" | "tool_call" | "tool_result" | "subagent_name" | "approval_request" | "approval_response";
              subagentId: string;
              subagentName?: string;
              role?: string;
              dependsOn?: string[];
              depth?: number;
              prompt?: string;
              phase?: "started" | "completed" | "failed" | "created" | "running";
              summary?: string;
              error?: string;
              content?: string;
              requestId?: string;
              approved?: boolean;
              operationType?: string;
              operationDescription?: string;
              details?: Record<string, unknown>;
              steps?: Array<{
                title: string;
                acceptance_checks: string[];
                evidences: string[];
                completed: boolean;
              } | string>;
              currentStep?: number;
              toolName?: string;
              name?: string;
              input?: string;
              output?: string;
            };
            setConversationState(convId, (prev) => {
              const existing = prev.streamingSubagents;
              const idx = existing.findIndex((s) => s.subagentId === payload.subagentId);
              const lifecyclePhase =
                payload.phase === "started" || payload.phase === "completed" || payload.phase === "failed"
                  ? payload.phase
                  : "started";
              const base: StreamingSubagent = idx >= 0
                ? existing[idx]
                : {
                    subagentId: payload.subagentId,
                    subagentName: typeof payload.subagentName === "string" ? payload.subagentName : undefined,
                    role: typeof payload.role === "string" && payload.role ? payload.role : undefined,
                    dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn : undefined,
                    depth: typeof payload.depth === "number" ? payload.depth : 1,
                    prompt: typeof payload.prompt === "string" ? payload.prompt : "",
                    phase: lifecyclePhase,
                    status: "thinking",
                    content: "",
                    reasoning: "",
                    toolLogs: [],
                    plan: null,
                    summary: typeof payload.summary === "string" ? payload.summary : undefined,
                    error: typeof payload.error === "string" ? payload.error : undefined,
                  };
              let nextItem: StreamingSubagent = {
                ...base,
                depth: typeof payload.depth === "number" ? payload.depth : base.depth,
                prompt: typeof payload.prompt === "string" && payload.prompt ? payload.prompt : base.prompt,
              };
              if (payload.kind === "lifecycle") {
                const parsedRole = typeof payload.role === "string" && payload.role ? payload.role : undefined;
                nextItem = {
                  ...nextItem,
                  subagentName: typeof payload.subagentName === "string" ? payload.subagentName : nextItem.subagentName,
                  role: parsedRole ?? nextItem.role,
                  dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn : nextItem.dependsOn,
                  phase: lifecyclePhase,
                  summary: typeof payload.summary === "string" ? payload.summary : nextItem.summary,
                  error: typeof payload.error === "string" ? payload.error : nextItem.error,
                  status: lifecyclePhase === "completed" || lifecyclePhase === "failed" ? null : nextItem.status,
                };
              } else if (payload.kind === "token") {
                nextItem = {
                  ...nextItem,
                  status: null,
                  content: nextItem.content + (typeof payload.content === "string" ? payload.content : ""),
                };
              } else if (payload.kind === "reasoning") {
                nextItem = {
                  ...nextItem,
                  reasoning: nextItem.reasoning + (typeof payload.content === "string" ? payload.content : ""),
                };
              } else if (payload.kind === "tool_call" && typeof payload.name === "string") {
                nextItem = {
                  ...nextItem,
                  status: "tool",
                  toolLogs: [...nextItem.toolLogs, { name: payload.name, input: payload.input ?? "", output: "" }],
                };
              } else if (payload.kind === "tool_result" && typeof payload.name === "string") {
                const logs = [...nextItem.toolLogs];
                const logIdx = logs.findIndex((tl) => tl.name === payload.name && !tl.output);
                if (logIdx >= 0) logs[logIdx] = { ...logs[logIdx], output: payload.output ?? "" };
                nextItem = { ...nextItem, status: null, toolLogs: logs };
              } else if (payload.kind === "plan" && Array.isArray(payload.steps)) {
                const normalizedSteps = payload.steps.map((s) => {
                  if (typeof s === "string") {
                    return { title: s, acceptance_checks: [`验证：${s}`], evidences: [], completed: false };
                  }
                  return {
                    title: s.title,
                    acceptance_checks: Array.isArray(s.acceptance_checks) ? s.acceptance_checks : [],
                    evidences: Array.isArray(s.evidences) ? s.evidences : [],
                    completed: !!s.completed,
                  };
                });
                nextItem = {
                  ...nextItem,
                  plan: {
                    phase: payload.phase === "created" || payload.phase === "running" || payload.phase === "completed"
                      ? payload.phase
                      : "created",
                    steps: normalizedSteps,
                    currentStep: typeof payload.currentStep === "number" ? payload.currentStep : 0,
                    toolName: payload.toolName,
                  },
                };
              } else if (payload.kind === "subagent_name" && typeof payload.subagentName === "string") {
                nextItem = { ...nextItem, subagentName: payload.subagentName };
              } else if (payload.kind === "approval_request" && payload.requestId) {
                const newApproval = {
                  requestId: payload.requestId,
                  subagentId: payload.subagentId,
                  operationType: payload.operationType ?? "unknown",
                  operationDescription: payload.operationDescription ?? "",
                  details: payload.details ?? {},
                };
                if (idx >= 0) {
                  const next = [...existing];
                  next[idx] = nextItem;
                  return {
                    ...prev,
                    streamingSubagents: next,
                    pendingApprovals: [...prev.pendingApprovals, newApproval],
                  };
                }
                return {
                  ...prev,
                  streamingSubagents: [...existing, nextItem],
                  pendingApprovals: [...prev.pendingApprovals, newApproval],
                };
              } else if (payload.kind === "approval_response" && payload.requestId) {
                const filteredApprovals = prev.pendingApprovals.filter(
                  (a) => a.requestId !== payload.requestId
                );
                if (idx >= 0) {
                  const next = [...existing];
                  next[idx] = nextItem;
                  return { ...prev, streamingSubagents: next, pendingApprovals: filteredApprovals };
                }
                return { ...prev, streamingSubagents: [...existing, nextItem], pendingApprovals: filteredApprovals };
              }
              if (idx >= 0) {
                const next = [...existing];
                next[idx] = nextItem;
                return { ...prev, streamingSubagents: next };
              }
              return { ...prev, streamingSubagents: [...existing, nextItem] };
            });
            return;
          }
          if (
            obj.type === "plan" &&
            Array.isArray((obj as { steps?: unknown[] }).steps) &&
            typeof (obj as { phase?: string }).phase === "string"
          ) {
            const payload = obj as {
              phase: "created" | "running" | "completed";
              steps: Array<{
                title: string;
                acceptance_checks: string[];
                evidences: string[];
                completed: boolean;
              } | string>;
              currentStep?: number;
              toolName?: string;
            };
            const normalizedSteps = (payload.steps ?? []).map((s) => {
              if (typeof s === "string") {
                return { title: s, acceptance_checks: [`验证：${s}`], evidences: [], completed: false };
              }
              return {
                title: s.title,
                acceptance_checks: Array.isArray(s.acceptance_checks) ? s.acceptance_checks : [],
                evidences: Array.isArray(s.evidences) ? s.evidences : [],
                completed: !!s.completed,
              };
            });
            setConversationState(convId, (prev) => ({
              ...prev,
              streamingPlan: {
                phase: payload.phase,
                steps: normalizedSteps,
                currentStep: typeof payload.currentStep === "number" ? payload.currentStep : 0,
                toolName: payload.toolName,
              },
            }));
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
        mode,
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
    [input, files, onAfterSend, setMessages, setCurrent, abortStreaming, setConversationState, clearConversationState]
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
    streamingSubagents: activeState.streamingSubagents,
    streamingPlan: activeState.streamingPlan,
    pendingApprovals: activeState.pendingApprovals,
    sendError: activeState.sendError,
    usageTokens: activeState.usage,
    contextUsage: activeState.contextUsage,
    clearStreaming,
    abortStreaming,
  };
}
