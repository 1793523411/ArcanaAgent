import { BaseMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import { serverLogger } from "../lib/logger.js";

/**
 * Microcompact: 零 LLM 成本的上下文清理
 *
 * 在 pruning 的 token 检查之前执行，基于规则清理已失效的工具结果。
 * 三条规则：
 *   1. 已被后续 write/edit 覆盖的 read_file 结果 → 标记 stale
 *   2. 超过 N 轮前的工具结果 → 只保留前 200 字符
 *   3. 连续失败的同名工具调用 → 折叠为摘要
 */

const DEFAULT_AGE_THRESHOLD_ROUNDS = 6;
const AGED_SUMMARY_LEN = 200;
const CONSECUTIVE_ERROR_THRESHOLD = 3;

interface MicrocompactOptions {
  /** 超过多少轮的工具结果会被压缩（默认 6） */
  ageThresholdRounds?: number;
}

/**
 * 查找每个 ToolMessage 对应的工具名和路径参数。
 * 通过匹配前面最近的 AIMessage 中的 tool_call_id 来关联。
 */
function resolveToolMeta(
  messages: BaseMessage[]
): Map<number, { name: string; path?: string }> {
  const meta = new Map<number, { name: string; path?: string }>();

  // 建立 tool_call_id → { name, path } 映射
  const callMap = new Map<string, { name: string; path?: string }>();
  for (const msg of messages) {
    if (msg._getType() !== "ai") continue;
    const calls = (msg as unknown as { tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const tc of calls) {
      callMap.set(tc.id, {
        name: tc.name,
        path: typeof tc.args?.path === "string" ? tc.args.path : undefined,
      });
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg._getType() !== "tool") continue;
    const toolMsg = msg as ToolMessage;
    const callId = toolMsg.tool_call_id;
    const info = callMap.get(callId);
    if (info) {
      meta.set(i, info);
    } else {
      // 从 ToolMessage.name 回退
      const name = (toolMsg as unknown as { name?: string }).name;
      if (name) meta.set(i, { name });
    }
  }

  return meta;
}

/**
 * 计算每条消息所处的"轮次"。
 * 一个轮次从 Human 消息开始，到下一个 Human 消息之前结束。
 */
function computeRounds(messages: BaseMessage[]): number[] {
  const rounds: number[] = [];
  let currentRound = 0;
  for (const msg of messages) {
    if (msg._getType() === "human") currentRound++;
    rounds.push(currentRound);
  }
  return rounds;
}

/**
 * 对消息列表执行 Microcompact 清理。
 * 返回清理后的新数组（不修改原数组）。
 */
export function applyMicrocompact(
  messages: BaseMessage[],
  options?: MicrocompactOptions
): BaseMessage[] {
  const ageThreshold = options?.ageThresholdRounds ?? DEFAULT_AGE_THRESHOLD_ROUNDS;
  const cloned = [...messages];
  const toolMeta = resolveToolMeta(cloned);
  const rounds = computeRounds(cloned);
  const maxRound = rounds[rounds.length - 1] ?? 0;
  let compactedCount = 0;

  // ── 规则 1: stale read_file 清理 ──
  // 建立 path → 最后写入操作的 index
  const lastWriteIndex = new Map<string, number>();
  for (let i = 0; i < cloned.length; i++) {
    const info = toolMeta.get(i);
    if (!info?.path) continue;
    if (info.name === "write_file" || info.name === "edit_file") {
      lastWriteIndex.set(info.path, i);
    }
  }

  for (let i = 0; i < cloned.length; i++) {
    const info = toolMeta.get(i);
    if (!info?.path || info.name !== "read_file") continue;
    const writeIdx = lastWriteIndex.get(info.path);
    if (writeIdx !== undefined && writeIdx > i) {
      const content = typeof cloned[i].content === "string" ? cloned[i].content as string : "";
      if (content.length > 100) {
        const toolMsg = cloned[i] as ToolMessage;
        cloned[i] = new ToolMessage({
          content: `[file was later modified — content stale]`,
          tool_call_id: toolMsg.tool_call_id,
          name: (toolMsg as unknown as { name?: string }).name,
        });
        compactedCount++;
      }
    }
  }

  // ── 规则 2: 老化工具结果压缩 ──
  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i]._getType() !== "tool") continue;
    const info = toolMeta.get(i);
    // 跳过 task 结果（pruning.ts 有专门的 task 压缩逻辑）
    if (info?.name === "task") continue;

    const msgRound = rounds[i];
    const age = maxRound - msgRound;
    if (age < ageThreshold) continue;

    const content = typeof cloned[i].content === "string" ? cloned[i].content as string : "";
    if (content.length <= AGED_SUMMARY_LEN + 50) continue;

    const toolMsg = cloned[i] as ToolMessage;
    cloned[i] = new ToolMessage({
      content: content.slice(0, AGED_SUMMARY_LEN) + ` ... [microcompact: aged out after ${age} rounds]`,
      tool_call_id: toolMsg.tool_call_id,
      name: (toolMsg as unknown as { name?: string }).name,
    });
    compactedCount++;
  }

  // ── 规则 3: 连续错误折叠 ──
  // 扫描连续同名工具的 [error] 结果，折叠前面的
  let streak: { name: string; startIdx: number; count: number } | null = null;

  const flushStreak = () => {
    if (!streak || streak.count < CONSECUTIVE_ERROR_THRESHOLD) return;
    // 折叠 startIdx 到 startIdx + count - 2（保留最后一次错误）
    const foldCount = streak.count - 1;
    for (let j = streak.startIdx; j < streak.startIdx + foldCount; j++) {
      if (cloned[j]._getType() !== "tool") continue;
      const toolMsg = cloned[j] as ToolMessage;
      cloned[j] = new ToolMessage({
        content: `[${foldCount} previous ${streak.name} errors collapsed]`,
        tool_call_id: toolMsg.tool_call_id,
        name: (toolMsg as unknown as { name?: string }).name,
      });
      compactedCount++;
    }
  };

  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i]._getType() !== "tool") {
      flushStreak();
      streak = null;
      continue;
    }
    const info = toolMeta.get(i);
    const content = typeof cloned[i].content === "string" ? cloned[i].content as string : "";
    const isError = content.startsWith("[error]");

    if (isError && info?.name) {
      if (streak && streak.name === info.name) {
        streak.count++;
      } else {
        flushStreak();
        streak = { name: info.name, startIdx: i, count: 1 };
      }
    } else {
      flushStreak();
      streak = null;
    }
  }
  flushStreak();

  if (compactedCount > 0) {
    serverLogger.info(`[microcompact] Cleaned ${compactedCount} tool results (zero LLM cost)`);
  }

  return cloned;
}
