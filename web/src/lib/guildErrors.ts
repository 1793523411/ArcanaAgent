/**
 * Map raw fetch/LLM exceptions to user-actionable Chinese messages.
 *
 * Error surfaces we cover:
 *   - AbortError            — user cancelled
 *   - Failed to fetch       — network down / server offline
 *   - SyntaxError / JSON    — server returned non-JSON (often a proxy error page)
 *   - 499 / timeout         — request exceeded the server's hard timeout
 *   - 500                   — generic server error (real cause is in server log)
 *
 * Consumers should NEVER display `String(e)` directly in user-facing UI —
 * the raw messages leak stack traces and SDK internals that the user can't act on.
 */
export function friendlyError(e: unknown): string {
  const msg = String(e);
  if (msg.includes("AbortError") || msg.includes("aborted")) return "已取消";
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) return "网络连接失败，请检查后重试";
  if (msg.includes("SyntaxError") || msg.includes("JSON")) return "服务器返回无效响应，请重试";
  if (msg.includes("499") || msg.includes("已取消") || msg.includes("timeout")) return "请求超时，请稍后重试";
  if (msg.includes("500")) return "服务端错误，请稍后重试";
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}
