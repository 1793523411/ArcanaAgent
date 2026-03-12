/**
 * 格式化 token 数量：≥1000 时用 k 为单位，保留一位小数
 */
export function formatTokenCount(n: number): string {
  if (typeof n !== "number" || n < 0) return "0";
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
}
