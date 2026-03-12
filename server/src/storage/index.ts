import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, openSync, fsyncSync, closeSync, rmSync } from "fs";
import { join, resolve } from "path";
import type { ContextStrategyConfig } from "../config/userConfig.js";
import { closeConversationLogger } from "../lib/logger.js";

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

export interface ToolLog {
  name: string;
  input: string;
  output: string;
}

export interface PlanLog {
  phase: "created" | "running" | "completed";
  steps: Array<{
    title: string;
    acceptance_checks: string[];
    evidences: string[];
    completed: boolean;
  }>;
  currentStep: number;
  toolName?: string;
}

export interface StoredMessage {
  type: "human" | "ai" | "system";
  content: string;
  /** 产出该条 AI 回复的模型 ID */
  modelId?: string;
  /** 推理/思考过程（仅 ai，支持思考的模型） */
  reasoningContent?: string;
  tool_calls?: Array<{ name: string; args: string }>;
  tool_call_id?: string;
  /** 工具执行日志（name + 输入 + 输出），持久化展示用 */
  toolLogs?: ToolLog[];
  /** 执行计划（仅 ai），用于会话结束后回看 */
  plan?: PlanLog;
  attachments?: StoredAttachment[];
  /** 本轮对话 token 消耗（仅 ai，由 API 或估算得到） */
  usageTokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
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
const WORKSPACE_DIR_NAME = "workspace";
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
  const base = resolve(conversationDir(convId));
  const normalized = resolve(base, fileRef);
  if (!(normalized === base || normalized.startsWith(`${base}/`))) return null;
  if (normalized === base) return null;
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

export function createConversation(
  snapshotContext?: ContextStrategyConfig,
  initialTitle?: string
): { id: string; meta: ConversationMeta } {
  ensureDir(CONVERSATIONS_DIR);
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const dir = conversationDir(id);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: ConversationMeta = {
    id,
    title: initialTitle?.trim() || "新对话",
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
  closeConversationLogger(id); // 清理日志器
  rmSync(dir, { recursive: true });
  return true;
}

/** 清理超过指定天数未更新的对话，返回删除数量 */
export function cleanupOldConversations(daysToKeep: number): number {
  const list = listConversations();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);
  let removed = 0;
  for (const meta of list) {
    const updated = new Date(meta.updatedAt);
    if (updated < cutoff) {
      if (deleteConversation(meta.id)) removed++;
    }
  }
  return removed;
}

export function getDataDir(): string {
  return DATA_DIR;
}

// ─── Workspace (artifacts) ─────────────────────────────────

export interface ArtifactMeta {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
}

function workspaceDir(convId: string): string {
  return join(conversationDir(convId), WORKSPACE_DIR_NAME);
}

const RESERVED_CONVERSATION_ENTRIES = new Set([
  ATTACHMENTS_DIR_NAME,
  WORKSPACE_DIR_NAME,
  "messages.json",
  "meta.json",
  "conversation.log",
  CONTEXT_SNAPSHOT_FILE,
  SUMMARY_FILE,
]);

function dedupeWorkspaceName(workspace: string, name: string): string {
  if (!existsSync(join(workspace, name))) return name;
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  let idx = 1;
  while (existsSync(join(workspace, `${base}_${idx}${ext}`))) idx++;
  return `${base}_${idx}${ext}`;
}

function normalizeMirroredWorkspaceTree(convId: string, workspace: string): void {
  const mirrored = join(workspace, "data", "conversations", convId, "workspace");
  if (!existsSync(mirrored)) return;
  const children = readdirSync(mirrored, { withFileTypes: true });
  for (const child of children) {
    const from = join(mirrored, child.name);
    const to = join(workspace, dedupeWorkspaceName(workspace, child.name));
    try {
      renameSync(from, to);
    } catch {
      continue;
    }
  }
  rmSync(join(workspace, "data"), { recursive: true, force: true });
}

function normalizeWorkspaceOutputs(convId: string): void {
  const convRoot = conversationDir(convId);
  if (!existsSync(convRoot)) return;
  const workspace = workspaceDir(convId);
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
  const entries = readdirSync(convRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (RESERVED_CONVERSATION_ENTRIES.has(entry.name)) continue;
    const from = join(convRoot, entry.name);
    const targetName = dedupeWorkspaceName(workspace, entry.name);
    const to = join(workspace, targetName);
    try {
      renameSync(from, to);
    } catch {
      continue;
    }
  }
  normalizeMirroredWorkspaceTree(convId, workspace);
}

export function ensureWorkspace(convId: string): string {
  const dir = workspaceDir(convId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  normalizeWorkspaceOutputs(convId);
  return dir;
}

const MIME_MAP: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
  ".csv": "text/csv", ".html": "text/html", ".htm": "text/html",
  ".js": "text/javascript", ".ts": "text/typescript", ".py": "text/x-python",
  ".sh": "text/x-shellscript", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".xml": "application/xml", ".log": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".mp4": "video/mp4", ".webm": "video/webm",
};

function guessMime(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

import { statSync } from "fs";

export function listArtifacts(convId: string): ArtifactMeta[] {
  normalizeWorkspaceOutputs(convId);
  const dir = workspaceDir(convId);
  if (!existsSync(dir)) return [];
  return scanDir(dir, dir);
}

function scanDir(base: string, current: string): ArtifactMeta[] {
  const result: ArtifactMeta[] = [];
  const entries = readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...scanDir(base, full));
    } else if (entry.isFile()) {
      const rel = full.slice(base.length + 1);
      const stat = statSync(full);
      result.push({
        name: rel,
        path: rel,
        size: stat.size,
        mimeType: guessMime(entry.name),
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
  return result.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function getArtifactAbsolutePath(convId: string, filePath: string): string | null {
  const dir = resolve(workspaceDir(convId));
  const normalized = resolve(dir, filePath);
  if (!(normalized === dir || normalized.startsWith(`${dir}/`))) return null;
  if (normalized === dir) return null;
  if (!existsSync(normalized)) return null;
  return normalized;
}
