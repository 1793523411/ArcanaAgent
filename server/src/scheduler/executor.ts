/**
 * 定时任务执行器
 */

import { HumanMessage } from "@langchain/core/messages";
import axios from "axios";
import type {
  ScheduledTask,
  TaskConfigConversation,
  TaskConfigWebhook,
  TaskConfigSystem,
  TaskConfigSkill,
} from "./types.js";
import { join } from "path";
import { existsSync, mkdirSync, readdirSync } from "fs";
import AdmZip from "adm-zip";
import { runAgent } from "../agent/index.js";
import {
  getMessages,
  createConversation,
  appendMessages,
  setConversationTitle,
  listConversations,
  cleanupOldConversations,
  getDataDir,
} from "../storage/index.js";
import { storedToLangChain, langChainToStored, sanitizeMessageSequence } from "../lib/messages.js";
import { cleanupOldHistory } from "./storage.js";
import { serverLogger } from "../lib/logger.js";

/**
 * 执行任务并返回结果
 */
export async function executeTask(task: ScheduledTask): Promise<{ output: string; conversationId?: string }> {
  serverLogger.info(`Executing scheduled task: ${task.name} (${task.type})`, {
    taskId: task.id,
    type: task.type,
  });

  switch (task.type) {
    case "conversation":
      return await executeConversationTask(task.config as TaskConfigConversation);
    case "webhook":
      return await executeWebhookTask(task.config as TaskConfigWebhook);
    case "system":
      return await executeSystemTask(task.config as TaskConfigSystem);
    case "skill":
      return await executeSkillTask(task.config as TaskConfigSkill);
    default:
      throw new Error(`Unknown task type: ${task.type}`);
  }
}

// ─── 对话任务 ─────────────────────────────────────────────

async function executeConversationTask(config: TaskConfigConversation): Promise<{ output: string; conversationId: string }> {
  const { message, _preCreatedConversationId } = config;

  // 优先使用预创建的对话ID
  let conversationId: string;

  if (_preCreatedConversationId) {
    conversationId = _preCreatedConversationId;
    serverLogger.info(`Using pre-created conversation for task: ${conversationId}`);
  } else {
    // 尝试查找最近创建的匹配对话
    conversationId = findRecentConversationWithMessage(message) || "";

    if (!conversationId) {
      // 创建新对话
      const { id } = createConversation();
      conversationId = id;
      setConversationTitle(conversationId, `定时任务：${message.slice(0, 30)}`);
      serverLogger.info(`Created new conversation for scheduled task: ${conversationId}`);
    } else {
      serverLogger.info(`Found existing conversation for scheduled task: ${conversationId}`);
    }
  }

  // 获取对话历史
  const storedMessages = getMessages(conversationId);
  const lcMessages = sanitizeMessageSequence(storedMessages).map((m) => storedToLangChain(m, conversationId));

  // 如果对话中还没有这条消息，添加它
  if (lcMessages.length === 0 || String(lcMessages[lcMessages.length - 1]?.content) !== message) {
    lcMessages.push(new HumanMessage(message));
  }

  // 执行 Agent
  const result = await runAgent(lcMessages);

  serverLogger.info(`Agent execution completed, result has ${result.length} messages (stored: ${storedMessages.length})`);

  // 保存新增消息到会话
  // 如果预创建时已经保存了human消息，result会包含human+AI
  // 我们只保存AI及之后的新消息
  const newMessages = result.slice(storedMessages.length);

  if (newMessages.length === 0) {
    serverLogger.warn(`No new messages to save for conversation ${conversationId}`);
  }

  const storedNewMessages = newMessages.map((m) => langChainToStored(m));
  if (storedNewMessages.length > 0) {
    appendMessages(conversationId, storedNewMessages);
    serverLogger.info(`Conversation task saved ${storedNewMessages.length} messages to ${conversationId}`);
  }

  // 提取最后的 AI 回复
  const lastAi = result.filter((m) => m._getType() === "ai").pop();
  const reply = lastAi ? String(lastAi.content).slice(0, 200) : "无回复";

  return {
    output: `对话任务执行成功，保存了 ${storedNewMessages.length} 条消息，AI 回复: ${reply}`,
    conversationId,
  };
}

// 辅助函数：查找最近创建的包含指定消息的对话
function findRecentConversationWithMessage(message: string): string | undefined {
  try {
    const conversations = listConversations();
    // 按时间倒序，查找最近5分钟内创建的对话
    const recentTime = Date.now() - 5 * 60 * 1000;

    for (const conv of conversations) {
      if (new Date(conv.createdAt).getTime() < recentTime) continue;

      const messages = getMessages(conv.id);
      if (messages.length === 1 &&
          messages[0].type === "human" &&
          messages[0].content === message) {
        return conv.id;
      }
    }
  } catch (error) {
    serverLogger.error("Failed to find recent conversation:", error);
  }
  return undefined;
}

// ─── Webhook 任务（支持飞书）─────────────────────────────

async function executeWebhookTask(config: TaskConfigWebhook): Promise<{ output: string; conversationId?: string }> {
  const { url, method = "POST", headers = {}, body, feishu, useModelOutput, prompt, _preCreatedConversationId } = config;

  let messageContent: string;
  let targetConversationId: string | undefined;

  // 如果使用模型输出
  if (useModelOutput) {
    if (!prompt) {
      throw new Error("使用模型输出时必须提供 prompt");
    }

    // 优先使用预创建的对话ID
    if (_preCreatedConversationId) {
      targetConversationId = _preCreatedConversationId;
      serverLogger.info(`Using pre-created conversation for webhook task: ${targetConversationId}`);
    } else {
      // 尝试查找最近创建的匹配对话
      targetConversationId = findRecentConversationWithMessage(prompt);

      if (!targetConversationId) {
        // 创建新对话
        const { id } = createConversation();
        targetConversationId = id;
        setConversationTitle(id, `定时任务：${prompt.slice(0, 30)}`);
        serverLogger.info(`Created new conversation for webhook task: ${id}`);
      } else {
        serverLogger.info(`Found existing conversation for webhook task: ${targetConversationId}`);
      }
    }

    // 获取对话历史
    const storedMessages = getMessages(targetConversationId);
    const lcMessages = sanitizeMessageSequence(storedMessages).map((m) => storedToLangChain(m, targetConversationId));

    // 如果对话中还没有这条消息，添加它
    if (lcMessages.length === 0 || String(lcMessages[lcMessages.length - 1]?.content) !== prompt) {
      lcMessages.push(new HumanMessage(prompt));
    }

    // 执行 Agent
    const result = await runAgent(lcMessages);

    serverLogger.info(`Webhook task agent execution completed, result has ${result.length} messages (stored: ${storedMessages.length})`);

    // 提取最后的 AI 回复
    const lastAi = result.filter((m) => m._getType() === "ai").pop();
    messageContent = lastAi ? String(lastAi.content) : "无模型输出";

    // 保存新增消息到会话
    const newMessages = result.slice(storedMessages.length);

    if (newMessages.length === 0) {
      serverLogger.warn(`No new messages to save for webhook task conversation ${targetConversationId}`);
    }

    const storedNewMessages = newMessages.map((m) => langChainToStored(m));
    if (storedNewMessages.length > 0) {
      appendMessages(targetConversationId, storedNewMessages);
      serverLogger.info(`Saved ${storedNewMessages.length} messages to conversation ${targetConversationId}`);
    }
  } else {
    // 使用固定内容
    messageContent = "";
  }

  // 飞书群聊机器人专用处理
  if (feishu) {
    const content = useModelOutput ? messageContent : feishu.content;
    const feishuBody = buildFeishuMessage(feishu.msgType, content);
    const response = await axios.post(url, feishuBody, {
      headers: { "Content-Type": "application/json", ...headers },
    });
    const responseSummary = serializeResponseBody(response.data);

    if (response.data?.code !== 0) {
      throw new Error(`飞书 Webhook 失败: ${responseSummary}`);
    }

    return {
      output: useModelOutput
        ? `飞书消息发送成功（会话: ${targetConversationId}，内容: ${messageContent.slice(0, 50)}...），响应: ${responseSummary}`
        : `飞书消息发送成功，响应: ${responseSummary}`,
      conversationId: targetConversationId,
    };
  }

  // 通用 Webhook
  const requestBody = useModelOutput ? { content: messageContent } : body;
  const response = await axios({
    method,
    url,
    headers,
    data: requestBody,
  });

  return {
    output: `Webhook 执行成功，状态码: ${response.status}，响应: ${serializeResponseBody(response.data)}`,
    conversationId: targetConversationId,
  };
}

function serializeResponseBody(data: unknown, maxLength = 300): string {
  const content =
    typeof data === "string"
      ? data
      : (() => {
          try {
            return JSON.stringify(data);
          } catch {
            return String(data);
          }
        })();
  return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content;
}

/**
 * 构建飞书消息体
 */
function buildFeishuMessage(
  msgType: "text" | "interactive",
  content: string | Record<string, unknown>
): Record<string, unknown> {
  if (msgType === "text") {
    return {
      msg_type: "text",
      content: {
        text: typeof content === "string" ? content : JSON.stringify(content),
      },
    };
  }

  if (msgType === "interactive") {
    const normalizedContent = normalizeStructuredContent(content);
    const normalizedCard =
      typeof normalizedContent === "object"
        ? ("card" in normalizedContent
            ? (normalizedContent.card as Record<string, unknown>)
            : normalizedContent)
        : buildDefaultCard(normalizedContent);

    return {
      msg_type: "interactive",
      card: normalizedCard,
    };
  }

  throw new Error(`不支持的飞书消息类型: ${msgType}`);
}

function normalizeStructuredContent(content: string | Record<string, unknown>): string | Record<string, unknown> {
  if (typeof content !== "string") {
    return content;
  }
  const text = content.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return content;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : content;
  } catch {
    return content;
  }
}

function buildDefaultCard(rawText: string): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      title: {
        tag: "plain_text",
        content: "定时任务通知",
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: rawText || "定时任务通知",
        },
      ],
    },
  };
}

// ─── 系统任务 ─────────────────────────────────────────────

async function executeSystemTask(config: TaskConfigSystem): Promise<{ output: string }> {
  const { action, params = {} } = config;

  switch (action) {
    case "cleanup_logs": {
      const daysToKeep = Number(params.daysToKeep) || 30;
      const removed = cleanupOldHistory(daysToKeep);
      return { output: `清理任务历史完成，删除了 ${removed} 条记录` };
    }

    case "cleanup_conversations": {
      const daysToKeep = Number(params.daysToKeep) ?? 9999;
      const removed = cleanupOldConversations(daysToKeep);
      return { output: `对话清理完成，删除了 ${removed} 个超过 ${daysToKeep} 天未更新的对话` };
    }

    case "backup": {
      const dataDir = getDataDir();
      const backupsDir = join(dataDir, "backups");
      if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const zipName = `backup_${ts}.zip`;
      const zipPath = join(backupsDir, zipName);
      const zip = new AdmZip();
      const conversationsDir = join(dataDir, "conversations");
      const schedulerDir = join(dataDir, "scheduler");
      if (existsSync(conversationsDir)) zip.addLocalFolder(conversationsDir, "conversations");
      if (existsSync(schedulerDir)) zip.addLocalFolder(schedulerDir, "scheduler");
      zip.writeZip(zipPath);
      return { output: `备份完成: ${zipPath}` };
    }

    default:
      throw new Error(`Unknown system action: ${action}`);
  }
}

// ─── Skill 任务 ─────────────────────────────────────────────

async function executeSkillTask(config: TaskConfigSkill): Promise<{ output: string; conversationId: string }> {
  const { skillName, params = {}, _preCreatedConversationId } = config;
  const message = `执行 Skill: ${skillName}，参数: ${JSON.stringify(params)}`;

  // 优先使用预创建的对话ID
  let conversationId: string;

  if (_preCreatedConversationId) {
    conversationId = _preCreatedConversationId;
    serverLogger.info(`Using pre-created conversation for skill task: ${conversationId}`);
  } else {
    // 尝试查找最近创建的匹配对话
    conversationId = findRecentConversationWithMessage(message) || "";

    if (!conversationId) {
      // 创建新对话
      const { id } = createConversation();
      conversationId = id;
      setConversationTitle(conversationId, `定时任务：${skillName}`);
      serverLogger.info(`Created new conversation for skill task: ${conversationId}`);
    } else {
      serverLogger.info(`Found existing conversation for skill task: ${conversationId}`);
    }
  }

  // 获取对话历史
  const storedMessages = getMessages(conversationId);
  const lcMessages = sanitizeMessageSequence(storedMessages).map((m) => storedToLangChain(m, conversationId));

  // 如果对话中还没有这条消息，添加它
  if (lcMessages.length === 0 || String(lcMessages[lcMessages.length - 1]?.content) !== message) {
    lcMessages.push(new HumanMessage(message));
  }

  const result = await runAgent(lcMessages);

  serverLogger.info(`Skill task agent execution completed, result has ${result.length} messages (stored: ${storedMessages.length})`);

  // 保存新增消息到会话
  const newMessages = result.slice(storedMessages.length);

  if (newMessages.length === 0) {
    serverLogger.warn(`No new messages to save for skill task conversation ${conversationId}`);
  }

  const storedNewMessages = newMessages.map((m) => langChainToStored(m));
  if (storedNewMessages.length > 0) {
    appendMessages(conversationId, storedNewMessages);
    serverLogger.info(`Skill task saved ${storedNewMessages.length} messages to conversation ${conversationId}`);
  }

  const lastAi = result.filter((m) => m._getType() === "ai").pop();
  const reply = lastAi ? String(lastAi.content).slice(0, 200) : "无回复";

  return {
    output: `Skill 任务执行成功，保存了 ${storedNewMessages.length} 条消息: ${reply}`,
    conversationId,
  };
}
