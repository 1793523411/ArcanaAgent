import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const SHARES_DIR = join(DATA_DIR, "shares");

export interface ShareRecord {
  shareId: string;
  conversationId: string;
  conversationTitle: string;
  messageIndex: number;
  message: {
    type: string;
    content: string;
    modelId?: string;
    reasoningContent?: string;
  };
  createdAt: string;
}

function ensureDir() {
  if (!existsSync(SHARES_DIR)) {
    mkdirSync(SHARES_DIR, { recursive: true });
  }
}

export function createShare(
  conversationId: string,
  conversationTitle: string,
  messageIndex: number,
  message: ShareRecord["message"]
): ShareRecord {
  ensureDir();
  const shareId = randomUUID().replace(/-/g, "").slice(0, 12);
  const record: ShareRecord = {
    shareId,
    conversationId,
    conversationTitle,
    messageIndex,
    message,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(SHARES_DIR, `${shareId}.json`), JSON.stringify(record, null, 2), "utf-8");
  return record;
}

export function getShare(shareId: string): ShareRecord | null {
  const filePath = join(SHARES_DIR, `${shareId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
