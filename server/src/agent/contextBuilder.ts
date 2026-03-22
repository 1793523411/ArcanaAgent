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
  currentHumanMsg?: StoredMessage,
  forceCompress?: boolean
): Promise<BuildContextResult> {
  const all = getMessages(id);
  const convMeta = getConversation(id);
  const contextWindow = getModelContextWindow(modelId);
  const tokenThresholdPercent = convMeta?.context?.tokenThresholdPercent ?? DEFAULT_TOKEN_THRESHOLD_PERCENT;
  const threshold = Math.floor(contextWindow * (tokenThresholdPercent / 100));
  const promptOverheadTokens = (() => {
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (m.type !== "ai") continue;
      const prompt = m.contextUsage?.promptTokens;
      const estimated = m.contextUsage?.estimatedTokens;
      if (typeof prompt === "number" && typeof estimated === "number") {
        return Math.max(0, prompt - estimated);
      }
    }
    return 0;
  })();
  const adjustEstimatedTokens = (estimated: number) => estimated + promptOverheadTokens;

  const fullContext = currentHumanMsg ? [...all, currentHumanMsg] : all;
  const estimatedFull = adjustEstimatedTokens(estimateContextTokens(fullContext));

  // 手动压缩时跳过阈值检查
  if (!forceCompress && estimatedFull <= threshold) {
    return {
      messages: all,
      meta: {
        strategy: "full",
        totalMessages: all.length,
        contextWindow,
        thresholdTokens: threshold,
        estimatedTokens: estimatedFull,
        tokenThresholdPercent,
      },
    };
  }

  const system: StoredMessage[] = [];
  const rest: StoredMessage[] = [];
  for (const m of all) {
    if (m.type === "system") system.push(m);
    else rest.push(m);
  }

  // 获取配置的策略，不因为 forceCompress 而改变策略类型
  const strategy = convMeta?.context?.strategy ?? "trim";
  let trimToLast = convMeta?.context?.trimToLast ?? DEFAULT_TRIM_TO_LAST;
  const compressKeepRecent = convMeta?.context?.compressKeepRecent ?? DEFAULT_COMPRESS_KEEP_RECENT;

  const doTrim = (n: number) => {
    const kept = rest.slice(-n);
    const candidate = [...system, ...kept];
    const toEstimate = currentHumanMsg ? [...candidate, currentHumanMsg] : candidate;
    const est = adjustEstimatedTokens(estimateContextTokens(toEstimate));
    return { messages: candidate, estimatedTokens: est, trimToLast: n };
  };

  if (strategy === "trim") {
    // 手动触发时，直接按配置截断，不进行二分查找
    if (forceCompress) {
      const { messages, estimatedTokens, trimToLast: n } = doTrim(trimToLast);
      return {
        messages,
        meta: {
          strategy: "trim",
          totalMessages: all.length,
          contextWindow,
          thresholdTokens: threshold,
          estimatedTokens,
          tokenThresholdPercent,
          trimToLast: n,
        },
      };
    }

    // 自动触发时，二分查找满足阈值的最大保留数
    while (trimToLast >= 1) {
      const { messages, estimatedTokens, trimToLast: n } = doTrim(trimToLast);
      if (estimatedTokens <= threshold) {
        return {
          messages,
          meta: {
            strategy: "trim",
            totalMessages: all.length,
            contextWindow,
            thresholdTokens: threshold,
            estimatedTokens,
            tokenThresholdPercent,
            trimToLast: n,
          },
        };
      }
      trimToLast = Math.max(1, Math.floor(trimToLast / 2));
    }
    const { messages, estimatedTokens, trimToLast: n } = doTrim(1);
    return {
      messages,
      meta: {
        strategy: "trim",
        totalMessages: all.length,
        contextWindow,
        thresholdTokens: threshold,
        estimatedTokens,
        tokenThresholdPercent,
        trimToLast: n,
      },
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
      type: "human",
      content: `[此前对话摘要]\n${summary}`,
    };
    return [...system, summaryMsg, ...recent];
  };

  const result = await buildCompressResult();
  const toEstimate = currentHumanMsg ? [...result, currentHumanMsg] : result;
  const estimatedTokens = adjustEstimatedTokens(estimateContextTokens(toEstimate));

  if (estimatedTokens <= threshold) {
    return {
      messages: result,
      meta: {
        strategy: "compress",
        totalMessages: all.length,
        contextWindow,
        thresholdTokens: threshold,
        estimatedTokens,
        tokenThresholdPercent,
        olderCount: older.length,
        recentCount,
      },
    };
  }

  // 压缩后仍然超过阈值，尝试减少保留的 recent 消息数
  if (recentCount > 10) {
    const reducedRecentCount = Math.max(10, Math.floor(recentCount / 2));
    const reducedRecent = rest.slice(-reducedRecentCount);
    const reducedOlder = rest.slice(0, -reducedRecentCount);
    let reducedSummary: string;
    if (reducedOlder.length === 0) {
      // 没有旧消息可压缩，回退到 trim
    } else {
      const cached = getConversationSummary(id, reducedOlder.length);
      if (cached) {
        reducedSummary = cached.summary;
      } else {
        reducedSummary = await summarizeMessages(reducedOlder, modelId);
        saveConversationSummary(id, reducedSummary, reducedOlder.length, rest.length);
      }
      const reducedSummaryMsg: StoredMessage = {
        type: "human",
        content: `[此前对话摘要]\n${reducedSummary}`,
      };
      const reducedResult = [...system, reducedSummaryMsg, ...reducedRecent];
      const reducedToEstimate = currentHumanMsg ? [...reducedResult, currentHumanMsg] : reducedResult;
      const reducedEstimated = adjustEstimatedTokens(estimateContextTokens(reducedToEstimate));
      if (reducedEstimated <= threshold) {
        return {
          messages: reducedResult,
          meta: {
            strategy: "compress",
            totalMessages: all.length,
            contextWindow,
            thresholdTokens: threshold,
            estimatedTokens: reducedEstimated,
            tokenThresholdPercent,
            olderCount: reducedOlder.length,
            recentCount: reducedRecentCount,
          },
        };
      }
    }
  }

  // 压缩策略失败，回退到 trim 策略
  const { messages: trimResult, estimatedTokens: trimEst, trimToLast: n } = doTrim(trimToLast);
  if (trimEst <= threshold) {
    return {
      messages: trimResult,
      meta: {
        strategy: "trim",
        totalMessages: all.length,
        contextWindow,
        thresholdTokens: threshold,
        estimatedTokens: trimEst,
        tokenThresholdPercent,
        trimToLast: n,
      },
    };
  }
  let t = trimToLast;
  while (t > 1) {
    t = Math.max(1, Math.floor(t / 2));
    const out = doTrim(t);
    if (out.estimatedTokens <= threshold) {
      return {
        messages: out.messages,
        meta: {
          strategy: "trim",
          totalMessages: all.length,
          contextWindow,
          thresholdTokens: threshold,
          estimatedTokens: out.estimatedTokens,
          tokenThresholdPercent,
          trimToLast: t,
        },
      };
    }
  }
  const final = doTrim(1);
  return {
    messages: final.messages,
    meta: {
      strategy: "trim",
      totalMessages: all.length,
      contextWindow,
      thresholdTokens: threshold,
      estimatedTokens: final.estimatedTokens,
      tokenThresholdPercent,
      trimToLast: 1,
    },
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
