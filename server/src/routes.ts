import { Request, Response } from "express";
import { HumanMessage } from "@langchain/core/messages";
import {
  listConversations,
  createConversation,
  getConversation,
  getMessages,
  getMessagesForContext,
  appendMessages,
  deleteConversation,
  type StoredMessage,
} from "./storage.js";
import { storedToLangChain, langChainToStored, getTextContent } from "./messages.js";
import type { BaseMessage } from "@langchain/core/messages";

function serializeStreamChunk(chunk: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(chunk)) {
    if (val && typeof val === "object" && "messages" in val && Array.isArray((val as { messages: BaseMessage[] }).messages)) {
      const ms = (val as { messages: BaseMessage[] }).messages;
      out[key] = {
        messages: ms.map((m) => ({
          type: m._getType(),
          content: typeof (m as { content?: string }).content === "string" ? (m as { content: string }).content : "",
        })),
      };
    } else {
      out[key] = val;
    }
  }
  return out;
}
import { runAgent, streamAgentWithTokens } from "./agent.js";
import { loadUserConfig, saveUserConfig, type UserConfig } from "./userConfig.js";
import { listSkillIds } from "./skills.js";
import { listModels } from "./config.js";

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
    const { id, meta } = createConversation();
    res.status(201).json(meta);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

function convId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] ?? "" : id;
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
  const contextMessages = getMessagesForContext(id);
  const lcMessages = contextMessages.map(storedToLangChain);
  lcMessages.push(new HumanMessage({ content: humanContent }));

  const displayText = text || "[图片]";
  const existingMessages = getMessages(id);
  const isFirstMessage = existingMessages.length === 0;
  const newTitle = isFirstMessage && displayText ? (displayText.slice(0, 24).trim() || "新对话") : undefined;
  appendMessages(id, [{ type: "human", content: displayText }], newTitle);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const flush = (res as unknown as { flush?: () => void }).flush?.bind(res);
  const write = (data: string) => {
    res.write(data);
    flush?.();
  };

  write("data: " + JSON.stringify({ type: "status", status: "thinking" }) + "\n\n");

  const onToken = (token: string) => {
    if (token) write("data: " + JSON.stringify({ type: "token", content: token }) + "\n\n");
  };

  const collectedStored: StoredMessage[] = [];
  try {
    for await (const chunk of streamAgentWithTokens(lcMessages, config.enabledSkillIds, onToken, config.modelId)) {
      const serializable = serializeStreamChunk(chunk);
      const payload = JSON.stringify(serializable);
      write(`data: ${payload}\n\n`);
      const part = chunk && typeof chunk === "object" ? (chunk as Record<string, { messages?: BaseMessage[] }>)[Object.keys(chunk as object)[0]] : undefined;
      if (part?.messages?.length) {
        for (const msg of part.messages) {
          collectedStored.push(langChainToStored(msg));
        }
      }
    }
    if (collectedStored.length > 0) {
      appendMessages(id, collectedStored);
    }
    write("data: [DONE]\n\n");
  } catch (e) {
    write("data: " + JSON.stringify({ error: String(e) }) + "\n\n");
  } finally {
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
  const contextMessages = getMessagesForContext(id);
  const lcMessages = contextMessages.map(storedToLangChain);
  lcMessages.push(new HumanMessage(text));

  const existingMessagesSync = getMessages(id);
  const isFirstMessageSync = existingMessagesSync.length === 0;
  const newTitleSync = isFirstMessageSync && text ? (text.slice(0, 24).trim() || "新对话") : undefined;
  appendMessages(id, [{ type: "human", content: text }], newTitleSync);

  try {
    const resultMessages = await runAgent(lcMessages, config.enabledSkillIds);
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
  const body = req.body as { message?: string; skillIds?: string[] };
  const text = typeof body?.message === "string" ? body.message.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Missing or empty message" });
    return;
  }
  const skillIds = Array.isArray(body.skillIds) ? body.skillIds : undefined;
  const messages = [new HumanMessage(text)];
  try {
    const resultMessages = await runAgent(messages, skillIds);
    const lastAi = resultMessages.filter((m) => m._getType() === "ai").pop();
    const reply = lastAi ? getTextContent(lastAi) : "";
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getConfig(_req: Request, res: Response): void {
  const config = loadUserConfig();
  const skillIds = listSkillIds();
  const models = listModels();
  res.json({ ...config, availableSkillIds: skillIds, availableModels: models });
}

export function getModels(_req: Request, res: Response): void {
  try {
    res.json(listModels());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function putConfig(req: Request, res: Response): void {
  const body = req.body as { enabledSkillIds?: string[]; mcpServers?: UserConfig["mcpServers"]; modelId?: string };
  const config = loadUserConfig();
  if (Array.isArray(body.enabledSkillIds)) config.enabledSkillIds = body.enabledSkillIds;
  if (Array.isArray(body.mcpServers)) config.mcpServers = body.mcpServers;
  if (typeof body.modelId === "string") config.modelId = body.modelId;
  saveUserConfig(config);
  res.json(config);
}
