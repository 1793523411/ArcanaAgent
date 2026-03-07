import { getModelContextWindow } from "../config/models.js";
import {
  getMessages,
  getConversation,
  getConversationSummary,
  saveConversationSummary,
  saveContextSnapshot,
  type StoredMessage,
} from "../storage/index.js";
import type { ContextSnapshotMeta } from "../storage/index.js";
import { estimateContextTokens } from "../lib/tokenizer.js";
import { summarizeMessages } from "./summarizer.js";

const DEFAULT_TRIM_TO_LAST = 20;
const DEFAULT_TOKEN_THRESHOLD_PERCENT = 75;
const DEFAULT_COMPRESS_KEEP_RECENT = 20;

export interface BuildContextResult {
  messages: StoredMessage[];
  meta: Omit<ContextSnapshotMeta, "contextMessageCount" | "generatedAt">;
}

export async function buildContextForAgent(
  id: string,
  modelId?: string,
  currentHumanMsg?: StoredMessage
): Promise<BuildContextResult> {
  const all = getMessages(id);
  const convMeta = getConversation(id);
  const contextWindow = getModelContextWindow(modelId);
  const tokenThresholdPercent = convMeta?.context?.tokenThresholdPercent ?? DEFAULT_TOKEN_THRESHOLD_PERCENT;
  const threshold = Math.floor(contextWindow * (tokenThresholdPercent / 100));

  const fullContext = currentHumanMsg ? [...all, currentHumanMsg] : all;
  const estimatedFull = estimateContextTokens(fullContext);

  if (estimatedFull <= threshold) {
    return {
      messages: all,
      meta: { strategy: "full", totalMessages: all.length, estimatedTokens: estimatedFull, tokenThresholdPercent },
    };
  }

  const system: StoredMessage[] = [];
  const rest: StoredMessage[] = [];
  for (const m of all) {
    if (m.type === "system") system.push(m);
    else rest.push(m);
  }

  const strategy = convMeta?.context?.strategy ?? "trim";
  let trimToLast = convMeta?.context?.trimToLast ?? DEFAULT_TRIM_TO_LAST;
  const compressKeepRecent = convMeta?.context?.compressKeepRecent ?? DEFAULT_COMPRESS_KEEP_RECENT;

  const doTrim = (n: number) => {
    const kept = rest.slice(-n);
    const candidate = [...system, ...kept];
    const toEstimate = currentHumanMsg ? [...candidate, currentHumanMsg] : candidate;
    const est = estimateContextTokens(toEstimate);
    return { messages: candidate, estimatedTokens: est, trimToLast: n };
  };

  if (strategy === "trim") {
    while (trimToLast >= 1) {
      const { messages, estimatedTokens, trimToLast: n } = doTrim(trimToLast);
      if (estimatedTokens <= threshold) {
        return {
          messages,
          meta: { strategy: "trim", totalMessages: all.length, estimatedTokens, tokenThresholdPercent, trimToLast: n },
        };
      }
      trimToLast = Math.max(1, Math.floor(trimToLast / 2));
    }
    const { messages, estimatedTokens, trimToLast: n } = doTrim(1);
    return {
      messages,
      meta: { strategy: "trim", totalMessages: all.length, estimatedTokens, tokenThresholdPercent, trimToLast: n },
    };
  }

  const recentCount = Math.min(compressKeepRecent, Math.max(0, rest.length - 1));
  const recent = rest.slice(-recentCount);
  const older = rest.slice(0, -recentCount);

  const buildCompressResult = async () => {
    if (older.length === 0) {
      return [...system, ...recent];
    }
    let summary: string;
    const cached = getConversationSummary(id, older.length);
    if (cached) {
      summary = cached.summary;
    } else {
      summary = await summarizeMessages(older, modelId);
      saveConversationSummary(id, summary, older.length, rest.length);
    }
    const summaryMsg: StoredMessage = {
      type: "system",
      content: `[此前对话摘要]\n${summary}`,
    };
    return [...system, summaryMsg, ...recent];
  };

  const result = await buildCompressResult();
  const toEstimate = currentHumanMsg ? [...result, currentHumanMsg] : result;
  const estimatedTokens = estimateContextTokens(toEstimate);

  if (estimatedTokens <= threshold) {
    return {
      messages: result,
      meta: {
        strategy: "compress",
        totalMessages: all.length,
        estimatedTokens,
        tokenThresholdPercent,
        olderCount: older.length,
        recentCount,
      },
    };
  }

  const { messages: trimResult, estimatedTokens: trimEst, trimToLast: n } = doTrim(trimToLast);
  if (trimEst <= threshold) {
    return {
      messages: trimResult,
      meta: { strategy: "trim", totalMessages: all.length, estimatedTokens: trimEst, tokenThresholdPercent, trimToLast: n },
    };
  }
  let t = trimToLast;
  while (t > 1) {
    t = Math.max(1, Math.floor(t / 2));
    const out = doTrim(t);
    if (out.estimatedTokens <= threshold) {
      return {
        messages: out.messages,
        meta: { strategy: "trim", totalMessages: all.length, estimatedTokens: out.estimatedTokens, tokenThresholdPercent, trimToLast: t },
      };
    }
  }
  const final = doTrim(1);
  return {
    messages: final.messages,
    meta: { strategy: "trim", totalMessages: all.length, estimatedTokens: final.estimatedTokens, tokenThresholdPercent, trimToLast: 1 },
  };
}

export function saveFullContext(
  id: string,
  contextMessages: StoredMessage[],
  currentHumanMsg: StoredMessage,
  meta: Omit<ContextSnapshotMeta, "contextMessageCount" | "generatedAt">
): void {
  const full = [...contextMessages, currentHumanMsg];
  saveContextSnapshot(id, full, {
    ...meta,
    contextMessageCount: full.length,
    generatedAt: new Date().toISOString(),
  });
}
