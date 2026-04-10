import type { LoopDetectionResult } from "./types.js";

interface ToolRecord {
  toolName: string;
  resultHash: number;
  resultSnippet: string;
}

/**
 * 简单字符串哈希（djb2），用于快速比较工具输出
 * 取首尾各 500 字符 + 总长度，降低长输出前缀相同时的碰撞率
 */
function hashString(str: string): number {
  let hash = 5381;
  // 混入字符串长度
  hash = ((hash << 5) + hash + str.length) | 0;
  // 首部 500 字符
  const headLen = Math.min(str.length, 500);
  for (let i = 0; i < headLen; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  // 尾部 500 字符（与首部不重叠时）
  const tailStart = Math.max(headLen, str.length - 500);
  for (let i = tailStart; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * 提取字符串的 character trigrams 集合
 */
function trigrams(str: string): Set<string> {
  const s = str.slice(0, 500).toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) {
    set.add(s.slice(i, i + 3));
  }
  return set;
}

/**
 * 计算两个集合的 Jaccard 相似度
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 循环检测器 — 纯算法，零 LLM 调用
 *
 * 检测两种模式：
 * 1. 精确循环：工具名 + 输出哈希完全重复（A→B→A→B 或 A→A→A）
 * 2. 语义停滞：最近 N 次输出的 trigram Jaccard 相似度超阈值
 */
export class LoopDetector {
  private readonly windowSize: number;
  private readonly similarityThreshold: number;
  private readonly window: ToolRecord[] = [];

  constructor(config: { windowSize: number; similarityThreshold: number }) {
    this.windowSize = config.windowSize;
    this.similarityThreshold = config.similarityThreshold;
  }

  /**
   * 记录一次工具调用
   */
  record(toolName: string, result: string): void {
    this.window.push({
      toolName,
      resultHash: hashString(result),
      resultSnippet: result.slice(0, 500),
    });
    if (this.window.length > this.windowSize * 2) {
      this.window.splice(0, this.window.length - this.windowSize * 2);
    }
  }

  /**
   * 检测是否存在循环
   */
  detect(): LoopDetectionResult {
    if (this.window.length < 3) {
      return { detected: false };
    }

    // 1. 精确循环检测：检查最近 windowSize 条记录是否存在重复模式
    const exactResult = this.detectExactCycle();
    if (exactResult.detected) return exactResult;

    // 2. 语义停滞检测
    const stallResult = this.detectSemanticStall();
    if (stallResult.detected) return stallResult;

    return { detected: false };
  }

  reset(): void {
    this.window.length = 0;
  }

  /**
   * 精确循环检测：
   * - 连续 3+ 次相同 toolName + resultHash → A→A→A
   * - 交替模式 A→B→A→B（最近 4 条形成 2 周期）
   */
  private detectExactCycle(): LoopDetectionResult {
    const recent = this.window.slice(-this.windowSize);
    const snapshot = recent.map((r) => `${r.toolName}(${r.resultSnippet.slice(0, 60)})`);

    // 检测连续重复：最近 3 条 toolName + hash 完全相同
    if (recent.length >= 3) {
      const last3 = recent.slice(-3);
      const allSame = last3.every(
        (r) => r.toolName === last3[0].toolName && r.resultHash === last3[0].resultHash
      );
      if (allSame) {
        return {
          detected: true,
          type: "exact_cycle",
          description: `工具 "${last3[0].toolName}" 连续 3 次返回相同结果`,
          windowSnapshot: snapshot,
        };
      }
    }

    // 检测交替模式 A→B→A→B
    if (recent.length >= 4) {
      const last4 = recent.slice(-4);
      const isAlternating =
        last4[0].toolName === last4[2].toolName &&
        last4[0].resultHash === last4[2].resultHash &&
        last4[1].toolName === last4[3].toolName &&
        last4[1].resultHash === last4[3].resultHash &&
        last4[0].toolName !== last4[1].toolName;
      if (isAlternating) {
        return {
          detected: true,
          type: "exact_cycle",
          description: `工具 "${last4[0].toolName}" 和 "${last4[1].toolName}" 交替循环`,
          windowSnapshot: snapshot,
        };
      }
    }

    return { detected: false };
  }

  /**
   * 语义停滞检测：最近 windowSize 条工具输出的平均 Jaccard 相似度超阈值
   */
  private detectSemanticStall(): LoopDetectionResult {
    const recent = this.window.slice(-this.windowSize);
    if (recent.length < this.windowSize) {
      return { detected: false };
    }

    const trigramSets = recent.map((r) => trigrams(r.resultSnippet));
    let totalSimilarity = 0;
    let pairCount = 0;

    for (let i = 0; i < trigramSets.length; i++) {
      for (let j = i + 1; j < trigramSets.length; j++) {
        totalSimilarity += jaccardSimilarity(trigramSets[i], trigramSets[j]);
        pairCount++;
      }
    }

    const avgSimilarity = pairCount > 0 ? totalSimilarity / pairCount : 0;

    if (avgSimilarity >= this.similarityThreshold) {
      return {
        detected: true,
        type: "semantic_stall",
        description: `最近 ${recent.length} 次工具输出高度相似（平均相似度 ${(avgSimilarity * 100).toFixed(0)}%）`,
        windowSnapshot: recent.map((r) => `${r.toolName}(${r.resultSnippet.slice(0, 60)})`),
      };
    }

    return { detected: false };
  }
}
