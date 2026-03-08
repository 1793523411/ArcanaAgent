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
import { loadUserConfig, saveUserConfig, type UserConfig, type ContextStrategyConfig } from "../config/userConfig.js";
import { listToolIds } from "../tools/index.js";
import { listModels } from "../config/models.js";
import { listSkills, installSkillFromZip, deleteSkill, getSkillContextForAgent } from "../skills/manager.js";
import { connectToMcpServers, getMcpStatus } from "../mcp/client.js";

function serializeStreamChunk(chunk: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(chunk)) {
    if (val && typeof val === "object" && "messages" in val && Array.isArray((val as { messages: BaseMessage[] }).messages)) {
      const v = val as { messages: BaseMessage[]; reasoning?: string };
      const ms = v.messages;
      out[key] = {
        messages: ms.map((m) => ({
          type: m._getType(),
          content: typeof (m as { content?: string }).content === "string" ? (m as { content: string }).content : "",
        })),
        ...(typeof v.reasoning === "string" ? { reasoning: v.reasoning } : {}),
      };
    } else {
      out[key] = val;
    }
  }
  return out;
}

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
    const config = loadUserConfig();
    const { id, meta } = createConversation(config.context);
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
  try {
    for await (const chunk of streamAgentWithTokens(lcMessages, onToken, config.modelId, onReasoningToken, skillContext)) {
      const key = chunk && typeof chunk === "object" ? Object.keys(chunk as object)[0] : "";
      const part = key ? (chunk as Record<string, { messages?: BaseMessage[]; reasoning?: string }>)[key] : undefined;
      if (part?.reasoning) {
        write("data: " + JSON.stringify({ type: "reasoning", content: part.reasoning }) + "\n\n");
        lastReasoning = part.reasoning;
      }
      if (key === "llmCall" && part?.messages?.length) {
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
            const output = typeof toolMsg.content === "string" ? toolMsg.content : "";
            const pending = pendingToolLogs.filter((tl) => tl.name === toolMsg.name && !tl.output);
            if (pending.length > 0) pending[0].output = output;
            writeImmediate("data: " + JSON.stringify({ type: "tool_result", name: toolMsg.name, output }) + "\n\n");
          }
        }
      }
      const serializable = serializeStreamChunk(chunk);
      const payload = JSON.stringify(serializable);
      write(`data: ${payload}\n\n`);
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
        ...(lastReasoning ? { reasoningContent: lastReasoning } : {}),
        ...(pendingToolLogs.length > 0 ? { toolLogs: pendingToolLogs } : {}),
      });
    }
    if (toStore.length > 0) {
      appendMessages(id, toStore);
    }
    flushNow();
    res.write("data: [DONE]\n\n");
  } catch (e) {
    flushNow();
    res.write("data: " + JSON.stringify({ error: String(e) }) + "\n\n");
  } finally {
    if (flushTimer !== null) clearTimeout(flushTimer);
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
    const newStored: StoredMessage[] = resultMessages.map(langChainToStored);
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
  saveUserConfig(config);

  if (Array.isArray(body.mcpServers)) {
    try {
      await connectToMcpServers(config.mcpServers);
    } catch (e) {
      console.error("[MCP] Reconnection failed:", e instanceof Error ? e.message : String(e));
    }
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
