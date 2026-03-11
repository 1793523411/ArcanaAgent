import { Request, Response } from "express";
import { HumanMessage } from "@langchain/core/messages";
import {
  listConversations,
  createConversation,
  getConversation,
  getMessages,
  appendMessages,
  deleteConversation,
  saveAttachmentFile,
  getAttachmentAbsolutePath,
  listArtifacts,
  getArtifactAbsolutePath,
  ensureWorkspace,
  getWorkspacePath,
  type StoredMessage,
} from "../storage/index.js";
import { buildContextForAgent, saveFullContext } from "../agent/contextBuilder.js";
import { storedToLangChain, langChainToStored, getTextContent } from "../lib/messages.js";
import type { BaseMessage } from "@langchain/core/messages";
import { runAgent, streamAgentWithTokens } from "../agent/index.js";
import { loadUserConfig, saveUserConfig, type UserConfig, type ContextStrategyConfig, type PromptTemplate } from "../config/userConfig.js";
import { listToolIds } from "../tools/index.js";
import { listModels } from "../config/models.js";
import { listSkills, installSkillFromZip, deleteSkill, getSkillContextForAgent } from "../skills/manager.js";
import { connectToMcpServers, getMcpStatus } from "../mcp/client.js";
import {
  getConversationLogger,
  logConversation,
  logError,
  logLLMCall,
  logToolCall,
  PerformanceTimer,
} from "../lib/logger.js";


function convId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] ?? "" : id;
}

function buildSkillContext(convId: string): string {
  const workspace = ensureWorkspace(convId);
  const existingArtifacts = listArtifacts(convId);
  const artifactListText = existingArtifacts.length > 0
    ? "\n\nFiles currently in workspace:\n" + existingArtifacts.map(a =>
        `- ${a.path} (${a.mimeType}, ${a.size} bytes)`
      ).join("\n") +
      "\n\nYou can read any of these files with the read_file tool using their full path: " + workspace + "/<relative_path>"
    : "";
  return getSkillContextForAgent() +
    `\n\n## Workspace\nThe current conversation workspace directory is: ${workspace}\n` +
    "Save ALL output files (search results, generated files, downloads, etc.) to this workspace directory. " +
    "Use absolute paths when saving. The user can preview files saved here directly in the UI." +
    artifactListText;
}

function estimateTokens(text: string): number {
  const cleaned = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!cleaned) return 0;
  // 简单估算：约 4 个字符 ≈ 1 token
  return Math.ceil(cleaned.length / 4);
}

function estimateTokensForMessages(messages: BaseMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(getTextContent(m)), 0);
}

export function getConversations(_req: Request, res: Response): void {
  try {
    const list = listConversations();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function postConversations(_req: Request, res: Response): void {
  try {
    const body = _req.body as { title?: unknown } | undefined;
    const title = typeof body?.title === "string" ? body.title : undefined;
    const config = loadUserConfig();
    const { id, meta } = createConversation(config.context, title);
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
    attachments?: Array<{ type: string; mimeType?: string; data: string }>;
  };
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
  if (!text && attachments.length === 0) {
    res.status(400).json({ error: "Missing text or attachments" });
    return;
  }

  const textPart = text || (attachments.length ? "请分析图片" : " ");
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

  const config = loadUserConfig();
  const displayText = text || "[图片]";
  const storedAttachments: Array<{ type: "image"; file: string; mimeType?: string }> = [];
  for (const a of attachments) {
    if ((a.type === "image" || !a.type) && typeof a.data === "string") {
      const fileRef = saveAttachmentFile(id, a.mimeType || "image/png", a.data);
      storedAttachments.push({ type: "image", file: fileRef, mimeType: a.mimeType || "image/png" });
    }
  }
  const humanMsg: StoredMessage = {
    type: "human",
    content: displayText,
    ...(storedAttachments.length ? { attachments: storedAttachments } : {}),
  };
  const { messages: contextMessages, meta: contextMeta } = await buildContextForAgent(id, config.modelId, humanMsg);
  const lcMessages = contextMessages.map((m) => storedToLangChain(m, id));
  lcMessages.push(new HumanMessage({ content: humanContent }));

  saveFullContext(id, contextMessages, humanMsg, contextMeta);

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

  const FLUSH_INTERVAL = 30;
  let writeBuf = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushNow = () => {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (writeBuf) {
      res.write(writeBuf);
      writeBuf = "";
    }
  };

  const write = (data: string) => {
    writeBuf += data;
    if (flushTimer === null) {
      flushTimer = setTimeout(flushNow, FLUSH_INTERVAL);
    }
  };

  const writeImmediate = (data: string) => {
    writeBuf += data;
    flushNow();
  };

  writeImmediate("data: " + JSON.stringify({ type: "status", status: "thinking" }) + "\n\n");

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
  const collectedStored: StoredMessage[] = [];
  const pendingToolLogs: Array<{ name: string; input: string; output: string }> = [];
  let streamedContent = "";
  let lastReasoning: string | undefined;
  let llmCallCount = 0;
  let toolCallCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  try {
    for await (const chunk of streamAgentWithTokens(lcMessages, onToken, config.modelId, onReasoningToken, skillContext)) {
      const key = chunk && typeof chunk === "object" ? Object.keys(chunk as object)[0] : "";
      const part = key ? (chunk as Record<string, { messages?: BaseMessage[]; reasoning?: string; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }>)[key] : undefined;
      if (key === "usage" && part && typeof part === "object" && "prompt_tokens" in part) {
        const u = part as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        totalPromptTokens += typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
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
          if (t === "tool") continue;
          const stored = langChainToStored(msg);
          if (stored.type === "ai") {
            if (typeof stored.content === "string" && stored.content.trim()) {
              streamedContent = stored.content;
            }
            if (reasoning) stored.reasoningContent = reasoning;
            if (config.modelId) stored.modelId = config.modelId;
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
    const toStore = collectedStored.filter((m) => {
      if (m.type !== "ai") return true;
      if (m.toolLogs && m.toolLogs.length > 0) return true;
      return typeof m.content === "string" && m.content.trim().length > 0;
    });
    if (toStore.filter((m) => m.type === "ai").length === 0 && (streamedContent.trim() || pendingToolLogs.length > 0)) {
      toStore.push({
        type: "ai",
        content: streamedContent.trim() || "(工具已执行)",
        ...(config.modelId ? { modelId: config.modelId } : {}),
        ...(lastReasoning ? { reasoningContent: lastReasoning } : {}),
        ...(pendingToolLogs.length > 0 ? { toolLogs: pendingToolLogs } : {}),
      });
    }
    const hasRealUsage = totalPromptTokens > 0 || totalCompletionTokens > 0;
    const promptTokens = hasRealUsage ? totalPromptTokens : estimateTokensForMessages(lcMessages);
    const completionTokens = hasRealUsage ? totalCompletionTokens : estimateTokens(streamedContent || "");
    const totalTokens = promptTokens + completionTokens;
    const usagePayload = { promptTokens, completionTokens, totalTokens };
    const lastAi = toStore.filter((m) => m.type === "ai").pop();
    if (lastAi && totalTokens > 0) {
      lastAi.usageTokens = usagePayload;
    }
    if (toStore.length > 0) {
      appendMessages(id, toStore);
    }
    writeImmediate(
      "data: " + JSON.stringify({ type: "usage", ...usagePayload }) + "\n\n",
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
    logError(id, e instanceof Error ? e : String(e), { stage: "stream_agent" });
    res.write("data: " + JSON.stringify({ error: String(e) }) + "\n\n");
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
  const body = req.body as { text?: string };
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Missing or empty text" });
    return;
  }

  const config = loadUserConfig();
  const humanMsg: StoredMessage = { type: "human", content: text };
  const { messages: contextMessages, meta: contextMeta } = await buildContextForAgent(id, config.modelId, humanMsg);
  const lcMessages = contextMessages.map((m) => storedToLangChain(m, id));
  lcMessages.push(new HumanMessage(text));

  saveFullContext(id, contextMessages, humanMsg, contextMeta);

  const existingMessagesSync = getMessages(id);
  const isFirstMessageSync = existingMessagesSync.length === 0;
  const newTitleSync = isFirstMessageSync && text ? (text.slice(0, 24).trim() || "新对话") : undefined;
  appendMessages(id, [{ type: "human", content: text }], newTitleSync);

  const skillContext = buildSkillContext(id);

  try {
    const resultMessages = await runAgent(lcMessages, config.modelId, skillContext);
    const newStored: StoredMessage[] = resultMessages.map((m) => {
      const s = langChainToStored(m);
      if (s.type === "ai" && config.modelId) s.modelId = config.modelId;
      return s;
    });
    appendMessages(id, newStored);
    const lastAi = resultMessages.filter((m) => m._getType() === "ai").pop();
    const reply = lastAi ? getTextContent(lastAi) : "";
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
    const resultMessages = await runAgent(messages, config.modelId);
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
    templates?: PromptTemplate[];
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
  if (Array.isArray(body.templates)) config.templates = body.templates;
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
