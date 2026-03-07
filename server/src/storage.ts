import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, openSync, fsyncSync, closeSync, rmSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const CONVERSATIONS_DIR = join(DATA_DIR, "conversations");

const MAX_MESSAGES_IN_CONTEXT = 30;
const TRIM_TO_LAST = 20;

export interface StoredMessage {
  type: "human" | "ai" | "system";
  content: string;
  tool_calls?: Array<{ name: string; args: string }>;
  tool_call_id?: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

function conversationDir(id: string): string {
  return join(CONVERSATIONS_DIR, id);
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

export function createConversation(): { id: string; meta: ConversationMeta } {
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

export function getMessages(id: string): StoredMessage[] {
  const path = join(CONVERSATIONS_DIR, id, "messages.json");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as StoredMessage[];
}

/** Return messages suitable for context: trim if too many (keep system + recent). */
export function getMessagesForContext(id: string): StoredMessage[] {
  const all = getMessages(id);
  if (all.length <= MAX_MESSAGES_IN_CONTEXT) return all;
  const system: StoredMessage[] = [];
  const rest: StoredMessage[] = [];
  for (const m of all) {
    if (m.type === "system") system.push(m);
    else rest.push(m);
  }
  const kept = rest.slice(-TRIM_TO_LAST);
  return [...system, ...kept];
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
  const updated = [...existing, ...newMessages];
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
