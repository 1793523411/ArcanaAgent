/**
 * 格式化 token 数量：≥1000 时用 k 为单位，保留一位小数
 */
export function formatTokenCount(n: number): string {
  if (typeof n !== "number" || n < 0) return "0";
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
}

/**
 * 格式化耗时（毫秒 → 可读字符串）
 * < 60s → "12s"，>= 60s → "2m30s"，>= 3600s → "1h2m3s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 0) return "0s";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}
