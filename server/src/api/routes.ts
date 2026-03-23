import { Request, Response } from "express";
import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  listConversations,
  createConversation,
  getConversation,
  getMessages,
  appendMessages,
  deleteConversation,
  setConversationTitle,
  saveAttachmentFile,
  getAttachmentAbsolutePath,
  listArtifacts,
  getArtifactAbsolutePath,
  ensureWorkspace,
  type StoredMessage,
  type ConversationMeta,
  type ConversationMode,
} from "../storage/index.js";
import { createShare as createShareRecord, getShare as getShareRecord } from "../storage/shares.js";
import {
  listAgentDefs,
  getAgentDef,
  createAgentDef,
  updateAgentDef,
  deleteAgentDef,
} from "../storage/agentDefs.js";
import {
  listTeamDefs,
  getTeamDef,
  createTeamDef,
  updateTeamDef,
  deleteTeamDef,
} from "../storage/teamDefs.js";
import { buildContextForAgent, saveFullContext } from "../agent/contextBuilder.js";
import { storedToLangChain, langChainToStored, getTextContent, sanitizeMessageSequence } from "../lib/messages.js";
import type { BaseMessage } from "@langchain/core/messages";
import { runAgent, streamAgentWithTokens } from "../agent/index.js";
import type { PlanStreamEvent } from "../agent/index.js";
import type { SubagentStreamEvent } from "../agent/index.js";
import { approvalManager } from "../agent/approvalManager.js";
import { getLLM } from "../llm/index.js";
import { loadUserConfig, saveUserConfig, type UserConfig, type ContextStrategyConfig, type PromptTemplate, type PlanningConfig, type ApprovalRule } from "../config/userConfig.js";
import { listToolIds } from "../tools/index.js";
import { listModels, loadModelConfig, listProviders, addProvider as addProviderConfig, updateProvider as updateProviderConfig, deleteProvider as deleteProviderConfig } from "../config/models.js";
import { validateModel, validateModels as validateModelsBatch, validateAllModels, loadValidationResults, clearProviderValidations } from "../llm/validate.js";
import { listSkills, installSkillFromZip, deleteSkill, getSkillCatalogForAgent } from "../skills/manager.js";
import { connectToMcpServers, getMcpStatus, restartMcpServer } from "../mcp/client.js";
import {
  getConversationLogger,
  logConversation,
  logError,
  logLLMCall,
  logToolCall,
  PerformanceTimer,
} from "../lib/logger.js";
import { estimateBaseMessageTokens, estimateTextTokens } from "../lib/tokenizer.js";


function convId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] ?? "" : id;
}

function isTokenLimitErrorMessage(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("max message tokens") ||
    text.includes("context length") ||
    text.includes("context_length_exceeded") ||
    text.includes("maximum context length") ||
    text.includes("too many tokens") ||
    text.includes("total tokens")
  );
}

function buildStreamErrorPayload(message: string): Record<string, unknown> {
  if (isTokenLimitErrorMessage(message)) {
    return {
      error: "上下文过长导致模型拒绝请求。系统已自动裁剪子任务结果与对话上下文，请重试一次；若仍失败，请减少单次子任务产出。",
      code: "TOKEN_LIMIT_EXCEEDED",
      details: message,
    };
  }
  return { error: message };
}

const MAX_ARTIFACT_LIST = 100;

function buildSkillContext(convId: string): string {
  const workspace = ensureWorkspace(convId);
  const existingArtifacts = listArtifacts(convId);
  const displayArtifacts = existingArtifacts.slice(0, MAX_ARTIFACT_LIST);
  const omitted = existingArtifacts.length - displayArtifacts.length;
  let artifactListText = "";
  if (displayArtifacts.length > 0) {
    artifactListText = "\n\nFiles currently in workspace:\n" + displayArtifacts.map(a =>
        `- ${a.path} (${a.mimeType}, ${a.size} bytes)`
      ).join("\n");
    if (omitted > 0) {
      artifactListText += `\n... and ${omitted} more files (use read_file or run_command to explore)`;
    }
    artifactListText += "\n\nYou can read any of these files with the read_file tool using their full path: " + workspace + "/<relative_path>";
  }
  return getSkillCatalogForAgent() +
    `\n\n## Workspace\nThe current conversation workspace directory is: ${workspace}\n` +
    "Save ALL output files (search results, generated files, downloads, etc.) to this workspace directory. " +
    "Use absolute paths when saving. The user can preview files saved here directly in the UI." +
    artifactListText;
}

type PersistedSubagentLog = {
  subagentId: string;
  subagentName?: string;
  role?: string;
  dependsOn?: string[];
  depth: number;
  prompt: string;
  phase: "started" | "completed" | "failed";
  status: "thinking" | "tool" | null;
  content: string;
  reasoning: string;
  toolLogs: Array<{ name: string; input: string; output: string }>;
  plan?: {
    phase: "created" | "running" | "completed";
    steps: Array<{
      title: string;
      acceptance_checks: string[];
      evidences: string[];
      completed: boolean;
    }>;
    currentStep: number;
    toolName?: string;
  };
  approvalLogs?: Array<{
    requestId: string;
    operationType: string;
    operationDescription: string;
    approved: boolean;
    createdAt: string;
  }>;
  summary?: string;
  error?: string;
};

function buildSubagentLogs(events: SubagentStreamEvent[]): PersistedSubagentLog[] {
  const map = new Map<string, PersistedSubagentLog>();
  for (const ev of events) {
    if (!("subagentId" in ev)) continue;
    const existing = map.get(ev.subagentId) ?? {
      subagentId: ev.subagentId,
      depth: 1,
      prompt: "",
      phase: "started" as const,
      status: "thinking" as const,
      content: "",
      reasoning: "",
      toolLogs: [],
    };
    if (ev.kind === "lifecycle") {
      const next: PersistedSubagentLog = {
        ...existing,
        depth: ev.depth,
        prompt: ev.prompt,
        phase: ev.phase,
        subagentName: ev.subagentName ?? existing.subagentName,
        role: ev.role ?? existing.role,
        dependsOn: ev.dependsOn ?? existing.dependsOn,
        summary: ev.summary ?? existing.summary,
        error: ev.error ?? existing.error,
        status: ev.phase === "completed" || ev.phase === "failed" ? null : existing.status,
      };
      map.set(ev.subagentId, next);
      continue;
    }
    if (ev.kind === "token") {
      map.set(ev.subagentId, {
        ...existing,
        status: null,
        content: `${existing.content}${ev.content}`,
      });
      continue;
    }
    if (ev.kind === "reasoning") {
      map.set(ev.subagentId, {
        ...existing,
        reasoning: `${existing.reasoning}${ev.content}`,
      });
      continue;
    }
    if (ev.kind === "tool_call") {
      map.set(ev.subagentId, {
        ...existing,
        status: "tool",
        toolLogs: [...existing.toolLogs, { name: ev.name, input: ev.input, output: "" }],
      });
      continue;
    }
    if (ev.kind === "tool_result") {
      const logs = [...existing.toolLogs];
      const idx = logs.findIndex((l) => l.name === ev.name && !l.output);
      if (idx >= 0) logs[idx] = { ...logs[idx], output: ev.output };
      map.set(ev.subagentId, {
        ...existing,
        status: null,
        toolLogs: logs,
      });
      continue;
    }
    if (ev.kind === "plan") {
      map.set(ev.subagentId, {
        ...existing,
        plan: {
          phase: ev.phase,
          steps: ev.steps,
          currentStep: ev.currentStep,
          toolName: ev.toolName,
        },
      });
      continue;
    }
    if (ev.kind === "subagent_name") {
      const cur = map.get(ev.subagentId);
      if (cur) map.set(ev.subagentId, { ...cur, subagentName: ev.subagentName });
      continue;
    }
    if (ev.kind === "approval_request") {
      const cur = map.get(ev.subagentId) ?? existing;
      const logs = cur.approvalLogs ?? [];
      map.set(ev.subagentId, {
        ...cur,
        approvalLogs: [...logs, {
          requestId: ev.requestId,
          operationType: ev.operationType,
          operationDescription: ev.operationDescription,
          approved: false,
          createdAt: new Date().toISOString(),
        }],
      });
      continue;
    }
    if (ev.kind === "approval_response") {
      const cur = map.get(ev.subagentId);
      if (cur?.approvalLogs) {
        const updated = cur.approvalLogs.map((a) =>
          a.requestId === ev.requestId ? { ...a, approved: ev.approved } : a
        );
        map.set(ev.subagentId, { ...cur, approvalLogs: updated });
      }
      continue;
    }
  }
  return Array.from(map.values());
}

const conversationModeSchema = z.enum(["default", "team"]);
const createConversationBodySchema = {
  title: z.string().max(500).optional(),
  mode: conversationModeSchema.optional(),
  teamId: z.string().max(100).optional(),
};
const createConversationBody = z.object(createConversationBodySchema);

/**
 * Compress task tool messages in-place before persisting to history.
 * Reduces token footprint for reloaded conversations while preserving
 * a short preview and a file reference to the full result.
 */
function compressTaskToolMessagesForStorage(messages: StoredMessage[]) {
  for (const msg of messages) {
    if (msg.type === "tool" && msg.name === "task" && typeof msg.content === "string" && msg.content.length > 200) {
      const idMatch = msg.content.match(/\[subagentId:\s*([^\]]+)\]/);
      const nameMatch = msg.content.match(/\[name:\s*([^\]]+)\]/);
      const subagentId = idMatch?.[1]?.trim() ?? "unknown";
      const agentName = nameMatch?.[1]?.trim() ?? "unknown";
      const headerEnd = msg.content.indexOf("\n\n");
      const body = headerEnd >= 0 ? msg.content.slice(headerEnd + 2) : msg.content;
      msg.content = `[Agent: ${agentName}] Result saved to .agents/results/${subagentId}.md\n${body.slice(0, 100)}...`;
    }
  }
  for (const msg of messages) {
    if (msg.type === "ai" && Array.isArray(msg.tool_calls)) {
      msg.tool_calls = msg.tool_calls.map((tc) => {
        if (tc.name !== "task") return tc;
        try {
          const args = JSON.parse(tc.args);
          if (typeof args.prompt === "string" && args.prompt.length > 100) {
            args.prompt = args.prompt.slice(0, 100) + "... [truncated]";
          }
          return { ...tc, args: JSON.stringify(args) };
        } catch {
          return tc;
        }
      });
    }
  }
}

export function getConversations(req: Request, res: Response): void {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const list = listConversations();
    const total = list.length;
    const conversations = list.slice(offset, offset + limit);
    res.json({ conversations, total });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postConversations(req: Request, res: Response): void {
  try {
    const parsed = createConversationBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const title = parsed.data.title?.trim();
    const mode: ConversationMode = parsed.data.mode ?? "default";
    const teamId = parsed.data.teamId;
    // Validate teamId exists when creating a team-mode conversation
    if (mode === "team" && teamId && !getTeamDef(teamId)) {
      res.status(400).json({ error: `Team '${teamId}' not found` });
      return;
    }
    const config = loadUserConfig();
    const { id, meta } = createConversation(config.context, title || undefined, mode, teamId);
    logConversation("create", id, meta.title);
    res.status(201).json(meta);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getConversationById(req: Request, res: Response): void {
  const id = convId(req);
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json(meta);
}

const updateConversationBody = z.object({ title: z.string().min(1).max(500) });

export function putConversationById(req: Request, res: Response): void {
  const id = convId(req);
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const parsed = updateConversationBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    setConversationTitle(id, parsed.data.title.trim());
    const updated = getConversation(id);
    res.json(updated!);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function deleteConversationById(req: Request, res: Response): void {
  const id = convId(req);
  if (!getConversation(id)) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  try {
    deleteConversation(id);
    logConversation("delete", id);
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getConversationMessages(req: Request, res: Response): void {
  const id = convId(req);
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  try {
    const messages = getMessages(id);
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: "Failed to load messages", detail: String(e) });
  }
}

export function getConversationAttachment(req: Request, res: Response): void {
  const id = convId(req);
  const filename = req.params.filename;
  if (!filename || filename.includes("..")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }
  if (!getConversation(id)) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const fileRef = `attachments/${filename}`;
  const absPath = getAttachmentAbsolutePath(id, fileRef);
  if (!absPath) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }
  res.sendFile(absPath, { maxAge: "1d" }, (err) => {
    if (err) res.status(500).json({ error: String(err) });
  });
}

export async function postConversationMessage(req: Request, res: Response): Promise<void> {
  const id = convId(req);
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const body = req.body as {
    text?: string;
    mode?: ConversationMode;
    attachments?: Array<{ type: string; mimeType?: string; data: string }>;
  };
  const conversationMode: ConversationMode = meta.mode ?? "default";
  if (body?.mode && body.mode !== conversationMode) {
    res.status(400).json({ error: "Conversation mode is immutable" });
    return;
  }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
  if (!text && attachments.length === 0) {
    res.status(400).json({ error: "Missing text or attachments" });
    return;
  }

  // Save attachments first so we can tell the agent about file paths
  const config = loadUserConfig();
  const displayText = text || "[图片]";
  const storedAttachments: Array<{ type: "image"; file: string; mimeType?: string }> = [];
  for (const a of attachments) {
    if ((a.type === "image" || !a.type) && typeof a.data === "string") {
      const fileRef = saveAttachmentFile(id, a.mimeType || "image/png", a.data);
      storedAttachments.push({ type: "image", file: fileRef, mimeType: a.mimeType || "image/png" });
    }
  }

  // Build text part with attachment file paths so the agent knows where files are
  let textPart = text || (attachments.length ? "请分析图片" : " ");
  if (storedAttachments.length > 0) {
    const pathLines = storedAttachments.map((a, i) => {
      const absPath = getAttachmentAbsolutePath(id, a.file);
      return `- Attachment ${i + 1}: ${absPath ?? a.file} (${a.mimeType ?? "image/png"})`;
    });
    textPart += `\n\n[Attached files on disk — use these absolute paths if you need to read/process the files]\n${pathLines.join("\n")}`;
  }

  const humanContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }> =
    attachments.length === 0
      ? textPart
      : [
          { type: "text" as const, text: textPart },
          ...attachments
            .filter((a) => (a.type === "image" || !a.type) && typeof a.data === "string")
            .map((a) => ({
              type: "image_url" as const,
              image_url: { url: a.data.startsWith("data:") ? a.data : `data:${a.mimeType || "image/png"};base64,${a.data}` },
            })),
        ];

  const humanMsg: StoredMessage = {
    type: "human",
    content: displayText,
    ...(storedAttachments.length ? { attachments: storedAttachments } : {}),
  };
  const { messages: contextMessages, meta: contextMeta } = await buildContextForAgent(id, config.modelId, humanMsg);
  const sanitized = sanitizeMessageSequence(contextMessages);
  // Filter out system messages — runAgent/streamAgentWithTokens create their own SystemMessage.
  // Keeping stored system messages causes Anthropic API error:
  // "System messages are only permitted as the first passed message."
  const lcMessages = sanitized.filter((m) => m.type !== "system").map((m) => storedToLangChain(m, id));
  lcMessages.push(new HumanMessage({ content: humanContent }));

  saveFullContext(id, contextMessages, humanMsg, contextMeta);
  const contextUsageBase = {
    strategy: contextMeta.strategy,
    contextWindow: contextMeta.contextWindow,
    thresholdTokens: contextMeta.thresholdTokens,
    tokenThresholdPercent: contextMeta.tokenThresholdPercent ?? 75,
    contextMessageCount: contextMessages.length + 1,
    estimatedTokens: contextMeta.estimatedTokens,
    trimToLast: contextMeta.trimToLast,
    olderCount: contextMeta.olderCount,
    recentCount: contextMeta.recentCount,
  };

  const existingMessages = getMessages(id);
  const isFirstMessage = existingMessages.length === 0;
  const newTitle = isFirstMessage && displayText ? (displayText.slice(0, 24).trim() || "新对话") : undefined;
  appendMessages(id, [humanMsg], newTitle);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  if (res.socket) {
    res.socket.setTimeout(0);
  }

  // S6: Handle client disconnect — cancel pending approvals and abort agent execution
  const abortController = new AbortController();
  let clientDisconnected = false;
  req.on("close", () => {
    clientDisconnected = true;
    abortController.abort();
    approvalManager.cancelConversation(id);
  });

  const FLUSH_INTERVAL = 30;
  let writeBuf = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushNow = () => {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (writeBuf && !clientDisconnected) {
      try { res.write(writeBuf); } catch { /* client gone */ }
      writeBuf = "";
    } else {
      writeBuf = "";
    }
  };

  const write = (data: string) => {
    if (clientDisconnected) return;
    writeBuf += data;
    if (flushTimer === null) {
      flushTimer = setTimeout(flushNow, FLUSH_INTERVAL);
    }
  };

  const writeImmediate = (data: string) => {
    if (clientDisconnected) return;
    writeBuf += data;
    flushNow();
  };

  writeImmediate("data: " + JSON.stringify({ type: "status", status: "thinking" }) + "\n\n");
  writeImmediate("data: " + JSON.stringify({ type: "context", ...contextUsageBase }) + "\n\n");

  const logger = getConversationLogger(id);
  const requestTimer = new PerformanceTimer();
  logger.info("User message received", { text: displayText.slice(0, 100) });

  const onToken = (token: string) => {
    if (token) write("data: " + JSON.stringify({ type: "token", content: token }) + "\n\n");
  };
  const onReasoningToken = (token: string) => {
    if (token) write("data: " + JSON.stringify({ type: "reasoning", content: token }) + "\n\n");
  };

  const skillContext = buildSkillContext(id);
  const workspacePath = ensureWorkspace(id);
  const collectedStored: StoredMessage[] = [];
  const isAnthropicApi = (() => { try { return loadModelConfig(config.modelId).api === "anthropic-messages"; } catch { return false; } })();
  const pendingToolLogs: Array<{ name: string; input: string; output: string }> = [];
  let streamedContent = "";
  let lastReasoning: string | undefined;
  let llmCallCount = 0;
  let toolCallCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let firstPromptTokensForContext: number | null = null;
  let lastPromptTokensForContext: number | null = null;
  let latestPlan: PlanStreamEvent | undefined;
  const subagentEvents: SubagentStreamEvent[] = [];
  let resultsSaved = false;

  // 将收集到的消息持久化（正常完成和中途报错都会调用）
  const saveCollectedResults = (errorMsg?: string) => {
    if (resultsSaved) return;
    resultsSaved = true;

    if (pendingToolLogs.length > 0) {
      const withContent = collectedStored.filter((m) => m.type === "ai" && typeof m.content === "string" && m.content.trim());
      const target = withContent.pop() ?? collectedStored.filter((m) => m.type === "ai").pop();
      if (target) {
        target.toolLogs = pendingToolLogs;
        if (!target.content || !target.content.trim()) {
          target.content = streamedContent.trim() || "(工具已执行)";
        }
      }
    }
    if (latestPlan?.steps?.length) {
      const target = collectedStored.filter((m) => m.type === "ai").pop();
      if (target && target.type === "ai") target.plan = latestPlan;
    }
    const subagentLogs = buildSubagentLogs(subagentEvents);
    if (subagentLogs.length > 0) {
      const target = collectedStored.filter((m) => m.type === "ai").pop();
      if (target && target.type === "ai") target.subagents = subagentLogs;
    }
    const toStore = collectedStored.filter((m) => {
      if (m.type !== "ai") return true;
      if (m.toolLogs && m.toolLogs.length > 0) return true;
      if (m.plan && m.plan.steps.length > 0) return true;
      if (m.subagents && m.subagents.length > 0) return true;
      // Keep AI messages that carry tool_calls — dropping them would orphan
      // the corresponding ToolMessages and break the message sequence.
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
      return typeof m.content === "string" && m.content.trim().length > 0;
    });
    const hasContent = streamedContent.trim() || pendingToolLogs.length > 0 || (latestPlan?.steps?.length ?? 0) > 0 || subagentLogs.length > 0;
    if (toStore.filter((m) => m.type === "ai").length === 0 && hasContent) {
      const content = errorMsg
        ? `${streamedContent.trim() || "(执行中断)"}\n\n> ⚠️ 执行出错: ${errorMsg}`
        : (streamedContent.trim() || "(工具已执行)");
      toStore.push({
        type: "ai",
        content,
        ...(config.modelId ? { modelId: config.modelId } : {}),
        ...(lastReasoning ? { reasoningContent: lastReasoning } : {}),
        ...(pendingToolLogs.length > 0 ? { toolLogs: pendingToolLogs } : {}),
        ...(latestPlan?.steps?.length ? { plan: latestPlan } : {}),
        ...(subagentLogs.length > 0 ? { subagents: subagentLogs } : {}),
      });
    } else if (errorMsg) {
      const lastAi = toStore.filter((m) => m.type === "ai").pop();
      if (lastAi) lastAi.content = (lastAi.content || "").trimEnd() + `\n\n> ⚠️ 执行出错: ${errorMsg}`;
    }
    if (toStore.length > 0) {
      compressTaskToolMessagesForStorage(toStore);
      appendMessages(id, toStore);
    }
    return subagentLogs;
  };

  try {
    for await (const chunk of streamAgentWithTokens(
      lcMessages,
      onToken,
      config.modelId,
      onReasoningToken,
      skillContext,
      {
        conversationMode,
        conversationId: id,
        teamId: meta.teamId,
        planningEnabled: config.planning?.enabled ?? true,
        workspacePath,
        abortSignal: abortController.signal,
        planProgressEnabled: config.planning?.streamProgress ?? true,
        onPlanEvent: (event) => {
          latestPlan = { ...event };
          writeImmediate("data: " + JSON.stringify({ type: "plan", ...event }) + "\n\n");
        },
        onSubagentEvent: (event) => {
          subagentEvents.push(event);
          writeImmediate("data: " + JSON.stringify({ type: "subagent", ...event }) + "\n\n");
        },
      }
    )) {
      const key = chunk && typeof chunk === "object" ? Object.keys(chunk as object)[0] : "";
      const part = key ? (chunk as Record<string, { messages?: BaseMessage[]; reasoning?: string; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }>)[key] : undefined;
      if (key === "usage" && part && typeof part === "object" && "prompt_tokens" in part) {
        const u = part as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
        if (firstPromptTokensForContext === null && prompt > 0) firstPromptTokensForContext = prompt;
        if (prompt > 0) lastPromptTokensForContext = prompt;
        totalPromptTokens += prompt;
        totalCompletionTokens += typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
      }
      if (part?.reasoning) {
        write("data: " + JSON.stringify({ type: "reasoning", content: part.reasoning }) + "\n\n");
        lastReasoning = part.reasoning;
      }
      if (key === "llmCall" && part?.messages?.length) {
        llmCallCount++;
        const aiMsg = part.messages.find((m) => (m as { _getType?: () => string })._getType?.() === "ai") as { tool_calls?: Array<{ name: string; args?: string | object }>; content?: string } | undefined;
        const toolCalls = aiMsg?.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const input = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {});
            writeImmediate("data: " + JSON.stringify({ type: "tool_call", name: tc.name, input }) + "\n\n");
            pendingToolLogs.push({ name: tc.name, input, output: "" });
          }
        }
      }
      if (key === "toolNode" && part?.messages?.length) {
        for (const msg of part.messages) {
          const toolMsg = msg as { _getType?: () => string; name?: string; content?: string };
          if (toolMsg._getType?.() === "tool" && toolMsg.name) {
            toolCallCount++;
            const output = typeof toolMsg.content === "string" ? toolMsg.content : "";
            const pending = pendingToolLogs.filter((tl) => tl.name === toolMsg.name && !tl.output);
            if (pending.length > 0) pending[0].output = output;
            writeImmediate("data: " + JSON.stringify({ type: "tool_result", name: toolMsg.name, output }) + "\n\n");

            // 记录工具调用
            logToolCall(id, {
              toolName: toolMsg.name,
              input: pending[0]?.input || "",
              output: output.slice(0, 500), // 限制长度
              success: !output.startsWith("[error]"),
            });
          }
        }
      }
      if (part?.messages?.length) {
        const reasoning = typeof part.reasoning === "string" ? part.reasoning : undefined;
        for (const msg of part.messages) {
          const t = (msg as { _getType?: () => string })._getType?.();
          const stored = langChainToStored(msg);

          // 根据配置决定是否保存 tool 消息到历史记录
          if (stored.type === "tool") {
            const saveToolMessages = config.context?.saveToolMessages ?? true;
            if (saveToolMessages) {
              collectedStored.push(stored);
            }
            continue;
          }

          // 保存 AI 消息
          if (stored.type === "ai") {
            if (typeof stored.content === "string" && stored.content.trim()) {
              streamedContent = stored.content;
            }
            // Merge reasoning: prefer reasoning from stream event, fallback to langChainToStored extraction
            if (reasoning) stored.reasoningContent = reasoning;
            if (config.modelId) stored.modelId = config.modelId;
            // For Anthropic models: intermediate AI messages (with tool_calls + text content)
            // should not create separate bubbles. Strip their text content so only tool_calls
            // are stored; the text has already been streamed to the user via onToken.
            // Only apply to Anthropic API — OpenAI models may legitimately include text alongside tool_calls.
            const hasToolCalls = Array.isArray(stored.tool_calls) && stored.tool_calls.length > 0;
            if (isAnthropicApi && hasToolCalls && typeof stored.content === "string" && stored.content.trim()) {
              stored.content = "";
            }
            collectedStored.push(stored);
          }
        }
      }
    }
    if (pendingToolLogs.length > 0) {
      const withContent = collectedStored.filter((m) => m.type === "ai" && typeof m.content === "string" && m.content.trim());
      const target = withContent.pop() ?? collectedStored.filter((m) => m.type === "ai").pop();
      if (target) {
        target.toolLogs = pendingToolLogs;
        if (!target.content || !target.content.trim()) {
          target.content = streamedContent.trim() || "(工具已执行)";
        }
      }
    }
    if (latestPlan?.steps?.length) {
      const target = collectedStored.filter((m) => m.type === "ai").pop();
      if (target && target.type === "ai") {
        target.plan = latestPlan;
      }
    }
    const subagentLogs = buildSubagentLogs(subagentEvents);
    if (subagentLogs.length > 0) {
      const target = collectedStored.filter((m) => m.type === "ai").pop();
      if (target && target.type === "ai") {
        target.subagents = subagentLogs;
      }
    }
    const toStore = collectedStored.filter((m) => {
      if (m.type !== "ai") return true;
      if (m.toolLogs && m.toolLogs.length > 0) return true;
      if (m.plan && m.plan.steps.length > 0) return true;
      if (m.subagents && m.subagents.length > 0) return true;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
      return typeof m.content === "string" && m.content.trim().length > 0;
    });
    if (toStore.filter((m) => m.type === "ai").length === 0 && (streamedContent.trim() || pendingToolLogs.length > 0 || (latestPlan?.steps?.length ?? 0) > 0 || subagentLogs.length > 0)) {
      toStore.push({
        type: "ai",
        content: streamedContent.trim() || "(工具已执行)",
        ...(config.modelId ? { modelId: config.modelId } : {}),
        ...(lastReasoning ? { reasoningContent: lastReasoning } : {}),
        ...(pendingToolLogs.length > 0 ? { toolLogs: pendingToolLogs } : {}),
        ...(latestPlan?.steps?.length ? { plan: latestPlan } : {}),
        ...(subagentLogs.length > 0 ? { subagents: subagentLogs } : {}),
      });
    }
    // usageTokens: 本轮对话的总 token 消耗（所有 LLM 调用的累加），用于计费统计
    const hasRealUsage = totalPromptTokens > 0 || totalCompletionTokens > 0;
    const promptTokens = hasRealUsage ? totalPromptTokens : estimateBaseMessageTokens(lcMessages);
    const completionTokens = hasRealUsage ? totalCompletionTokens : estimateTextTokens(streamedContent || "");
    const totalTokens = promptTokens + completionTokens;
    // contextPromptTokens: 上下文峰值体积（最后一次 LLM 调用的 prompt），反映 agent 运行时的真实上下文占用
    // 优先级：最后一次真实值 > 第一次真实值 > 估算值 > 回退到总 promptTokens
    const contextPromptTokens = lastPromptTokensForContext
      ?? firstPromptTokensForContext
      ?? (typeof contextMeta.estimatedTokens === "number" ? contextMeta.estimatedTokens : undefined)
      ?? promptTokens;
    const usagePayload = { promptTokens, completionTokens, totalTokens };
    const lastAi = toStore.filter((m) => m.type === "ai").pop();
    if (lastAi && totalTokens > 0) {
      lastAi.usageTokens = usagePayload;
      lastAi.contextUsage = {
        ...contextUsageBase,
        promptTokens: contextPromptTokens,
      };
    }
    if (toStore.length > 0) {
      compressTaskToolMessagesForStorage(toStore);
      appendMessages(id, toStore);
    }
    resultsSaved = true;
    writeImmediate(
      "data: " + JSON.stringify({ type: "usage", ...usagePayload, context: { ...contextUsageBase, promptTokens: contextPromptTokens } }) + "\n\n",
    );
    flushNow();

    // 记录请求完成
    logger.info("Request completed", {
      llmCalls: llmCallCount,
      toolCalls: toolCallCount,
      durationMs: requestTimer.elapsed(),
    });
  } catch (e) {
    flushNow();
    const errMsg = e instanceof Error ? e.message : String(e);
    logError(id, e instanceof Error ? e : String(e), { stage: "stream_agent" });
    // 保存已完成的部分结果，避免刷新后消息丢失
    try { saveCollectedResults(errMsg); } catch { /* ignore save errors */ }
    res.write("data: " + JSON.stringify(buildStreamErrorPayload(errMsg)) + "\n\n");
  } finally {
    if (flushTimer !== null) clearTimeout(flushTimer);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

export async function postConversationMessageSync(req: Request, res: Response): Promise<void> {
  const id = convId(req);
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const body = req.body as { text?: string; mode?: ConversationMode };
  const conversationMode: ConversationMode = meta.mode ?? "default";
  if (body?.mode && body.mode !== conversationMode) {
    res.status(400).json({ error: "Conversation mode is immutable" });
    return;
  }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Missing or empty text" });
    return;
  }

  const config = loadUserConfig();
  const humanMsg: StoredMessage = { type: "human", content: text };
  const { messages: contextMessages, meta: contextMeta } = await buildContextForAgent(id, config.modelId, humanMsg);
  const sanitized = sanitizeMessageSequence(contextMessages);
  // Filter out system messages — runAgent already creates its own SystemMessage
  const lcMessages = sanitized.filter((m) => m.type !== "system").map((m) => storedToLangChain(m, id));
  lcMessages.push(new HumanMessage(text));

  saveFullContext(id, contextMessages, humanMsg, contextMeta);
  const contextUsageBase = {
    strategy: contextMeta.strategy,
    contextWindow: contextMeta.contextWindow,
    thresholdTokens: contextMeta.thresholdTokens,
    tokenThresholdPercent: contextMeta.tokenThresholdPercent ?? 75,
    contextMessageCount: contextMessages.length + 1,
    estimatedTokens: contextMeta.estimatedTokens,
    trimToLast: contextMeta.trimToLast,
    olderCount: contextMeta.olderCount,
    recentCount: contextMeta.recentCount,
  };

  const existingMessagesSync = getMessages(id);
  const isFirstMessageSync = existingMessagesSync.length === 0;
  const newTitleSync = isFirstMessageSync && text ? (text.slice(0, 24).trim() || "新对话") : undefined;
  appendMessages(id, [{ type: "human", content: text }], newTitleSync);

  const skillContext = buildSkillContext(id);
  const workspacePath = ensureWorkspace(id);

  try {
    const resultMessages = await runAgent(lcMessages, config.modelId, skillContext, {
      conversationMode,
      conversationId: id,
      teamId: meta.teamId,
      planningEnabled: config.planning?.enabled ?? true,
      workspacePath,
    });
    const newStored: StoredMessage[] = resultMessages.map((m) => {
      const s = langChainToStored(m);
      if (s.type === "ai" && config.modelId) s.modelId = config.modelId;
      return s;
    });
    compressTaskToolMessagesForStorage(newStored);
    const lastAi = newStored.filter((m) => m.type === "ai").pop();
    if (lastAi && lastAi.type === "ai") {
      lastAi.contextUsage = {
        ...contextUsageBase,
        promptTokens: contextMeta.estimatedTokens,
      };
    }
    appendMessages(id, newStored);
    const lastAiMsg = resultMessages.filter((m) => m._getType() === "ai").pop();
    const reply = lastAiMsg ? getTextContent(lastAiMsg) : "";
    res.json({ reply, messages: newStored });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function postChat(req: Request, res: Response): Promise<void> {
  const body = req.body as { message?: string };
  const text = typeof body?.message === "string" ? body.message.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Missing or empty message" });
    return;
  }
  const config = loadUserConfig();
  const messages = [new HumanMessage(text)];
  try {
    const resultMessages = await runAgent(messages, config.modelId, undefined, {
      planningEnabled: config.planning?.enabled ?? true,
    });
    const lastAi = resultMessages.filter((m) => m._getType() === "ai").pop();
    const reply = lastAi ? getTextContent(lastAi) : "";
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getConfig(_req: Request, res: Response): void {
  const config = loadUserConfig();
  const toolIds = listToolIds();
  const models = listModels();
  const mcpStatus = getMcpStatus();
  res.json({ ...config, availableToolIds: toolIds, availableModels: models, mcpStatus });
}

export function getModels(_req: Request, res: Response): void {
  try {
    res.json(listModels());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── Model Provider CRUD ──────────────────────────────

export function getModelProviders(_req: Request, res: Response): void {
  try {
    res.json(listProviders());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postModelProvider(req: Request, res: Response): void {
  try {
    const { name, baseUrl, apiKey, api, models } = req.body as {
      name?: string; baseUrl?: string; apiKey?: string; api?: string; models?: unknown[];
    };
    if (!name || !baseUrl || !apiKey || !api) {
      res.status(400).json({ error: "name, baseUrl, apiKey, and api are required" });
      return;
    }
    addProviderConfig(name, { baseUrl, apiKey, api, models: (models ?? []) as any[] });
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(msg.includes("already exists") ? 409 : 500).json({ error: msg });
  }
}

export function putModelProvider(req: Request, res: Response): void {
  try {
    const name = String(req.params.name);
    const updates = req.body as Record<string, unknown>;
    updateProviderConfig(name, updates as any);
    clearProviderValidations(name);
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(msg.includes("not found") ? 404 : 500).json({ error: msg });
  }
}

export function deleteModelProvider(req: Request, res: Response): void {
  try {
    const name = String(req.params.name);
    deleteProviderConfig(name);
    clearProviderValidations(name);
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(msg.includes("not found") ? 404 : 500).json({ error: msg });
  }
}

// ─── Model Validation ──────────────────────────────

export function getValidationResults(_req: Request, res: Response): void {
  try {
    res.json(loadValidationResults());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function postValidateModels(req: Request, res: Response): Promise<void> {
  try {
    const { modelIds } = req.body as { modelIds?: string[] };
    if (!Array.isArray(modelIds) || modelIds.length === 0) {
      res.status(400).json({ error: "modelIds array is required" });
      return;
    }
    const results = await validateModelsBatch(modelIds);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function postValidateAllModels(_req: Request, res: Response): Promise<void> {
  try {
    const results = await validateAllModels();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

function createTemplateId(): string {
  return `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTemplateBody(body: unknown): { name: string; content: string; description?: string } | null {
  if (!body || typeof body !== "object") return null;
  const input = body as { name?: unknown; content?: unknown; description?: unknown };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const content = typeof input.content === "string" ? input.content : "";
  if (!name || !content.trim()) return null;
  return {
    name,
    content,
    description: typeof input.description === "string" ? input.description.trim() || undefined : undefined,
  };
}

export function getTemplates(_req: Request, res: Response): void {
  const config = loadUserConfig();
  res.json(Array.isArray(config.templates) ? config.templates : []);
}

export function postTemplates(req: Request, res: Response): void {
  const normalized = normalizeTemplateBody(req.body);
  if (!normalized) {
    res.status(400).json({ error: "模板名称和内容不能为空" });
    return;
  }
  const config = loadUserConfig();
  const now = new Date().toISOString();
  const template: PromptTemplate = {
    id: createTemplateId(),
    name: normalized.name,
    content: normalized.content,
    description: normalized.description,
    createdAt: now,
    updatedAt: now,
  };
  config.templates = [...(config.templates ?? []), template];
  saveUserConfig(config);
  res.status(201).json(template);
}

export function putTemplateById(req: Request, res: Response): void {
  const id = Array.isArray(req.params.id) ? req.params.id[0] ?? "" : req.params.id;
  if (!id) {
    res.status(400).json({ error: "模板 ID 不能为空" });
    return;
  }
  const normalized = normalizeTemplateBody(req.body);
  if (!normalized) {
    res.status(400).json({ error: "模板名称和内容不能为空" });
    return;
  }
  const config = loadUserConfig();
  const templates = config.templates ?? [];
  const idx = templates.findIndex((item) => item.id === id);
  if (idx < 0) {
    res.status(404).json({ error: "模板不存在" });
    return;
  }
  const updated: PromptTemplate = {
    ...templates[idx],
    name: normalized.name,
    content: normalized.content,
    description: normalized.description,
    updatedAt: new Date().toISOString(),
  };
  const next = [...templates];
  next[idx] = updated;
  config.templates = next;
  saveUserConfig(config);
  res.json(updated);
}

export function deleteTemplateById(req: Request, res: Response): void {
  const id = Array.isArray(req.params.id) ? req.params.id[0] ?? "" : req.params.id;
  if (!id) {
    res.status(400).json({ error: "模板 ID 不能为空" });
    return;
  }
  const config = loadUserConfig();
  const templates = config.templates ?? [];
  if (!templates.some((item) => item.id === id)) {
    res.status(404).json({ error: "模板不存在" });
    return;
  }
  config.templates = templates.filter((item) => item.id !== id);
  saveUserConfig(config);
  res.status(204).send();
}

export function getSkillsList(_req: Request, res: Response): void {
  try {
    res.json(listSkills());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function postSkillsUpload(req: Request, res: Response): Promise<void> {
  const file = req.file as (Express.Multer.File & { buffer?: Buffer }) | undefined;
  if (!file || !(file.buffer && Buffer.isBuffer(file.buffer))) {
    res.status(400).json({ error: "请上传 ZIP 文件（字段名 zip）" });
    return;
  }
  if (!file.originalname.toLowerCase().endsWith(".zip")) {
    res.status(400).json({ error: "仅支持 .zip 格式" });
    return;
  }
  try {
    const result = installSkillFromZip(file.buffer);
    res.status(201).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
}

export function deleteSkillById(req: Request, res: Response): void {
  const name = (Array.isArray(req.params.name) ? req.params.name[0] : req.params.name) ?? "";
  if (!name) {
    res.status(400).json({ error: "Missing skill name" });
    return;
  }
  try {
    deleteSkill(name);
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
}

export async function putConfig(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    enabledToolIds?: string[];
    mcpServers?: UserConfig["mcpServers"];
    modelId?: string;
    context?: Partial<ContextStrategyConfig>;
    planning?: Partial<PlanningConfig>;
    templates?: PromptTemplate[];
    approvalRules?: ApprovalRule[];
    codeIndexStrategy?: string;
  };
  const config = loadUserConfig();
  if (Array.isArray(body.enabledToolIds)) config.enabledToolIds = body.enabledToolIds;
  if (Array.isArray(body.mcpServers)) config.mcpServers = body.mcpServers;
  if (typeof body.modelId === "string") config.modelId = body.modelId;
  if (body.context && typeof body.context === "object") {
    config.context = config.context ?? {
      strategy: "compress",
      trimToLast: 20,
      tokenThresholdPercent: 75,
      compressKeepRecent: 20,
    };
    if (body.context.strategy === "compress" || body.context.strategy === "trim") config.context.strategy = body.context.strategy;
    if (typeof body.context.trimToLast === "number" && body.context.trimToLast > 0) config.context.trimToLast = body.context.trimToLast;
    if (typeof body.context.tokenThresholdPercent === "number" && body.context.tokenThresholdPercent > 0 && body.context.tokenThresholdPercent <= 100) config.context.tokenThresholdPercent = body.context.tokenThresholdPercent;
    if (typeof body.context.compressKeepRecent === "number" && body.context.compressKeepRecent > 0) config.context.compressKeepRecent = body.context.compressKeepRecent;
  }
  if (body.planning && typeof body.planning === "object") {
    config.planning = config.planning ?? { enabled: true, streamProgress: true };
    if (typeof body.planning.enabled === "boolean") config.planning.enabled = body.planning.enabled;
    if (typeof body.planning.streamProgress === "boolean") config.planning.streamProgress = body.planning.streamProgress;
  }
  if (Array.isArray(body.templates)) config.templates = body.templates;
  if (Array.isArray(body.approvalRules)) config.approvalRules = body.approvalRules;
  if (body.codeIndexStrategy === "none" || body.codeIndexStrategy === "repomap" || body.codeIndexStrategy === "vector") {
    config.codeIndexStrategy = body.codeIndexStrategy;
  } else if (body.codeIndexStrategy === "" || body.codeIndexStrategy === null) {
    config.codeIndexStrategy = undefined;
  }
  saveUserConfig(config);

  // MCP 连接在后台异步执行，不阻塞响应（npx 下载包可能很慢）
  if (Array.isArray(body.mcpServers)) {
    connectToMcpServers(config.mcpServers).catch((e) => {
      logError(null, e instanceof Error ? e : String(e), { stage: "mcp_reconnect" });
    });
  }

  const mcpStatus = getMcpStatus();
  res.json({ ...config, mcpStatus });
}

// ─── MCP restart ─────────────────────────────────────────────

export async function postMcpRestart(req: Request, res: Response): Promise<void> {
  const { serverName } = req.body as { serverName?: string };
  if (!serverName || typeof serverName !== "string") {
    res.status(400).json({ error: "serverName is required" });
    return;
  }
  const config = loadUserConfig();
  try {
    const result = await restartMcpServer(serverName, config.mcpServers);
    const mcpStatus = getMcpStatus();
    res.json({ ...result, mcpStatus });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ─── Artifact (workspace) routes ─────────────────────────────

export function getConversationArtifacts(req: Request, res: Response): void {
  const id = convId(req);
  if (!getConversation(id)) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  try {
    res.json(listArtifacts(id));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getConversationArtifactFile(req: Request, res: Response): void {
  const id = convId(req);
  const filePath = req.params[0];
  if (!filePath || filePath.includes("..")) {
    res.status(400).json({ error: "Invalid file path" });
    return;
  }
  if (!getConversation(id)) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const absPath = getArtifactAbsolutePath(id, filePath);
  if (!absPath) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  res.sendFile(absPath, { maxAge: "1d" }, (err) => {
    if (err) res.status(500).json({ error: String(err) });
  });
}

// ─── 导出对话 ─────────────────────────────────────────────

function conversationToMarkdown(meta: ConversationMeta, messages: StoredMessage[]): string {
  const lines: string[] = [`# ${meta.title}`, "", `创建时间: ${meta.createdAt}`, `更新时间: ${meta.updatedAt}`, ""];
  for (const m of messages) {
    const role = m.type === "human" ? "用户" : m.type === "ai" ? "助手" : "系统";
    lines.push(`## ${role}`, "", String(m.content || "").trim() || "(无内容)", "");
  }
  return lines.join("\n");
}

export function getConversationExport(req: Request, res: Response): void {
  const id = convId(req);
  const format = (req.query.format as string) || "markdown";
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const messages = getMessages(id);
  if (format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="${meta.id}.json"`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({ meta, messages });
    return;
  }
  const markdown = conversationToMarkdown(meta, messages);
  // 使用纯 ASCII 文件名避免 Content-Disposition 报错 ERR_INVALID_CHAR
  res.setHeader("Content-Disposition", `attachment; filename="${id}.md"`);
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.send(markdown);
}

// ─── 手动压缩上下文 ─────────────────────────────────────────────

export async function postConversationCompress(req: Request, res: Response): Promise<void> {
  const id = convId(req);
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const config = loadUserConfig();
  const messages = getMessages(id);

  // 如果消息数量太少，不需要压缩
  if (messages.length < 5) {
    res.status(400).json({ error: "消息数量太少（至少需要5条消息），不需要压缩" });
    return;
  }

  const logger = getConversationLogger(id);
  logger.info("Manual compression requested", {
    messageCount: messages.length,
    strategy: config.context?.strategy || 'default',
  });

  try {
    // 强制处理上下文（forceCompress: true）
    // - 跳过阈值检查，即使当前 token 用量很低也会执行
    // - 策略仍然使用用户配置的策略（compress 或 trim）
    const startTime = Date.now();
    const { messages: contextMessages, meta: contextMeta } = await buildContextForAgent(id, config.modelId, undefined, true);
    const duration = Date.now() - startTime;

    logger.info("Manual compression completed", {
      strategy: contextMeta.strategy,
      totalMessages: contextMeta.totalMessages,
      estimatedTokens: contextMeta.estimatedTokens,
      olderCount: contextMeta.olderCount,
      recentCount: contextMeta.recentCount,
      trimToLast: contextMeta.trimToLast,
      durationMs: duration,
    });

    // 返回压缩后的统计信息
    res.json({
      success: true,
      strategy: contextMeta.strategy,
      totalMessages: contextMeta.totalMessages,
      estimatedTokens: contextMeta.estimatedTokens,
      olderCount: contextMeta.olderCount,
      recentCount: contextMeta.recentCount,
      trimToLast: contextMeta.trimToLast,
    });

    logger.info("Manual compression completed", {
      strategy: contextMeta.strategy,
      totalMessages: contextMeta.totalMessages,
      estimatedTokens: contextMeta.estimatedTokens,
    });
  } catch (e) {
    logError(id, e instanceof Error ? e : String(e), { stage: "manual_compress" });
    res.status(500).json({ error: String(e) });
  }
}

// ─── Code Index Status ────────────────────────────────────

export async function getIndexStatus(_req: Request, res: Response): Promise<void> {
  try {
    const { indexManager } = await import("../index-strategy/index.js");
    const { detectAvailableStrategies } = await import("../index-strategy/detect.js");
    const config = loadUserConfig();
    const detection = await detectAvailableStrategies();
    // Try to get current workspace status — use query param or cwd as fallback
    let currentStatus = null;
    try {
      const workspacePath = (_req.query.workspace as string | undefined) || process.cwd();
      const strategy = await indexManager.getStrategy(workspacePath);
      currentStatus = strategy.getStatus();
    } catch {
      // No active workspace
    }
    res.json({
      configured: config.codeIndexStrategy ?? null,
      recommended: detection.recommended,
      available: detection.available,
      current: currentStatus,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function postIndexBuild(req: Request, res: Response): Promise<void> {
  try {
    const convId = String(req.params.id);
    if (!convId) { res.status(400).json({ error: "conversation id required" }); return; }
    const { indexManager } = await import("../index-strategy/index.js");
    const config = loadUserConfig();
    const workspacePath = ensureWorkspace(convId);
    // Allow explicit strategy from request body, fallback to config
    const requestedStrategy = req.body?.strategy as string | undefined;
    const strategyType = (requestedStrategy === "none" || requestedStrategy === "repomap" || requestedStrategy === "vector")
      ? requestedStrategy
      : config.codeIndexStrategy;
    const strategy = await indexManager.getStrategy(workspacePath, strategyType);

    // Check if already building
    const building = indexManager.getBuildingStrategies(workspacePath);
    if (building.includes(strategy.type)) {
      res.json({ status: "already_building", strategy: strategy.type });
      return;
    }

    // Start build in background, respond immediately
    indexManager.startBuild(workspacePath, strategy).catch((e) => {
      logError(convId, e instanceof Error ? e : String(e), { stage: "index_build" });
    });
    res.json({ status: "building", strategy: strategy.type });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function getConversationIndexStatus(req: Request, res: Response): Promise<void> {
  try {
    const convId = String(req.params.id);
    if (!convId) { res.status(400).json({ error: "conversation id required" }); return; }
    const { indexManager } = await import("../index-strategy/index.js");
    const { detectAvailableStrategies } = await import("../index-strategy/detect.js");
    const config = loadUserConfig();
    const workspacePath = ensureWorkspace(convId);

    // Get active strategy status
    const strategy = await indexManager.getStrategy(workspacePath);
    const activeStatus = strategy.getStatus();

    // Get all strategies' build statuses
    const allStatuses = await indexManager.getAllStatuses(workspacePath);

    // Get dependency availability
    const detection = await detectAvailableStrategies();

    // Get which strategies are currently building
    const buildingStrategies = indexManager.getBuildingStrategies(workspacePath);

    res.json({
      configured: config.codeIndexStrategy ?? null,
      recommended: detection.recommended,
      active: activeStatus,
      building: buildingStrategies,
      strategies: {
        none: { ...allStatuses["none"], available: true, missing: [] },
        repomap: {
          ...allStatuses["repomap"],
          available: detection.available.find(a => a.type === "repomap")?.ready ?? false,
          missing: detection.available.find(a => a.type === "repomap")?.missing ?? [],
        },
        vector: {
          ...allStatuses["vector"],
          available: detection.available.find(a => a.type === "vector")?.ready ?? false,
          missing: detection.available.find(a => a.type === "vector")?.missing ?? [],
        },
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

// ─── 健康检查 ─────────────────────────────────────────────

export function getHealth(_req: Request, res: Response): void {
  res.json({ status: "ok" });
}

// ─── 审批接口 ─────────────────────────────────────────────

export function getApprovals(req: Request, res: Response): void {
  const id = convId(req);
  if (!id) {
    res.status(400).json({ error: "Missing conversation id" });
    return;
  }
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const pending = approvalManager.getPendingRequests(id);
  res.json(pending);
}

export function postApprovalDecision(req: Request, res: Response): void {
  const id = convId(req);
  const requestId = Array.isArray(req.params.requestId) ? req.params.requestId[0] ?? "" : req.params.requestId;
  if (!id || !requestId) {
    res.status(400).json({ error: "Missing conversation id or request id" });
    return;
  }
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const body = req.body as { approved?: boolean };
  if (typeof body?.approved !== "boolean") {
    res.status(400).json({ error: "Missing or invalid 'approved' boolean field" });
    return;
  }
  // Verify requestId belongs to this conversation (S2: prevent cross-conversation approval)
  if (!approvalManager.belongsToConversation(requestId, id)) {
    res.status(404).json({ error: "Approval request not found in this conversation" });
    return;
  }
  const resolved = approvalManager.resolveRequest(requestId, body.approved);
  if (!resolved) {
    res.status(404).json({ error: "Approval request not found or already resolved" });
    return;
  }
  res.json({ ok: true, requestId, approved: body.approved });
}

// ─── Agent Defs CRUD ─────────────────────────────────────

export function getAgents(_req: Request, res: Response): void {
  try {
    res.json(listAgentDefs());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

const agentDefBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  icon: z.string().max(10).default("🤖"),
  color: z.string().max(20).default("#6B7280"),
  systemPrompt: z.string().max(5000).default(""),
  allowedTools: z.array(z.string()).default(["*"]),
});

export function postAgents(req: Request, res: Response): void {
  try {
    const parsed = agentDefBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const def = createAgentDef(parsed.data);
    res.status(201).json(def);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

const AGENT_GENERATE_PROMPT = `你是一个 AI Agent 定义生成器。用户会给你一句话描述，你需要生成一个完整的 Agent 定义。

请严格按照以下 JSON 格式返回（不要包含任何其他文字，只返回 JSON）：
{
  "name": "Agent 名称（简短，2-4个字）",
  "description": "一句话描述该 Agent 的核心职责",
  "icon": "一个合适的 emoji 图标",
  "color": "一个十六进制颜色值，如 #3B82F6",
  "systemPrompt": "详细的系统提示词，定义角色、能力、行为规范（200-500字）",
  "allowedTools": ["该角色可以使用的工具列表，用 * 表示全部允许"]
}

可选的工具列表（allowedTools 从中选择要启用的，或用 ["*"] 表示全部启用）：
- run_command: 执行 shell 命令
- read_file: 读取文件内容
- write_file: 写入文件内容
- edit_file: 搜索替换编辑文件
- search_code: 正则搜索代码
- list_files: 列出文件目录树
- git_operations: Git 操作（status/diff/log/commit 等）
- test_runner: 运行测试（自动检测框架）
- load_skill: 加载技能指令
- background_run: 后台运行命令
- background_check: 查看后台任务状态
- background_cancel: 取消后台任务
- web_search: 搜索网络信息（DuckDuckGo）
- project_index: 管理代码索引（构建、状态、切换策略）
- project_search: 语义级代码搜索（基于索引）
- project_snapshot: 获取项目快照/地图（架构概览）

注意：
- systemPrompt 要详细、专业，清晰定义角色边界
- 根据角色合理选择需要的工具（如研究员只需 read_file、search_code、list_files）
- 颜色要有辨识度，不同角色用不同色系`;

export async function generateAgentFromDescription(req: Request, res: Response): Promise<void> {
  const body = req.body as { description?: string };
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (!description) {
    res.status(400).json({ error: "Missing or empty description" });
    return;
  }

  try {
    const config = loadUserConfig();
    const llm = getLLM(config.modelId);
    const response = await llm.invoke([
      new SystemMessage(AGENT_GENERATE_PROMPT),
      new HumanMessage(description),
    ]);

    const content = typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map((c) => ("type" in c && c.type === "text" && typeof c.text === "string") ? c.text : "").join("")
        : String(response.content);

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? content.match(/(\{[\s\S]*\})/);
    if (!jsonMatch?.[1]) {
      res.status(500).json({ error: "Failed to parse LLM response", raw: content });
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      res.status(500).json({ error: "LLM 返回的 JSON 格式无效", raw: content });
      return;
    }
    const result = {
      name: String(parsed.name ?? ""),
      description: String(parsed.description ?? ""),
      icon: String(parsed.icon ?? "🤖"),
      color: String(parsed.color ?? "#6B7280"),
      systemPrompt: String(parsed.systemPrompt ?? ""),
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools.map(String) : ["*"],
    };

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getAgentById(req: Request, res: Response): void {
  const id = req.params.id as string;
  const def = getAgentDef(id);
  if (!def) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(def);
}

export function putAgentById(req: Request, res: Response): void {
  const id = req.params.id as string;
  const existing = getAgentDef(id);
  if (!existing) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (existing.builtIn) {
    res.status(403).json({ error: "Cannot edit built-in agent" });
    return;
  }
  const parsed = agentDefBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const updated = updateAgentDef(id, parsed.data);
  if (!updated) {
    res.status(500).json({ error: "Update failed" });
    return;
  }
  res.json(updated);
}

export function deleteAgentById(req: Request, res: Response): void {
  const id = req.params.id as string;
  const existing = getAgentDef(id);
  if (!existing) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (existing.builtIn) {
    res.status(403).json({ error: "Cannot delete built-in agent" });
    return;
  }
  // Prevent deletion if agent is referenced by any team
  const teams = listTeamDefs();
  const referencingTeams = teams.filter((t) => t.agents.includes(id));
  if (referencingTeams.length > 0) {
    const names = referencingTeams.map((t) => t.name).join(", ");
    res.status(400).json({ error: `Cannot delete agent: referenced by team(s) ${names}` });
    return;
  }
  deleteAgentDef(id);
  res.json({ ok: true });
}

// ─── Team Defs CRUD ──────────────────────────────────────

export function getTeams(_req: Request, res: Response): void {
  try {
    res.json(listTeamDefs());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

const teamDefBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  agents: z.array(z.string()).min(1),
  coordinatorPrompt: z.string().max(5000).optional(),
});

export function postTeams(req: Request, res: Response): void {
  try {
    const parsed = teamDefBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    // Validate all agent IDs exist
    for (const agentId of parsed.data.agents) {
      if (!getAgentDef(agentId)) {
        res.status(400).json({ error: `Agent '${agentId}' not found` });
        return;
      }
    }
    const def = createTeamDef(parsed.data);
    res.status(201).json(def);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getTeamById(req: Request, res: Response): void {
  const id = req.params.id as string;
  const def = getTeamDef(id);
  if (!def) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  res.json(def);
}

export function putTeamById(req: Request, res: Response): void {
  const id = req.params.id as string;
  const existing = getTeamDef(id);
  if (!existing) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  if (existing.builtIn) {
    res.status(403).json({ error: "Cannot edit built-in team" });
    return;
  }
  const parsed = teamDefBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  // Validate agent IDs if provided
  if (parsed.data.agents) {
    for (const agentId of parsed.data.agents) {
      if (!getAgentDef(agentId)) {
        res.status(400).json({ error: `Agent '${agentId}' not found` });
        return;
      }
    }
  }
  const updated = updateTeamDef(id, parsed.data);
  if (!updated) {
    res.status(500).json({ error: "Update failed" });
    return;
  }
  res.json(updated);
}

export function deleteTeamById(req: Request, res: Response): void {
  const id = req.params.id as string;
  const existing = getTeamDef(id);
  if (!existing) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  if (existing.builtIn) {
    res.status(403).json({ error: "Cannot delete built-in team" });
    return;
  }
  deleteTeamDef(id);
  res.json({ ok: true });
}

// ─── Share ──────────────────────────────────────────────

export function postShare(req: Request, res: Response): void {
  const id = convId(req);
  const meta = getConversation(id);
  if (!meta) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const { messageIndex } = req.body as { messageIndex?: number };
  if (typeof messageIndex !== "number" || messageIndex < 0) {
    res.status(400).json({ error: "Invalid messageIndex" });
    return;
  }
  const messages = getMessages(id);
  if (messageIndex >= messages.length) {
    res.status(400).json({ error: "messageIndex out of range" });
    return;
  }
  const msg = messages[messageIndex];
  const record = createShareRecord(id, meta.title, messageIndex, {
    type: msg.type,
    content: msg.content,
    modelId: msg.modelId,
    reasoningContent: msg.reasoningContent,
  });
  res.json(record);
}

export function getSharedContent(req: Request, res: Response): void {
  const shareId = Array.isArray(req.params.shareId) ? req.params.shareId[0] ?? "" : req.params.shareId;
  if (!shareId) {
    res.status(400).json({ error: "Missing shareId" });
    return;
  }
  const record = getShareRecord(shareId);
  if (!record) {
    res.status(404).json({ error: "Share not found" });
    return;
  }
  res.json(record);
}
