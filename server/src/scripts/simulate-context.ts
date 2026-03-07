/**
 * 模拟上下文构建流程，不调用 LLM，仅展示 token 估算与策略决策。
 * 运行: npm run sim:context
 */
import type { StoredMessage } from "../storage/index.js";
import { estimateContextTokens } from "../lib/tokenizer.js";

const CONTEXT_WINDOW = 200_000;
const TOKEN_THRESHOLD_PERCENT = 75;
const TRIM_TO_LAST = 20;
const COMPRESS_KEEP_RECENT = 20;

function mockMessages(count: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 0; i < count; i++) {
    const len = 50 + Math.floor(Math.random() * 200);
    const content = "用户消息内容。".repeat(Math.ceil(len / 6)).slice(0, len);
    out.push({ type: "human", content });
    out.push({ type: "ai", content: "助手回复内容。".repeat(Math.ceil(len / 6)).slice(0, len * 2) });
  }
  return out;
}

function simulate(
  all: StoredMessage[],
  currentMsg: StoredMessage,
  strategy: "trim" | "compress"
): { messages: StoredMessage[]; estimatedTokens: number; meta: string } {
  const threshold = Math.floor(CONTEXT_WINDOW * (TOKEN_THRESHOLD_PERCENT / 100));
  const fullContext = [...all, currentMsg];
  const estimatedFull = estimateContextTokens(fullContext);

  if (estimatedFull <= threshold) {
    return {
      messages: all,
      estimatedTokens: estimatedFull,
      meta: `strategy: full | totalMessages: ${all.length} | estimatedTokens: ${estimatedFull}`,
    };
  }

  const rest = all.filter((m) => m.type !== "system");
  const trimToLast = TRIM_TO_LAST;
  const compressKeepRecent = COMPRESS_KEEP_RECENT;

  if (strategy === "trim") {
    let n = trimToLast;
    while (n >= 1) {
      const kept = rest.slice(-n);
      const candidate = kept;
      const toEstimate = [...candidate, currentMsg];
      const est = estimateContextTokens(toEstimate);
      if (est <= threshold) {
        return {
          messages: candidate,
          estimatedTokens: est,
          meta: `strategy: trim | totalMessages: ${all.length} | trimToLast: ${n} | estimatedTokens: ${est}`,
        };
      }
      n = Math.max(1, Math.floor(n / 2));
    }
    const kept = rest.slice(-1);
    const est = estimateContextTokens([...kept, currentMsg]);
    return {
      messages: kept,
      estimatedTokens: est,
      meta: `strategy: trim | totalMessages: ${all.length} | trimToLast: 1 | estimatedTokens: ${est}`,
    };
  }

  const recentCount = Math.min(compressKeepRecent, Math.max(0, rest.length - 1));
  const recent = rest.slice(-recentCount);
  const older = rest.slice(0, -recentCount);

  const fakeSummary = "[模拟摘要] 此处为占位，未调用 LLM。约 150 字摘要。";
  const summaryMsg: StoredMessage = { type: "system", content: `[此前对话摘要]\n${fakeSummary}` };
  const result = [summaryMsg, ...recent];
  const toEstimate = [...result, currentMsg];
  const est = estimateContextTokens(toEstimate);

  if (est <= threshold) {
    return {
      messages: result,
      estimatedTokens: est,
      meta: `strategy: compress | totalMessages: ${all.length} | olderCount: ${older.length} | recentCount: ${recentCount} | estimatedTokens: ${est}`,
    };
  }

  let t = trimToLast;
  while (t > 1) {
    t = Math.max(1, Math.floor(t / 2));
    const kept = rest.slice(-t);
    const trimEst = estimateContextTokens([...kept, currentMsg]);
    if (trimEst <= threshold) {
      return {
        messages: kept,
        estimatedTokens: trimEst,
        meta: `strategy: trim (fallback) | totalMessages: ${all.length} | trimToLast: ${t} | estimatedTokens: ${trimEst}`,
      };
    }
  }
  const kept = rest.slice(-1);
  const fallbackEst = estimateContextTokens([...kept, currentMsg]);
  return {
    messages: kept,
    estimatedTokens: fallbackEst,
    meta: `strategy: trim (fallback) | totalMessages: ${all.length} | trimToLast: 1 | estimatedTokens: ${fallbackEst}`,
  };
}

function main() {
  const totalPairs = 1200;
  const all = mockMessages(totalPairs);
  const currentMsg: StoredMessage = { type: "human", content: "这是当前用户消息。" };
  const threshold = Math.floor(CONTEXT_WINDOW * (TOKEN_THRESHOLD_PERCENT / 100));

  const fullEst = estimateContextTokens([...all, currentMsg]);
  console.log("=== 上下文构建模拟（不消耗真实 token）===\n");
  console.log(`配置: contextWindow=${CONTEXT_WINDOW}, 阈值=${TOKEN_THRESHOLD_PERCENT}% → ${threshold}`);
  console.log(`模拟消息: ${totalPairs} 对 human+ai，共 ${all.length} 条`);
  console.log(`全量估算: ${fullEst} tokens ${fullEst > threshold ? "(超阈值，需压缩/截断)" : "(未超)"}\n`);

  const trimResult = simulate(all, currentMsg, "trim");
  console.log("--- trim 策略 ---");
  console.log(trimResult.meta);
  console.log(`最终发送: ${trimResult.messages.length} 条\n`);

  const compressResult = simulate(all, currentMsg, "compress");
  console.log("--- compress 策略 ---");
  console.log(compressResult.meta);
  console.log(`最终发送: ${compressResult.messages.length} 条（含 [此前对话摘要]）`);
  console.log("\n✓ 模拟完成，未调用 LLM。");
}

main();
