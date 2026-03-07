import type { StoredMessage } from "../storage/index.js";

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const other = len - chinese;
  const chineseTokens = Math.ceil(chinese / 1.5);
  const otherTokens = Math.ceil(other / 4);
  return chineseTokens + otherTokens;
}

const IMAGE_TOKENS_ESTIMATE = 500;

export function estimateMessageTokens(m: StoredMessage): number {
  let t = estimateTextTokens(m.content ?? "");
  const attachments = m.attachments ?? [];
  for (const a of attachments) {
    if (a.type === "image") t += IMAGE_TOKENS_ESTIMATE;
  }
  return t;
}

export function estimateContextTokens(messages: StoredMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}
