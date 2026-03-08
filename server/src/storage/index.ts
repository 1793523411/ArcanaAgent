import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, openSync, fsyncSync, closeSync, rmSync } from "fs";
import { join } from "path";
import type { ContextStrategyConfig } from "../config/userConfig.js";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const CONVERSATIONS_DIR = join(DATA_DIR, "conversations");

const DEFAULT_TRIM_TO_LAST = 20;

/** 存盘格式：新消息用 file 引用；旧消息可能含 data(base64) */
export interface StoredAttachment {
  type: "image";
  mimeType?: string;
  data?: string;
  file?: string;
}

export interface StoredMessage {
  type: "human" | "ai" | "system";
  content: string;
  /** 推理/思考过程（仅 ai，支持思考的模型） */
  reasoningContent?: string;
  tool_calls?: Array<{ name: string; args: string }>;
  tool_call_id?: string;
  attachments?: StoredAttachment[];
}

export interface ConversationContextSnapshot {
  strategy: "compress" | "trim";
  trimToLast?: number;
  tokenThresholdPercent?: number;
  compressKeepRecent?: number;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  context?: ConversationContextSnapshot;
}

function conversationDir(id: string): string {
  return join(CONVERSATIONS_DIR, id);
}

const ATTACHMENTS_DIR_NAME = "attachments";
const SUMMARY_FILE = "summary.json";
const CONTEXT_SNAPSHOT_FILE = "context.json";

export interface ContextSnapshotMeta {
  strategy: "full" | "trim" | "compress";
  totalMessages: number;
  contextMessageCount: number;
  generatedAt: string;
  estimatedTokens?: number;
  tokenThresholdPercent?: number;
  trimToLast?: number;
  olderCount?: number;
  recentCount?: number;
}

const SUMMARY_SCHEMA_VERSION = 2;

export interface SummaryRecord {
  summary: string;
  olderCount: number;
  totalRestCount: number;
  generatedAt: string;
  schemaVersion?: number;
}

function attachmentsDir(convId: string): string {
  return join(conversationDir(convId), ATTACHMENTS_DIR_NAME);
}

export function saveAttachmentFile(convId: string, mimeType: string, base64Data: string): string {
  const dir = attachmentsDir(convId);
  ensureDir(dir);
  const ext = mimeType === "image/jpeg" || mimeType === "image/jpg" ? "jpg" : mimeType === "image/gif" ? "gif" : mimeType === "image/webp" ? "webp" : "png";
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${ext}`;
  const filePath = join(dir, name);
  const buf = Buffer.from(base64Data, "base64");
  writeFileSync(filePath, buf);
  return `${ATTACHMENTS_DIR_NAME}/${name}`;
}

export function getAttachmentAbsolutePath(convId: string, fileRef: string): string | null {
  const normalized = join(conversationDir(convId), fileRef);
  const base = join(conversationDir(convId));
  if (!normalized.startsWith(base) || normalized === base) return null;
  if (!existsSync(normalized)) return null;
  return normalized;
}

export function readAttachmentBase64(convId: string, fileRef: string): string | null {
  const abs = getAttachmentAbsolutePath(convId, fileRef);
  if (!abs) return null;
  try {
    return readFileSync(abs, "base64");
  } catch {
    return null;
  }
}

const SUMMARY_CACHE_SLACK = 10;

export function getConversationSummary(
  convId: string,
  olderCount: number,
  slack: number = SUMMARY_CACHE_SLACK
): SummaryRecord | null {
  const path = join(conversationDir(convId), SUMMARY_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const rec = JSON.parse(raw) as SummaryRecord;
    if (typeof rec.summary !== "string") return null;
    if ((rec.schemaVersion ?? 1) !== SUMMARY_SCHEMA_VERSION) return null;
    const diff = Math.abs(rec.olderCount - olderCount);
    if (diff > slack) return null;
    return rec;
  } catch {
    return null;
  }
}

export function saveConversationSummary(
  convId: string,
  summary: string,
  olderCount: number,
  totalRestCount: number
): void {
  const dir = conversationDir(convId);
  const path = join(dir, SUMMARY_FILE);
  const rec: SummaryRecord = {
    summary,
    olderCount,
    totalRestCount,
    generatedAt: new Date().toISOString(),
    schemaVersion: SUMMARY_SCHEMA_VERSION,
  };
  writeFileSync(path, JSON.stringify(rec, null, 2));
}

export function saveContextSnapshot(
  convId: string,
  messages: StoredMessage[],
  meta: ContextSnapshotMeta
): void {
  const dir = conversationDir(convId);
  const path = join(dir, CONTEXT_SNAPSHOT_FILE);
  const rec = { meta, messages };
  writeFileSync(path, JSON.stringify(rec, null, 2));
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function listConversations(): ConversationMeta[] {
  ensureDir(CONVERSATIONS_DIR);
  const ids = readdirSync(CONVERSATIONS_DIR).filter((name) => {
    const metaPath = join(CONVERSATIONS_DIR, name, "meta.json");
    return existsSync(metaPath);
  });
  const list: ConversationMeta[] = [];
  for (const id of ids) {
    try {
      const meta = readFileSync(join(CONVERSATIONS_DIR, id, "meta.json"), "utf-8");
      list.push(JSON.parse(meta) as ConversationMeta);
    } catch {
      // skip invalid
    }
  }
  list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return list;
}

export function createConversation(snapshotContext?: ContextStrategyConfig): { id: string; meta: ConversationMeta } {
  ensureDir(CONVERSATIONS_DIR);
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const dir = conversationDir(id);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: ConversationMeta = {
    id,
    title: "新对话",
    createdAt: now,
    updatedAt: now,
  };
  if (snapshotContext) {
    meta.context = {
      strategy: snapshotContext.strategy,
      trimToLast: snapshotContext.trimToLast,
      tokenThresholdPercent: snapshotContext.tokenThresholdPercent,
      compressKeepRecent: snapshotContext.compressKeepRecent,
    };
  }
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(join(dir, "messages.json"), JSON.stringify([], null, 2));
  return { id, meta };
}

export function getConversation(id: string): ConversationMeta | null {
  const metaPath = join(CONVERSATIONS_DIR, id, "meta.json");
  if (!existsSync(metaPath)) return null;
  const raw = readFileSync(metaPath, "utf-8");
  return JSON.parse(raw) as ConversationMeta;
}

/** 过滤掉不应存在的空 AI 消息（正常流程不会产生） */
function filterEmptyAiMessages(messages: StoredMessage[]): StoredMessage[] {
  return messages.filter((m) => {
    if (m.type !== "ai") return true;
    const c = m.content;
    return typeof c === "string" && c.trim().length > 0;
  });
}

export function getMessages(id: string): StoredMessage[] {
  const path = join(CONVERSATIONS_DIR, id, "messages.json");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const list = JSON.parse(raw) as StoredMessage[];
  return filterEmptyAiMessages(list);
}

/** @deprecated 使用 buildContextForAgent（按 token 阈值触发） */
export function getMessagesForContext(id: string): StoredMessage[] {
  return getMessages(id);
}

export function appendMessages(
  id: string,
  newMessages: StoredMessage[],
  newTitle?: string
): void {
  const dir = conversationDir(id);
  const path = join(dir, "messages.json");
  const tmpPath = join(dir, "messages.json.tmp");
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf-8")) as StoredMessage[])
    : [];
  const filtered = filterEmptyAiMessages(newMessages);
  const updated = [...existing, ...filtered];
  writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
  renameSync(tmpPath, path);
  try {
    const fd = openSync(path, "r");
    fsyncSync(fd);
    closeSync(fd);
  } catch {
    // ignore fsync errors
  }
  const metaPath = join(dir, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as ConversationMeta;
  meta.updatedAt = new Date().toISOString();
  if (newTitle) meta.title = newTitle;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

export function setConversationTitle(id: string, title: string): void {
  const metaPath = join(CONVERSATIONS_DIR, id, "meta.json");
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as ConversationMeta;
  meta.title = title;
  meta.updatedAt = new Date().toISOString();
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

export function deleteConversation(id: string): boolean {
  const dir = conversationDir(id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true });
  return true;
}
